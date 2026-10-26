'use strict'

// Batch-refresh step 4, PR-6 — what the PIPELINE RUNNER does with a generic writer's governed-sheet refusal (design
// §7.1 rows 17-18). The runner is real (lib/pipeline-runner.cjs) and so are the two seams it drives: the
// `metasheet:multitable` target adapter (registered exactly as index.cjs does, through its factory, with a scripted
// probe) and the ERP feedback writer. A compact harness (the pipeline-runner.test.cjs shapes, trimmed) supplies the
// pipeline / system registries, the dead-letter and watermark stores and the run log over an in-memory db.
//
//   R-01 a live run into a governed target: the runner throws PipelineRunnerError('pipeline run failed') whose
//        `details.cause` names the code and the object key (no cell value, no sheet id); the run is finished
//        `failed` with that message as its errorSummary; NO dead letter (the source rows are clean, so the only way
//        a letter could appear is the refusal); the watermark is not advanced; zero host writes.
//   R-02 a dead-letter replay into such a target: the PipelineRunnerError propagates, the letter stays `open`
//        (never marked replayed), zero host writes.
//   R-03 a dry run into such a target: previewUpsert runs, upsert does not, the probe is never asked (byte-identical
//        preview).
//   R-04 a target that is NOT governed but an ERP feedback object that IS: the run succeeds and writes its rows;
//        the run details' erpFeedback entry carries `reason: ERP_FEEDBACK_GOVERNED_SHEET_REFUSED` (the projection's
//        fixed field set — `code` is dropped); zero feedback writes; under failOnError the runner's own catch records
//        ERP_FEEDBACK_THROWN with the code inside `error`; the run status is unchanged on both legs.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const { createAdapterRegistry, createReadResult } = require(path.join(LIB, 'contracts.cjs'))
const { createPipelineRunner } = require(path.join(LIB, 'pipeline-runner.cjs'))
const { createDeadLetterStore } = require(path.join(LIB, 'dead-letter.cjs'))
const { createWatermarkStore } = require(path.join(LIB, 'watermark.cjs'))
const { createRunLogger } = require(path.join(LIB, 'run-log.cjs'))
const { createErpFeedbackWriter } = require(path.join(LIB, 'erp-feedback.cjs'))
const adapterLib = require(path.join(LIB, 'adapters', 'metasheet-multitable-target-adapter.cjs'))
const probeLib = require(path.join(LIB, 'stock-preparation-governed-sheet-probe.cjs'))

const { GOVERNED_SHEET_WRITE_CODES: CODES } = probeLib

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_rgs_a'
const TARGET_SHEET = 'sheet_rgs_target'
const FEEDBACK_OBJECT = 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567'

const NOT_GOVERNED = Object.freeze({ ok: true, governed: false, reason: null, registry: Object.freeze({ present: false }), marks: Object.freeze({ continuation: 0, openHold: 0, state: 0, execution: 0 }) })
const GOVERNED = Object.freeze({ ok: true, governed: true, reason: 'hold', registry: Object.freeze({ present: true, pilot: false, tenantMatches: true }), marks: Object.freeze({ continuation: 0, openHold: 1, state: 1, execution: 0 }) })

function scriptedProbe(answerFor) {
  const calls = []
  return {
    calls,
    async probe(input) { calls.push({ via: 'probe', ...input }); return answerFor(input) },
    async assertSheetWritable(input) {
      calls.push({ via: 'assert', ...input })
      const answer = answerFor(input)
      if (answer.governed) throw probeLib.governedSheetRefusal({ surface: input.surface, reason: answer.reason, objectId: input.objectId })
      return answer
    },
  }
}

function createMockDb() {
  const tables = new Map([['integration_dead_letters', []], ['integration_watermarks', []], ['integration_runs', []]])
  const rows = (table) => { if (!tables.has(table)) tables.set(table, []); return tables.get(table) }
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => (value === null || value === undefined ? row[key] === null || row[key] === undefined : row[key] === value))
  return {
    tables,
    async selectOne(table, where) { return rows(table).find((row) => matches(row, where)) || null },
    async insertOne(table, row) { const stored = { ...row, created_at: row.created_at || '2026-10-26T00:00:00.000Z', updated_at: row.updated_at || '2026-10-26T00:00:00.000Z' }; rows(table).push(stored); return [stored] },
    async updateRow(table, set, where) { const row = rows(table).find((candidate) => matches(candidate, where)); if (!row) return []; Object.assign(row, set); return [row] },
    async select(table, options = {}) { return rows(table).filter((row) => matches(row, options.where || {})) },
  }
}

