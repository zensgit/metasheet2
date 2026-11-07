'use strict'
/**
 * R-69 1c — the plugin publishes ONE values-free integration.run_finished summary per pipeline run, after
 * finishRun, for api / manual / replay runs only (ADR adr-automation-pipeline-bridge-20261103 §4.2; baseline v2.3
 * §10.2.4 1c row). Synthetic only: in-memory registry, fake adapters, a fake host publish port. R-69 is OPEN.
 *
 *   - 1000 rows over 10 pages ⇒ exactly ONE publish (never per page, never per row);
 *   - triggeredBy automation / cron ⇒ NOTHING (automation-originated runs are the core action layer's);
 *   - a failed run publishes status failed with an error CLASS, never the message;
 *   - the switch is the exact literal 'true'; finishRun failing ⇒ nothing; the run result is byte-identical with
 *     and without the notifier; a publish that throws never changes the run.
 */
const assert = require('node:assert/strict')
const path = require('node:path')

const { createAdapterRegistry, createReadResult, createUpsertResult } = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const { createPipelineRunner } = require(path.join(__dirname, '..', 'lib', 'pipeline-runner.cjs'))
const { createDeadLetterStore } = require(path.join(__dirname, '..', 'lib', 'dead-letter.cjs'))
const { createWatermarkStore } = require(path.join(__dirname, '..', 'lib', 'watermark.cjs'))
const { createRunLogger } = require(path.join(__dirname, '..', 'lib', 'run-log.cjs'))
const {
  createRunFinishedNotifier,
  buildPipelineRunFinishedSummary,
  isRunEventPublishEnabled,
} = require(path.join(__dirname, '..', 'lib', 'integration-run-events.cjs'))

const TENANT = 'tenant_1'
const ON = { INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED: 'true' }
const EVENT_KEYS = ['eventId', 'occurredAt', 'job', 'runId', 'status', 'canApply', 'counts', 'durationMs', 'attempts', 'triggeredBy', 'errorClass', 'reason', '_automationDepth']
// The core closed set's REQUIRED keys (core/integration-run-events.ts): a summary missing one is refused there.
const REQUIRED_EVENT_KEYS = ['eventId', 'occurredAt', 'job', 'status', 'canApply', 'counts', 'durationMs', 'attempts', 'triggeredBy', '_automationDepth']
// I5 ruling on verifier F7: the four run counts plus the five stock-prep decision counts, all required.
const COUNT_KEYS = ['read', 'cleaned', 'written', 'failed', 'add', 'update', 'skip', 'inactive', 'manual_confirm']

function createMockDb() {
  const tables = new Map()
  const rows = (table) => { if (!tables.has(table)) tables.set(table, []); return tables.get(table) }
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => (value === null || value === undefined ? row[key] == null : row[key] === value))
  return {
    tables,
    async selectOne(table, where) { return rows(table).find((row) => matches(row, where)) || null },
    async insertOne(table, row) { rows(table).push({ ...row }); return [row] },
    async updateRow(table, set, where) { const row = rows(table).find((r) => matches(r, where)); if (!row) return []; Object.assign(row, set); return [row] },
    async select(table, options = {}) { return rows(table).filter((row) => matches(row, options.where || {})) },
  }
}

