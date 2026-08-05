'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createAdapterRegistry,
  createUpsertResult,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const { createYuantusPlmWrapperAdapterFactory } = require(path.join(__dirname, '..', 'lib', 'adapters', 'plm-yuantus-wrapper.cjs'))
const { createK3WiseWebApiAdapterFactory } = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-webapi-adapter.cjs'))
const { createPipelineRunner } = require(path.join(__dirname, '..', 'lib', 'pipeline-runner.cjs'))
const { createDeadLetterStore } = require(path.join(__dirname, '..', 'lib', 'dead-letter.cjs'))
const { createWatermarkStore } = require(path.join(__dirname, '..', 'lib', 'watermark.cjs'))
const { createRunLogger } = require(path.join(__dirname, '..', 'lib', 'run-log.cjs'))
const { createErpFeedbackWriter } = require(path.join(__dirname, '..', 'lib', 'erp-feedback.cjs'))

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body)
    },
  }
}

function createK3FetchMock() {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ pathname: parsed.pathname, body, options })
    if (parsed.pathname === '/K3API/Login') {
      return jsonResponse(200, { success: true, sessionId: 'session_1' })
    }
    if (parsed.pathname === '/K3API/Material/Save') {
      const number = (body.Model || body.Data).FNumber
      if (number === 'BAD-02') {
        return jsonResponse(200, { success: false, code: 'K3_MATERIAL_INVALID', message: 'material code rejected' })
      }
      return jsonResponse(200, {
        success: true,
        externalId: `k3_${number}`,
        billNo: `BILL-${number}`,
        message: 'saved',
      })
    }
    return jsonResponse(404, { success: false, message: 'not found' })
  }
  return { calls, fetchImpl }
}

function createMockDb() {
  const tables = new Map([
    ['integration_dead_letters', []],
    ['integration_watermarks', []],
    ['integration_runs', []],
  ])

  function rows(table) {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }

  function matches(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  return {
    tables,
    async selectOne(table, where) {
      return rows(table).find((row) => matches(row, where)) || null
    },
    async insertOne(table, row) {
      const stored = {
        ...row,
        created_at: row.created_at || '2026-04-24T00:00:00.000Z',
        updated_at: row.updated_at || '2026-04-24T00:00:00.000Z',
      }
      rows(table).push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      const row = rows(table).find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-04-24T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) {
      return rows(table).filter((row) => matches(row, options.where || {}))
    },
  }
}

function createPipelineRegistry(pipeline, db) {
  let nextRun = 1
  return {
    async getPipeline() {
      return pipeline
    },
    async createPipelineRun(input) {
      const id = `run_${nextRun++}`
      const row = {
        id,
        tenant_id: input.tenantId,
        workspace_id: input.workspaceId ?? null,
        pipeline_id: input.pipelineId,
        mode: input.mode,
        triggered_by: input.triggeredBy,
        status: input.status,
        rows_read: 0,
        rows_cleaned: 0,
        rows_written: 0,
        rows_failed: 0,
        started_at: input.startedAt || null,
        details: input.details || {},
      }
      await db.insertOne('integration_runs', row)
      return {
        id,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId ?? null,
        pipelineId: input.pipelineId,
        mode: input.mode,
        triggeredBy: input.triggeredBy,
        status: input.status,
        startedAt: input.startedAt,
        details: input.details || {},
      }
    },
    async updatePipelineRun(input) {
      const rows = await db.updateRow('integration_runs', {
        status: input.status,
        rows_read: input.rowsRead,
        rows_cleaned: input.rowsCleaned,
        rows_written: input.rowsWritten,
        rows_failed: input.rowsFailed,
        duration_ms: input.durationMs,
        error_summary: input.errorSummary || null,
        details: input.details || {},
      }, {
        tenant_id: input.tenantId,
        workspace_id: input.workspaceId ?? null,
        id: input.id,
      })
      const row = rows[0]
      return {
        id: row.id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        pipelineId: row.pipeline_id,
        status: row.status,
        rowsRead: row.rows_read,
        rowsCleaned: row.rows_cleaned,
        rowsWritten: row.rows_written,
        rowsFailed: row.rows_failed,
        durationMs: row.duration_ms,
        errorSummary: row.error_summary,
        details: row.details,
      }
    },
  }
}

function createPlmClient() {
  return {
    isConnected() {
      return true
    },
    async getProducts() {
      return {
        data: [
          {
            id: 'plm_good',
            itemCode: ' good-01 ',
            itemName: ' Good material ',
            revision: 'A',
            unitName: 'PCS',
            updated_at: '2026-04-24T01:00:00.000Z',
          },
          {
            id: 'plm_bad',
            itemCode: ' bad-02 ',
            itemName: ' Bad material ',
            revision: 'A',
            unitName: 'PCS',
            updated_at: '2026-04-24T02:00:00.000Z',
          },
        ],
        metadata: { totalCount: 2 },
      }
    },
    async getProductBOM() {
      return {
        data: [
          {
            id: 'bom_line_1',
            parentCode: 'GOOD-01',
            componentCode: 'BAD-02',
            quantity: '2',
            unit: 'PCS',
          },
        ],
        metadata: { totalCount: 1 },
      }
    },
  }
}

function createExternalSystemRegistry({ k3FetchMock }) {
  const systems = new Map([
    ['plm_1', {
      id: 'plm_1',
      name: 'Yuantus PLM',
      kind: 'plm:yuantus-wrapper',
      role: 'source',
      status: 'active',
      config: {},
    }],
    ['k3_1', {
      id: 'k3_1',
      name: 'K3 WISE',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'active',
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: false,
        autoAudit: false,
        objects: { material: { profile: 'material-k3wise-customer-profile-v1' } },
      },
      credentials: {
        username: 'demo',
        password: 'secret',
        acctId: '001',
      },
    }],
  ])
  return {
    async getExternalSystem(input) {
      return systems.get(input.id)
    },
    async getExternalSystemForAdapter(input) {
      const system = systems.get(input.id)
      if (!system) return null
      if (system.id === 'k3_1') {
        k3FetchMock.bound = true
      }
      return system
    },
  }
}

