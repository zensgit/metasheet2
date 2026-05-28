'use strict'

// DF-N2-2c — read-route round-trip: prove listProvenanceByRow reads the lineage DF-N2-2b
// actually wrote. We run a real pipeline-runner TWICE on the same row (fail, then succeed)
// to capture 2b's REAL persisted provenance arrays, translate them to view rows in ONE
// helper (the only place migration-060's column shape is mirrored — the SQL unnest itself
// is locked by migration-sql.test.cjs), then read them back through the REAL pipelines.cjs
// registry. Catches projection-drop and field-shape drift between 2b's write and 2c's read.

const assert = require('node:assert/strict')
const path = require('node:path')
const LIB = path.join(__dirname, '..', 'lib')
const { createAdapterRegistry, createReadResult, createUpsertResult } = require(path.join(LIB, 'contracts.cjs'))
const { createPipelineRunner } = require(path.join(LIB, 'pipeline-runner.cjs'))
const { createDeadLetterStore } = require(path.join(LIB, 'dead-letter.cjs'))
const { createWatermarkStore } = require(path.join(LIB, 'watermark.cjs'))
const { createRunLogger } = require(path.join(LIB, 'run-log.cjs'))
const { createPipelineRegistry, __internals } = require(path.join(LIB, 'pipelines.cjs'))
const { PROVENANCE_TIMELINE_ENTRY_FIELDS } = __internals

function createMockDb() {
  const tables = new Map([['integration_dead_letters', []], ['integration_watermarks', []], ['integration_runs', []]])
  const rows = (t) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t) }
  const matches = (row, where) => Object.entries(where || {}).every(([k, v]) =>
    (v === null || v === undefined) ? (row[k] === null || row[k] === undefined) : row[k] === v)
  return {
    tables,
    async selectOne(t, where) { return rows(t).find((r) => matches(r, where)) || null },
    async insertOne(t, row) { const stored = { ...row, created_at: row.created_at || '2026-04-24T00:00:00.000Z' }; rows(t).push(stored); return [stored] },
    async updateRow(t, set, where) { const r = rows(t).find((x) => matches(x, where)); if (!r) return []; Object.assign(r, set); return [r] },
    async select(t, opts = {}) { return rows(t).filter((r) => matches(r, opts.where || {})) },
  }
}

// Capturing registry: stores 2b's persisted provenance array on the run row + returns it.
function createCapturingRegistry(pipeline, db) {
  let n = 0
  const created = []
  return {
    async getPipeline(input) { assert.equal(input.id, pipeline.id); return pipeline },
    async createPipelineRun(input) {
      const id = `run_${++n}`
      const createdAt = `2026-04-24T0${n}:00:00.000Z`
      const row = { id, tenant_id: input.tenantId, workspace_id: input.workspaceId ?? null, pipeline_id: input.pipelineId, mode: input.mode, status: input.status, created_at: createdAt, started_at: input.startedAt || createdAt }
      await db.insertOne('integration_runs', row)
      created.push(row)
      return { id, tenantId: input.tenantId, workspaceId: input.workspaceId ?? null, pipelineId: input.pipelineId, mode: input.mode, status: input.status, startedAt: row.started_at, details: input.details || {} }
    },
    async updatePipelineRun(input) {
      const r = created.find((x) => x.id === input.id)
      if (input.provenanceEvents !== undefined) r.provenance_events = input.provenanceEvents
      r.status = input.status
      r.finished_at = input.finishedAt
      return { id: r.id, tenantId: r.tenant_id, workspaceId: r.workspace_id ?? null, pipelineId: r.pipeline_id, status: r.status, mode: r.mode, createdAt: r.created_at, provenanceEvents: r.provenance_events ?? [] }
    },
    _runs: created,
  }
}