function harness({ totalRows = 3, pageSize = 100, failRead = false, failFinish = false, notifyRunFinished } = {}) {
  const db = createMockDb()
  let nextRun = 1
  const pipeline = {
    id: 'pipe_1', tenantId: TENANT, workspaceId: null, projectId: 'project_1',
    sourceSystemId: 'source_1', sourceObject: 'materials', targetSystemId: 'target_1', targetObject: 'BD_MATERIAL',
    mode: 'full', status: 'active', idempotencyKeyFields: ['code'],
    options: { batchSize: pageSize, maxPages: 50 },
    fieldMappings: [{ sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] }],
  }
  const runs = new Map()
  const pipelineRegistry = {
    async getPipeline() { return pipeline },
    async createPipelineRun(input) {
      const id = `run_${nextRun++}`
      const run = { id, tenantId: input.tenantId, workspaceId: input.workspaceId ?? null, pipelineId: input.pipelineId, mode: input.mode, triggeredBy: input.triggeredBy, status: input.status, details: input.details || {} }
      runs.set(id, run)
      return run
    },
    async updatePipelineRun(input) {
      if (failFinish) throw new Error('db down while finishing')
      const run = { ...runs.get(input.id), status: input.status, rowsRead: input.rowsRead, rowsCleaned: input.rowsCleaned, rowsWritten: input.rowsWritten, rowsFailed: input.rowsFailed, durationMs: input.durationMs, errorSummary: input.errorSummary || null, details: input.details || {} }
      runs.set(input.id, run)
      return run
    },
  }
  const systems = new Map([
    ['source_1', { id: 'source_1', name: 'src', kind: 'mock-source', role: 'source', config: {} }],
    ['target_1', { id: 'target_1', name: 'tgt', kind: 'mock-target', role: 'target', config: {} }],
  ])
  const externalSystemRegistry = {
    async getExternalSystem(input) { return systems.get(input.id) },
    async getExternalSystemForAdapter(input) { return systems.get(input.id) },
  }
  const reads = { pages: 0 }
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('mock-source', () => ({
      async testConnection() { return { ok: true } },
      async listObjects() { return [] },
      async getSchema() { return { fields: [] } },
      async read(input) {
        if (failRead) throw new TypeError('source unreachable at HOST-SENTINEL-R69 with secret SECRET-SENTINEL-R69')
        const offset = input.cursor ? Number(input.cursor) : 0
        reads.pages += 1
        const records = Array.from({ length: Math.max(0, Math.min(pageSize, totalRows - offset)) }, (_, i) => ({ code: `C${offset + i}` }))
        const next = offset + records.length
        return createReadResult({ records, nextCursor: next < totalRows ? String(next) : null })
      },
      async upsert() { throw new Error('source upsert') },
    }))
    .registerAdapter('mock-target', () => ({
      async testConnection() { return { ok: true } },
      async listObjects() { return [] },
      async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: [] }) },
      async upsert(input) { return createUpsertResult({ written: input.records.length, skipped: 0, results: [] }) },
    }))
  const runner = createPipelineRunner({
    pipelineRegistry,
    externalSystemRegistry,
    adapterRegistry,
    deadLetterStore: createDeadLetterStore({ db, idGenerator: () => `dl_${Math.random().toString(36).slice(2)}` }),
    watermarkStore: createWatermarkStore({ db }),
    runLogger: createRunLogger({ pipelineRegistry }),
    clock: (() => { let tick = 0; return () => tick++ * 5 })(),
    ...(notifyRunFinished ? { notifyRunFinished } : {}),
  })
  return { runner, reads }
}

function recordingPort() {
  const published = []
  const publish = async (summary, route) => { published.push({ summary, route }); return { published: true } }
  return { published, publish }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))
const runInput = (triggeredBy, extra = {}) => ({ tenantId: TENANT, workspaceId: null, pipelineId: 'pipe_1', triggeredBy, ...extra })