function createPipelineRegistry(pipeline, db) {
  let nextRun = 1
  return {
    async getPipeline() { return pipeline },
    async createPipelineRun(input) {
      const id = `run_${nextRun++}`
      await db.insertOne('integration_runs', { id, tenant_id: input.tenantId, workspace_id: input.workspaceId ?? null, pipeline_id: input.pipelineId, status: input.status, details: input.details || {} })
      return { id, tenantId: input.tenantId, workspaceId: input.workspaceId ?? null, pipelineId: input.pipelineId, mode: input.mode, triggeredBy: input.triggeredBy, status: input.status, details: input.details || {} }
    },
    async updatePipelineRun(input) {
      const [row] = await db.updateRow('integration_runs', { status: input.status, error_summary: input.errorSummary || null, details: input.details || {}, rows_written: input.rowsWritten, rows_failed: input.rowsFailed }, { id: input.id })
      return { id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, pipelineId: row.pipeline_id, status: row.status, errorSummary: row.error_summary, details: row.details, provenanceEvents: [] }
    },
  }
}

function recordingContext() {
  const calls = []
  const rows = []
  return {
    calls,
    rows,
    context: {
      api: {
        multitable: {
          records: {
            async queryRecords(input) { calls.push(['queryRecords', input.sheetId]); return [] },
            async createRecord(input) { calls.push(['createRecord', input.sheetId]); rows.push(input); return { id: `rec_${rows.length}`, version: 1 } },
            async patchRecord(input) { calls.push(['patchRecord', input.sheetId]); return { id: input.recordId, version: 2 } },
          },
          provisioning: {
            async findObjectSheet({ objectId }) { calls.push(['findObjectSheet', objectId]); return { id: `sheet_for_${objectId}` } },
            async resolveFieldIds({ fieldIds }) { calls.push(['resolveFieldIds']); return Object.fromEntries(fieldIds.map((id) => [id, id])) },
          },
        },
      },
    },
  }
}

const SOURCE_RECORDS = [
  { code: 'rgs-01', revision: 'r1', qty: '3', name: 'CELLVALUE_BOLT', updatedAt: '2026-10-26T01:00:00.000Z' },
  { code: 'rgs-02', revision: 'r1', qty: '4', name: 'CELLVALUE_NUT', updatedAt: '2026-10-26T02:00:00.000Z' },
]

