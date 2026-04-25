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
      const number = body.Model.FNumber
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

  return { db, feedbackUpdates, k3FetchMock, pipeline, runner }
}

async function main() {
  const harness = createHarness()
  const result = await harness.runner.runPipeline({
    tenantId: 'tenant_1',
    workspaceId: null,
    pipelineId: 'pipe_plm_k3',
    mode: 'incremental',
    triggeredBy: 'manual',
  })

  assert.equal(result.run.status, 'partial')
  assert.equal(result.metrics.rowsRead, 2)
  assert.equal(result.metrics.rowsCleaned, 2)
  assert.equal(result.metrics.rowsWritten, 1)
  assert.equal(result.metrics.rowsFailed, 1)
  assert.equal(harness.k3FetchMock.calls.filter((call) => call.pathname === '/K3API/Material/Save').length, 2)
  assert.equal(harness.k3FetchMock.calls.some((call) => call.pathname === '/K3API/Material/Submit'), false)
  assert.equal(harness.k3FetchMock.calls.some((call) => call.pathname === '/K3API/Material/Audit'), false)

  const deadLetters = harness.db.tables.get('integration_dead_letters')
  assert.equal(deadLetters.length, 1)
  assert.equal(deadLetters[0].error_code, 'K3_MATERIAL_INVALID')
  assert.equal(deadLetters[0].transformed_payload.FNumber, 'BAD-02')
  assert.equal(await harness.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_plm_k3' }), null, 'partial run does not advance watermark')

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

  assert.deepEqual(result.run.details.erpFeedback, [
    {
      ok: true,
      skipped: false,
      reason: null,
      projectId: 'project_1',
      objectId: 'standard_materials',
      keyField: '_integration_idempotency_key',
      items: 2,
      written: 2,
    },
  ])

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