async function main() {
  // 1. 1000 rows over 10 pages ⇒ exactly ONE publish, after finishRun, values-free, closed key set.
  {
    const port = recordingPort()
    const notify = createRunFinishedNotifier({ publish: port.publish, env: ON })
    let calls = 0
    const { runner, reads } = harness({ totalRows: 1000, pageSize: 100, notifyRunFinished: (input) => { calls += 1; return notify(input) } })
    const result = await runner.runPipeline(runInput('manual'))
    await settle()
    assert.equal(reads.pages, 10, '10 pages were read')
    assert.equal(result.metrics.rowsRead, 1000)
    assert.equal(calls, 1, 'the notifier is called ONCE per run, never per page or per row')
    assert.equal(port.published.length, 1, '1000 rows ⇒ 1 event')
    const { summary, route } = port.published[0]
    assert.deepEqual(route, { tenantId: TENANT })
    assert.deepEqual(Object.keys(summary).filter((key) => !EVENT_KEYS.includes(key)), [], 'closed key set')
    assert.deepEqual(REQUIRED_EVENT_KEYS.filter((key) => !(key in summary)), [], 'every required key is present (canApply included)')
    assert.deepEqual(Object.keys(summary.counts).sort(), [...COUNT_KEYS].sort(), 'counts carry exactly the nine closed keys')
    assert.equal(summary.canApply, false, 'a pipeline run carries canApply false (no stock-prep dry-run apply bit)')
    assert.equal(summary.eventId, result.run.id, 'eventId = the run id (deterministic)')
    assert.equal(summary.runId, result.run.id)
    assert.deepEqual(summary.job, { kind: 'pipeline', pipelineId: 'pipe_1' })
    assert.equal(summary.status, 'succeeded')
    assert.deepEqual(summary.counts, { read: 1000, cleaned: 1000, written: 1000, failed: 0, add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 })
    assert.equal(summary.triggeredBy, 'manual')
    assert.equal(summary._automationDepth, 0)
    assert.equal(summary.attempts, 1)
    assert.equal(JSON.stringify(summary).includes(TENANT), false, 'no tenant id inside the event')
  }

  // 2. api and replay are published; automation and cron are NOT (the core action layer owns automation runs).
  for (const [triggeredBy, expected] of [['api', 1], ['replay', 1], ['automation', 0], ['cron', 0]]) {
    const port = recordingPort()
    const { runner } = harness({ notifyRunFinished: createRunFinishedNotifier({ publish: port.publish, env: ON }) })
    await runner.runPipeline(runInput(triggeredBy))
    await settle()
    assert.equal(port.published.length, expected, `triggeredBy ${triggeredBy} ⇒ ${expected} publish(es)`)
  }

  // 3. a failed run: status failed, an error CLASS — never the message (it carried an address and a secret).
  {
    const port = recordingPort()
    const { runner } = harness({ failRead: true, notifyRunFinished: createRunFinishedNotifier({ publish: port.publish, env: ON }) })
    await assert.rejects(runner.runPipeline(runInput('manual')))
    await settle()
    assert.equal(port.published.length, 1)
    const { summary } = port.published[0]
    assert.equal(summary.status, 'failed')
    assert.equal(summary.canApply, false)
    assert.deepEqual(REQUIRED_EVENT_KEYS.filter((key) => !(key in summary)), [], 'a failed run carries every required key')
    assert.match(summary.errorClass, /^[A-Za-z0-9_:.-]{1,80}$/)
    const text = JSON.stringify(summary)
    for (const needle of ['HOST-SENTINEL-R69', 'SECRET-SENTINEL-R69', 'unreachable', TENANT]) assert.equal(text.includes(needle), false, `${needle} must not leak`)
  }

  // 4. the switch is the exact literal; finishRun failing publishes nothing; a missing port is a no-op.
  for (const value of ['TRUE', ' true', '1', '', undefined]) {
    const port = recordingPort()
    const { runner } = harness({ notifyRunFinished: createRunFinishedNotifier({ publish: port.publish, env: { INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED: value } }) })
    await runner.runPipeline(runInput('manual'))
    await settle()
    assert.equal(port.published.length, 0, `switch ${JSON.stringify(value)} ⇒ nothing`)
  }
  assert.equal(isRunEventPublishEnabled(ON), true)
  {
    const port = recordingPort()
    const { runner } = harness({ failFinish: true, notifyRunFinished: createRunFinishedNotifier({ publish: port.publish, env: ON }) })
    const result = await runner.runPipeline(runInput('manual'))
    await settle()
    assert.equal(result.warning.code, 'FINISH_RUN_FAILED')
    assert.equal(port.published.length, 0, 'no terminal run row ⇒ no summary')
  }
  assert.equal(createRunFinishedNotifier({ publish: null, env: ON })({ runId: 'run_1' }), null)

  // 5. the run result is byte-identical with and without the notifier, and a throwing port changes nothing.
  {
    const plain = await harness().runner.runPipeline(runInput('manual'))
    const throwing = createRunFinishedNotifier({ publish: async () => { throw new Error('host down') }, env: ON })
    const withNotifier = await harness({ notifyRunFinished: throwing }).runner.runPipeline(runInput('manual'))
    await settle()
    assert.equal(JSON.stringify(withNotifier), JSON.stringify(plain))
    const syncThrow = await harness({ notifyRunFinished: () => { throw new Error('sync') } }).runner.runPipeline(runInput('manual'))
    assert.equal(JSON.stringify(syncThrow), JSON.stringify(plain))
  }

  // 6. the builder refuses identifiers outside the bounded shapes (nothing is published rather than leaking).
  const base = { runId: 'run_1', pipelineId: 'pipe_1', tenantId: TENANT, status: 'succeeded', metrics: {}, triggeredBy: 'manual' }
  assert.ok(buildPipelineRunFinishedSummary(base))
  assert.equal(buildPipelineRunFinishedSummary({ ...base, pipelineId: 'https://h/p' }), null)
  assert.equal(buildPipelineRunFinishedSummary({ ...base, status: 'running' }), null)
  assert.equal(buildPipelineRunFinishedSummary({ ...base, triggeredBy: 'automation' }), null)
  assert.equal(buildPipelineRunFinishedSummary({ ...base, status: 'failed', errorClass: 'has spaces in it' }).summary.errorClass, undefined)

  console.log('integration-run-finished-publish: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