function createHarness() {
  const db = createMockDb()
  const plmClient = createPlmClient()
  const k3FetchMock = createK3FetchMock()
  const feedbackUpdates = []
  const pipeline = {
    id: 'pipe_plm_k3',
    tenantId: 'tenant_1',
    workspaceId: null,
    projectId: 'project_1',
    sourceSystemId: 'plm_1',
    sourceObject: 'materials',
    targetSystemId: 'k3_1',
    targetObject: 'material',
    mode: 'incremental',
    status: 'active',
    idempotencyKeyFields: ['sourceId', 'revision'],
    options: {
      batchSize: 10,
      watermark: { type: 'updated_at', field: 'updatedAt' },
      erpFeedback: {
        objectId: 'standard_materials',
        keyField: '_integration_idempotency_key',
      },
    },
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', transform: ['trim', 'upper'], validation: [{ type: 'required' }] },
      { sourceField: 'name', targetField: 'FName', transform: { fn: 'trim' }, validation: [{ type: 'required' }] },
      { sourceField: 'sourceId', targetField: 'sourceId', validation: [{ type: 'required' }] },
      { sourceField: 'revision', targetField: 'revision', validation: [{ type: 'required' }] },
    ],
  }
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('plm:yuantus-wrapper', createYuantusPlmWrapperAdapterFactory({ plmClient }))
    .registerAdapter('erp:k3-wise-webapi', createK3WiseWebApiAdapterFactory({ fetchImpl: k3FetchMock.fetchImpl }))

  const feedbackWriter = createErpFeedbackWriter({
    clock: () => '2026-04-24T12:00:00.000Z',
    stagingWriter: {
      async updateRecords(input) {
        feedbackUpdates.push(input)
        return {
          ok: true,
          written: input.updates.length,
          patched: input.updates.length,
          created: 0,
        }
      },
    },
  })

  const runner = createPipelineRunner({
    pipelineRegistry: createPipelineRegistry(pipeline, db),
    externalSystemRegistry: createExternalSystemRegistry({ k3FetchMock }),
    adapterRegistry,
    deadLetterStore: createDeadLetterStore({ db, idGenerator: () => `dl_${db.tables.get('integration_dead_letters').length + 1}` }),
    watermarkStore: createWatermarkStore({ db }),
    runLogger: createRunLogger({ pipelineRegistry: createPipelineRegistry(pipeline, db) }),
    erpFeedbackWriter: feedbackWriter,
    clock: (() => {
      let tick = 0
      return () => tick++ * 20
    })(),
  })

  // feedbackWriter is exposed alongside the runner so the OWNER REVIEW P1 (20260805) flip below
  // can drive it directly — see the [FLIP 20260625->] comment in main().
  return { db, feedbackUpdates, k3FetchMock, pipeline, runner, feedbackWriter }
}