function harness({ targetAnswer = () => NOT_GOVERNED, feedbackAnswer = () => NOT_GOVERNED, erpFeedback = null } = {}) {
  const db = createMockDb()
  const host = recordingContext()
  const targetProbe = scriptedProbe(targetAnswer)
  const feedbackProbe = scriptedProbe(feedbackAnswer)
  const pipeline = {
    id: 'pipe_rgs', tenantId: TENANT, workspaceId: null, projectId: `${TENANT}:integration-core`,
    sourceSystemId: 'source_1', sourceObject: 'materials', targetSystemId: 'target_1', targetObject: 'main',
    mode: 'incremental', status: 'active', idempotencyKeyFields: ['code', 'revision'],
    options: { batchSize: 100, watermark: { type: 'updated_at', field: 'updatedAt', tiebreaker: 'code' }, ...(erpFeedback ? { erpFeedback } : {}) },
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', transform: ['trim', 'upper'], validation: [{ type: 'required' }] },
      { sourceField: 'qty', targetField: 'FQty', transform: { fn: 'toNumber' } },
      { sourceField: 'name', targetField: 'FName' },
    ],
  }
  const systems = new Map([
    ['source_1', { id: 'source_1', name: 'PLM mock', kind: 'mock-source', role: 'source', config: {} }],
    // V50B-12's configuration: a free-text object key (`main`), no projectId — the ownership guard is inactive.
    ['target_1', { id: 'target_1', tenantId: TENANT, name: 'MetaSheet target', kind: 'metasheet:multitable', role: 'target', config: { objects: { main: { sheetId: TARGET_SHEET, keyFields: ['FNumber'], fields: ['FNumber', 'FQty', 'FName'], mode: 'upsert' } } } }],
  ])
  let previewCalls = 0
  let upsertCalls = 0
  const realFactory = adapterLib.createMetaSheetMultitableTargetAdapterFactory({ context: host.context, governedSheetProbe: targetProbe })
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('mock-source', () => ({
      async testConnection() { return { ok: true } },
      async listObjects() { return [] },
      async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: SOURCE_RECORDS.slice() }) },
      async upsert() { throw new Error('source upsert') },
    }))
    .registerAdapter('metasheet:multitable', (input) => {
      const real = realFactory(input)
      return { ...real, async previewUpsert(request) { previewCalls += 1; return real.previewUpsert(request) }, async upsert(request) { upsertCalls += 1; return real.upsert(request) } }
    })
  const pipelineRegistry = createPipelineRegistry(pipeline, db)
  const deadLetterStore = createDeadLetterStore({ db, idGenerator: () => `dl_${db.tables.get('integration_dead_letters').length + 1}` })
  const runner = createPipelineRunner({
    pipelineRegistry,
    externalSystemRegistry: {
      async getExternalSystem({ id }) { return systems.get(id) },
      async getExternalSystemForAdapter({ id }) { const system = systems.get(id); return system ? { ...system, credentials: {} } : null },
    },
    adapterRegistry,
    deadLetterStore,
    watermarkStore: createWatermarkStore({ db }),
    runLogger: createRunLogger({ pipelineRegistry }),
    erpFeedbackWriter: createErpFeedbackWriter({ context: host.context, clock: () => '2026-10-26T00:00:00.000Z', governedSheetProbe: feedbackProbe }),
    clock: (() => { let tick = 0; return () => tick++ * 25 })(),
  })
  return { db, host, runner, deadLetterStore, targetProbe, feedbackProbe, counts: () => ({ previewCalls, upsertCalls }) }
}

const writesOf = (calls) => calls.filter(([name]) => name === 'createRecord' || name === 'patchRecord')

async function settle(promise) {
  try { return { ok: true, value: await promise } } catch (error) { return { ok: false, error } }
}

test('R-01 a live run into a governed target: PipelineRunnerError whose cause names the code and the object key (no cell value, no sheet id); run failed with that errorSummary; NO dead letter; watermark not advanced; zero host writes', async () => {
  const h = harness({ targetAnswer: () => GOVERNED })
  const outcome = await settle(h.runner.runPipeline({ tenantId: TENANT, workspaceId: null, pipelineId: 'pipe_rgs', mode: 'incremental', triggeredBy: 'manual' }))
  assert.equal(outcome.ok, false)
  const error = outcome.error
  assert.equal(error.name, 'PipelineRunnerError')
  assert.equal(error.message, 'pipeline run failed')
  const cause = error.details.cause
  assert.ok(cause.startsWith(`${CODES.REFUSED}: object "main"`), cause)
  for (const forbidden of ['CELLVALUE', TARGET_SHEET, TENANT]) assert.equal(cause.includes(forbidden), false, `${forbidden} in ${cause}`)
  const run = h.db.tables.get('integration_runs')[0]
  assert.equal(run.status, 'failed')
  assert.equal(run.error_summary, cause)
  assert.equal(h.db.tables.get('integration_dead_letters').length, 0, 'the refusal wrote no dead letter (the source rows are clean)')
  assert.equal(h.db.tables.get('integration_watermarks').length, 0, 'the watermark did not advance')
  assert.deepEqual(writesOf(h.host.calls), [])
  assert.equal(h.host.calls.filter(([name]) => name === 'queryRecords').length, 0, 'not even a key lookup')
  assert.deepEqual(h.targetProbe.calls, [{ via: 'probe', sheetId: TARGET_SHEET, tenantId: TENANT }])
  assert.equal(h.feedbackProbe.calls.length, 0, 'the feedback writer never ran (the target refused first)')
})