function buildRunner({ targetUpsert }) {
  const db = createMockDb()
  const pipeline = {
    id: 'pipe_1', tenantId: 'tenant_1', workspaceId: null, sourceSystemId: 'source_1', sourceObject: 'materials',
    targetSystemId: 'target_1', targetObject: 'BD_MATERIAL', mode: 'full', status: 'active',
    idempotencyKeyFields: ['code', 'revision'], options: { batchSize: 100 },
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', transform: ['trim', 'upper'], validation: [{ type: 'required' }] },
      { sourceField: 'name', targetField: 'FName', transform: { fn: 'trim' }, validation: [{ type: 'required' }] },
    ],
  }
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('mock-source', () => ({
      async testConnection() { return { ok: true } }, async listObjects() { return [] }, async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: [{ code: 'rt-01', revision: 'r1', name: 'RoundTrip', updatedAt: '2026-04-24T01:00:00.000Z' }], done: true }) },
      async upsert() { throw new Error('source upsert should not be called') },
    }))
    .registerAdapter('mock-target', () => ({
      async testConnection() { return { ok: true } }, async listObjects() { return [] }, async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: [] }) },
      async upsert(input) { return targetUpsert(input) },
    }))
  const registry = createCapturingRegistry(pipeline, db)
  const runner = createPipelineRunner({
    pipelineRegistry: registry,
    externalSystemRegistry: {
      async getExternalSystem(input) { return { id: input.id, kind: input.id === 'source_1' ? 'mock-source' : 'mock-target', role: input.id === 'source_1' ? 'source' : 'target', config: {} } },
      async getExternalSystemForAdapter(input) { return { id: input.id, kind: input.id === 'source_1' ? 'mock-source' : 'mock-target', role: input.id === 'source_1' ? 'source' : 'target', config: {}, credentials: {} } },
    },
    adapterRegistry,
    deadLetterStore: createDeadLetterStore({ db, idGenerator: () => `dl_${db.tables.get('integration_dead_letters').length + 1}` }),
    watermarkStore: createWatermarkStore({ db }),
    runLogger: createRunLogger({ pipelineRegistry: registry }),
    clock: (() => { let t = 0; return () => t++ * 25 })(),
  })
  return { runner }
}

// THE one place migration-060's view column shape is mirrored (SQL unnest locked elsewhere).
function eventsToViewRows(run, events) {
  return (events || []).map((event, i) => ({
    tenant_id: 'tenant_1', workspace_id: null, pipeline_id: run.pipelineId,
    run_id: run.id, run_mode: run.mode, run_status: run.status, run_created_at: run.createdAt,
    run_started_at: run.createdAt, run_finished_at: run.createdAt,
    event_index: i + 1, row_id: event.rowId, event_type: event.eventType, event_at: event.at,
    attrs: event.attrs || {}, event,
  }))
}

function createReadDb(viewRows) {
  const matches = (row, where) => Object.entries(where || {}).every(([k, v]) =>
    (v === null || v === undefined) ? (row[k] === null || row[k] === undefined) : row[k] === v)
  return {
    async selectOne() { return null },
    async insertOne(_t, row) { return [row] },
    async updateRow() { return [] },
    async select(table, opts = {}) {
      assert.equal(table, 'integration_provenance_by_row', 'reads the migration-060 view')
      return viewRows.filter((r) => matches(r, opts.where || {}))
    },
  }
}