async function main() {
  const harness = createHarness()

  // --- OWNER REVIEW P1 (20260805) DELIBERATE FLIP -----------------------------------------
  // pipeline-runner.cjs's loadPipelineContext now fails closed on ANY non-dryRun runPipeline
  // against a K3 WISE target (details.code === 'K3_WISE_PIPELINE_RUN_DISABLED', thrown before
  // any read/adapter-creation/write) — the C6 dry-run -> approval-token -> apply lifecycle is
  // the ONLY sanctioned K3 write entry point now. This suite's old live-run body (below,
  // through the original erpFeedback deepEqual) drove that now-refused path and cannot be
  // produced through runner.runPipeline() for a K3 target anymore. Disposition:
  //   1. Prove the refusal itself, with zero side effects — the new canonical behavior.
  //   2. [FLIP 20260625->] dead-letter generation and ERP-feedback rows: directly construct
  //      the state those two mechanisms consume (mirrors pipeline-runner.test.cjs's
  //      createDeadLetterStore direct-insert pattern), shaped exactly as the real K3 adapter
  //      emits it — see the comments at each block below.
  //   3. NOT reconstructed here: the aggregate run-record semantics (status='partial',
  //      rowsRead/rowsCleaned/rowsWritten/rowsFailed, run.details.erpFeedback) and the
  //      byte-exact Material/Save request body. Both are generic, non-K3-specific mechanisms
  //      that are already exercised end-to-end elsewhere with real assertions: run-record
  //      aggregation via a mock-target in pipeline-runner.test.cjs (its own 'partial' status +
  //      erpFeedback deepEqual checks), and the K3 Save body / values-free projection via
  //      direct adapter.upsert() calls in k3-wise-c6-write-profile.test.cjs and
  //      k3-wise-apply-row-limit.test.cjs. Re-deriving either here would just re-test those
  //      other harnesses, not additional product code, so they are not duplicated in this file.
  const liveRefusal = await harness.runner.runPipeline({
    tenantId: 'tenant_1',
    workspaceId: null,
    pipelineId: 'pipe_plm_k3',
    mode: 'incremental',
    triggeredBy: 'manual',
  }).catch((error) => error)
  assert.ok(liveRefusal instanceof Error, 'K3-target live run must refuse')
  assert.equal(liveRefusal.name, 'PipelineRunnerError', 'refusal is a PipelineRunnerError')
  assert.equal(liveRefusal.details && liveRefusal.details.code, 'K3_WISE_PIPELINE_RUN_DISABLED')
  assert.equal(harness.k3FetchMock.calls.length, 0, 'guard fires before any adapter is created — zero K3 HTTP calls, save/submit/audit included')
  assert.equal(harness.db.tables.get('integration_runs').length, 0, 'guard fires in loadPipelineContext, before runLogger.startRun — no run record is written')
  assert.equal(await harness.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_plm_k3' }), null, 'a refused run never touches the watermark')

  // [FLIP 20260625->] dead-letter generation. ORIGINAL SEMANTICS: a live runPipeline hit K3
  // Material/Save with the BAD-02 record and got back { success: false, code:
  // 'K3_MATERIAL_INVALID', message: 'material code rejected' } from createK3FetchMock above;
  // pipeline-runner's writeDeadLetter() then persisted that failure. NEW CARRIER: that live
  // path is refused now, so insert the identically-shaped dead letter directly through the
  // same store class the runner itself uses (createDeadLetterStore — same technique as
  // pipeline-runner.test.cjs's k3Letters.createDeadLetter() direct-insert), and prove it
  // round-trips through the mock db correctly.
  const directDeadLetters = createDeadLetterStore({
    db: harness.db,
    idGenerator: () => `dl_direct_${harness.db.tables.get('integration_dead_letters').length + 1}`,
  })
  await directDeadLetters.createDeadLetter({
    tenantId: 'tenant_1',
    workspaceId: null,
    runId: 'run_e2e_direct',
    pipelineId: 'pipe_plm_k3',
    sourcePayload: { id: 'plm_bad', itemCode: ' bad-02 ', itemName: ' Bad material ', revision: 'A' },
    transformedPayload: { FNumber: 'BAD-02', FName: 'Bad material' },
    errorCode: 'K3_MATERIAL_INVALID',
    errorMessage: 'material code rejected',
  })
  const deadLetters = harness.db.tables.get('integration_dead_letters')
  assert.equal(deadLetters.length, 1)
  assert.equal(deadLetters[0].error_code, 'K3_MATERIAL_INVALID')
  assert.equal(deadLetters[0].transformed_payload.FNumber, 'BAD-02')

  // [FLIP 20260625->] ERP feedback rows. ORIGINAL SEMANTICS: writeErpFeedback() ran after a
  // live write batch of one synced + one failed record, driven by the real K3 adapter's
  // upsert() result. NEW CARRIER: feed harness.feedbackWriter.writeBack() directly with a
  // writeResult shaped exactly as that adapter emits it — verified against
  // k3-wise-webapi-adapter.cjs's upsert(): the success branch pushes
  // { key, status:'written', externalId, billNo, responseCode, responseMessage } and the
  // failure branch pushes { key, code, message } (see results.push()/errors.push() there) —
  // and cleanRecords shaped as pipeline-runner's processRecord() builds them
  // ({ sourceRecord, targetRecord: { ...transformed, _integration_idempotency_key } }).
  // This proves the synced/failed field-mapping mechanism the pipeline depends on is intact,
  // independent of the now-refused live wiring.
  const directCleanRecords = [
    {
      sourceRecord: { id: 'plm_good', itemCode: ' good-01 ', itemName: ' Good material ', revision: 'A' },
      targetRecord: { FNumber: 'GOOD-01', FName: 'Good material', _integration_idempotency_key: 'GOOD-01|A' },
    },
    {
      sourceRecord: { id: 'plm_bad', itemCode: ' bad-02 ', itemName: ' Bad material ', revision: 'A' },
      targetRecord: { FNumber: 'BAD-02', FName: 'Bad material', _integration_idempotency_key: 'BAD-02|A' },
    },
  ]
  const directWriteResult = {
    results: [{
      key: 'GOOD-01|A',
      status: 'written',
      externalId: 'k3_GOOD-01',
      billNo: 'BILL-GOOD-01',
      responseCode: 'OK',
      responseMessage: 'saved',
    }],
    errors: [{
      key: 'BAD-02|A',
      code: 'K3_MATERIAL_INVALID',
      message: 'material code rejected',
    }],
  }
  const directFeedback = await harness.feedbackWriter.writeBack({
    tenantId: 'tenant_1',
    workspaceId: null,
    runId: 'run_e2e_direct',
    pipeline: harness.pipeline,
    cleanRecords: directCleanRecords,
    writeResult: directWriteResult,
  })
  assert.equal(directFeedback.ok, true)
  assert.equal(directFeedback.skipped, false)
  assert.equal(directFeedback.projectId, 'project_1')
  assert.equal(directFeedback.objectId, 'standard_materials')
  assert.equal(directFeedback.keyField, '_integration_idempotency_key')
  assert.equal(directFeedback.items.length, 2)
  assert.equal(directFeedback.result.written, 2)

  assert.equal(harness.feedbackUpdates.length, 1)
  assert.equal(harness.feedbackUpdates[0].projectId, 'project_1')
  assert.equal(harness.feedbackUpdates[0].objectId, 'standard_materials')
  assert.equal(harness.feedbackUpdates[0].updates.length, 2)
  const synced = harness.feedbackUpdates[0].updates.find((update) => update.status === 'synced')
  const failed = harness.feedbackUpdates[0].updates.find((update) => update.status === 'failed')
  assert.equal(synced.fields.erpSyncStatus, 'synced')
  assert.equal(synced.fields.erpExternalId, 'k3_GOOD-01')
  assert.equal(synced.fields.erpBillNo, 'BILL-GOOD-01')
  assert.equal(synced.fields.erpResponseCode, 'OK')
  assert.equal(synced.fields.erpResponseMessage, 'saved')
  assert.equal(failed.fields.erpSyncStatus, 'failed')
  assert.equal(failed.fields.erpResponseCode, 'K3_MATERIAL_INVALID')
  assert.equal(failed.fields.erpResponseMessage, 'material code rejected')

  // --- dry-run preview: UNCHANGED. The guard in loadPipelineContext explicitly allows
  // dryRun !== true to pass through — previews are read-only and the C6 planner needs
  // nothing from here (see the OWNER REVIEW P1 comment in pipeline-runner.cjs). ---------
  const dryHarness = createHarness()
  const dryRun = await dryHarness.runner.runPipeline({
    tenantId: 'tenant_1',
    workspaceId: null,
    pipelineId: 'pipe_plm_k3',
    mode: 'incremental',
    triggeredBy: 'manual',
    dryRun: true,
    sampleLimit: 2,
  })
  assert.equal(dryRun.metrics.rowsRead, 2)
  assert.equal(dryRun.metrics.rowsWritten, 0)
  assert.equal(dryRun.preview.records[0].targetPayload.Data.FNumber, 'GOOD-01')
  assert.equal(dryRun.preview.records[0].targetPayload.Data.FName, 'Good material')
  assert.equal(dryRun.preview.records[0].targetPayload.Data.sourceId, undefined)
  assert.equal(dryRun.preview.records[0].targetRequest.query.Token, '[redacted]')
  assert.equal(dryHarness.k3FetchMock.calls.some((call) => call.pathname === '/K3API/Material/Save'), false)
  assert.equal(dryHarness.db.tables.get('integration_dead_letters').length, 0)
  assert.equal(dryHarness.feedbackUpdates.length, 0)
  assert.equal(await dryHarness.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_plm_k3' }), null)

  console.log('✓ e2e-plm-k3wise-writeback: mock PLM → K3 WISE → feedback tests passed')
}

main().catch((err) => {
  console.error('✗ e2e-plm-k3wise-writeback FAILED')
  console.error(err)
  process.exit(1)
})