test('R-02 a dead-letter replay into a governed target: the error propagates, the letter stays open, zero host writes', async () => {
  const h = harness({ targetAnswer: () => GOVERNED })
  await h.deadLetterStore.createDeadLetter({
    tenantId: TENANT, workspaceId: null, runId: 'run_original', pipelineId: 'pipe_rgs',
    sourcePayload: SOURCE_RECORDS[0], transformedPayload: null, errorCode: 'VALIDATION_FAILED', errorMessage: 'old mapping failed',
  })
  const outcome = await settle(h.runner.replayDeadLetter({ tenantId: TENANT, workspaceId: null, id: 'dl_1' }))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.name, 'PipelineRunnerError')
  assert.ok(String(outcome.error.details && outcome.error.details.cause).includes(CODES.REFUSED))
  const letter = h.db.tables.get('integration_dead_letters')[0]
  assert.equal(letter.status, 'open', 'never marked replayed')
  assert.deepEqual(writesOf(h.host.calls), [])
})

test('R-03 a dry run into a governed target: previewUpsert runs, upsert does not, the probe is never asked', async () => {
  const h = harness({ targetAnswer: () => GOVERNED })
  const result = await h.runner.runPipeline({ tenantId: TENANT, workspaceId: null, pipelineId: 'pipe_rgs', mode: 'incremental', triggeredBy: 'manual', dryRun: true })
  assert.equal(result.run.status, 'succeeded')
  assert.deepEqual(h.counts(), { previewCalls: 1, upsertCalls: 0 })
  assert.equal(h.targetProbe.calls.length, 0)
  assert.deepEqual(h.host.calls, [])
})

test('R-04 target not governed, ERP feedback object governed: the run succeeds and writes; erpFeedback carries reason ERP_FEEDBACK_GOVERNED_SHEET_REFUSED with zero feedback writes; failOnError => ERP_FEEDBACK_THROWN with the code in `error`; the run status is unchanged', async () => {
  const feedbackOptions = { objectId: FEEDBACK_OBJECT, projectId: `${TENANT}:integration-core`, keyField: 'FNumber' }
  const h = harness({ feedbackAnswer: () => GOVERNED, erpFeedback: feedbackOptions })
  const result = await h.runner.runPipeline({ tenantId: TENANT, workspaceId: null, pipelineId: 'pipe_rgs', mode: 'incremental', triggeredBy: 'manual' })
  assert.equal(result.run.status, 'succeeded')
  assert.equal(writesOf(h.host.calls).length, 2, 'the two target rows were written')
  assert.ok(writesOf(h.host.calls).every(([, sheetId]) => sheetId === TARGET_SHEET), 'every write landed on the target sheet, none on the feedback sheet')
  const [feedback] = result.run.details.erpFeedback
  assert.equal(feedback.ok, false)
  assert.equal(feedback.reason, 'ERP_FEEDBACK_GOVERNED_SHEET_REFUSED')
  assert.equal(Object.prototype.hasOwnProperty.call(feedback, 'code'), false, 'the runner projection keeps a fixed field set')
  assert.deepEqual(h.feedbackProbe.calls, [{ via: 'assert', sheetId: `sheet_for_${FEEDBACK_OBJECT}`, tenantId: TENANT, surface: 'erp_feedback', objectId: FEEDBACK_OBJECT }])
  assert.equal(h.host.calls.filter(([name]) => name === 'resolveFieldIds').length, 0, 'the feedback writer stopped before its field resolve')

  const strict = harness({ feedbackAnswer: () => GOVERNED, erpFeedback: { ...feedbackOptions, failOnError: true } })
  const strictResult = await strict.runner.runPipeline({ tenantId: TENANT, workspaceId: null, pipelineId: 'pipe_rgs', mode: 'incremental', triggeredBy: 'manual' })
  assert.equal(strictResult.run.status, 'succeeded', 'a feedback failure never changes the run status (as before PR-6)')
  const [thrown] = strictResult.run.details.erpFeedback
  assert.equal(thrown.reason, 'ERP_FEEDBACK_THROWN')
  assert.ok(thrown.error.includes(CODES.REFUSED), thrown.error)
  assert.equal(thrown.error.includes(`sheet_for_${FEEDBACK_OBJECT}`), false)
  assert.equal(writesOf(strict.host.calls).filter(([, sheetId]) => sheetId !== TARGET_SHEET).length, 0)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('pipeline-runner-governed-sheet.test.cjs', tests)