async function main() {
  // --- run 2b twice on the SAME row: run_1 fails (with a secret in the error), run_2 succeeds ---
  const failRunner = buildRunner({
    targetUpsert: async (input) => createUpsertResult({ written: 0, failed: 1, errors: [{
      key: input.records[0]._integration_idempotency_key, code: 'TARGET_TEMP',
      message: 'temp fail: postgres://erp:S3cretPass@10.0.0.5/db',
    }] }),
  })
  const run1 = await failRunner.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })
  const succeedRunner = buildRunner({
    targetUpsert: async (input) => createUpsertResult({ written: 1, results: input.records.map((r) => ({ key: r._integration_idempotency_key })) }),
  })
  const run2 = await succeedRunner.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })

  const run1Events = run1.run.provenanceEvents
  const run2Events = run2.run.provenanceEvents
  assert.equal(run1Events.length, 1, '2b wrote one failed event')
  assert.equal(run1Events[0].eventType, 'target_write_failed')
  assert.equal(run2Events.length, 1, '2b wrote one succeeded event')
  const rowId = run1Events[0].rowId
  assert.equal(run2Events[0].rowId, rowId, 'same idempotency key across runs = same rowId')

  // run_2 must sort AFTER run_1 — give it a later created_at than the failRunner's run_1.
  const run1Ctx = { id: 'run_1', pipelineId: 'pipe_1', mode: 'full', status: 'partial', createdAt: '2026-04-24T01:00:00.000Z' }
  const run2Ctx = { id: 'run_2', pipelineId: 'pipe_1', mode: 'full', status: 'succeeded', createdAt: '2026-04-24T02:00:00.000Z' }
  const viewRows = [...eventsToViewRows(run1Ctx, run1Events), ...eventsToViewRows(run2Ctx, run2Events)]

  // --- read back through the REAL registry + REAL db.select on the view ---
  const registry = createPipelineRegistry({ db: createReadDb(viewRows) })
  const timeline = await registry.listProvenanceByRow({ tenantId: 'tenant_1', workspaceId: null, rowId })

  assert.equal(timeline.length, 2, 'cross-run timeline has both events')
  assert.equal(timeline[0].eventType, 'target_write_failed', 'sorted by run_created_at: failed (run_1) first')
  assert.equal(timeline[1].eventType, 'target_write_succeeded', 'then succeeded (run_2)')
  assert.equal(timeline[0].runId, 'run_1')
  assert.equal(timeline[1].runId, 'run_2')
  // projection shape is EXACTLY the OpenAPI-locked field set — no drop, no extra view column
  assert.deepEqual(Object.keys(timeline[0]).sort(), [...PROVENANCE_TIMELINE_ENTRY_FIELDS].sort(), 'entry keys == projection field list')
  // 2b's redaction survives the read path (read does NOT re-redact, but the stored value is scrubbed)
  assert.ok(!timeline[0].attrs.errorMessage.includes('S3cretPass'), 'secret stays scrubbed (2b scrub gate)')
  assert.match(timeline[0].attrs.errorMessage, /postgres:\/\/erp:\[redacted\]@10\.0\.0\.5/, 'redacted DSN read back intact')

  // --- window bounds whole RUNS by run_created_at ---
  const windowed = await registry.listProvenanceByRow({ tenantId: 'tenant_1', workspaceId: null, rowId, from: '2026-04-24T01:30:00.000Z' })
  assert.equal(windowed.length, 1, 'from-window excludes run_1')
  assert.equal(windowed[0].runId, 'run_2')

  // --- scope/rowId filter: an unknown rowId yields nothing ---
  const none = await registry.listProvenanceByRow({ tenantId: 'tenant_1', workspaceId: null, rowId: 'no-such-row' })
  assert.equal(none.length, 0, 'unknown rowId → empty timeline')

  // --- pipelineId filter exercised end-to-end (all view rows are pipe_1) ---
  const otherPipeline = await registry.listProvenanceByRow({ tenantId: 'tenant_1', workspaceId: null, rowId, pipelineId: 'pipe_2' })
  assert.equal(otherPipeline.length, 0, 'pipelineId filter excludes other pipelines')
  const samePipeline = await registry.listProvenanceByRow({ tenantId: 'tenant_1', workspaceId: null, rowId, pipelineId: 'pipe_1' })
  assert.equal(samePipeline.length, 2, 'pipelineId filter includes the matching pipeline')

  // --- rowId is required ---
  await assert.rejects(() => registry.listProvenanceByRow({ tenantId: 'tenant_1', workspaceId: null }), /rowId is required/)

  console.log('✓ df-n2-2c: provenance read-route round-trip (2b write → view → 2c read) passed')
}

main().catch((err) => { console.error(err); process.exit(1) })
