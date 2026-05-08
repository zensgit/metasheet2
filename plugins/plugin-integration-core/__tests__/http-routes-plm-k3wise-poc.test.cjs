'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { registerIntegrationRoutes } = require(path.join(__dirname, '..', 'lib', 'http-routes.cjs'))
const { createAdapterRegistry } = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const { createYuantusPlmWrapperAdapterFactory } = require(path.join(__dirname, '..', 'lib', 'adapters', 'plm-yuantus-wrapper.cjs'))
const { createK3WiseWebApiAdapterFactory } = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-webapi-adapter.cjs'))
const { createPipelineRunner } = require(path.join(__dirname, '..', 'lib', 'pipeline-runner.cjs'))
const { createDeadLetterStore } = require(path.join(__dirname, '..', 'lib', 'dead-letter.cjs'))
const { createWatermarkStore } = require(path.join(__dirname, '..', 'lib', 'watermark.cjs'))
const { createRunLogger } = require(path.join(__dirname, '..', 'lib', 'run-log.cjs'))
const { createErpFeedbackWriter } = require(path.join(__dirname, '..', 'lib', 'erp-feedback.cjs'))

const TENANT_ID = 'tenant_1'
const PROJECT_ID = 'project_1'

const READ_USER = {
  id: 'user_read',
  tenantId: TENANT_ID,
  permissions: ['integration:read'],
}

const WRITE_USER = {
  id: 'user_write',
  email: 'writer@example.test',
  tenantId: TENANT_ID,
  permissions: ['integration:write'],
}

const ADMIN_USER = {
  id: 'user_admin',
  tenantId: TENANT_ID,
  roles: ['admin'],
  permissions: ['integration:admin'],
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null
      },
    },
    async text() {
      return JSON.stringify(body)
    },
  }
}

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
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
        return jsonResponse(200, {
          success: false,
          code: 'K3_MATERIAL_INVALID',
          message: 'material code rejected',
        })
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
            updated_at: '2026-05-07T09:00:00.000Z',
          },
          {
            id: 'plm_bad',
            itemCode: ' bad-02 ',
            itemName: ' Bad material ',
            revision: 'A',
            unitName: 'PCS',
            updated_at: '2026-05-07T09:05:00.000Z',
          },
        ],
        metadata: { totalCount: 2 },
      }
    },
  }
}

function createMockContext() {
  const routes = new Map()
  return {
    context: {
      api: {
        http: {
          addRoute(method, routePath, handler) {
            routes.set(`${String(method).toUpperCase()} ${routePath}`, { method, path: routePath, handler })
          },
        },
      },
    },
    routes,
  }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

async function invoke(routes, method, routePath, req = {}) {
  const key = `${String(method).toUpperCase()} ${routePath}`
  const route = routes.get(key)
  assert.ok(route, `expected route ${key} to be registered`)
  const res = createResponse()
  await route.handler({
    user: req.user,
    authUser: req.authUser,
    body: req.body || {},
    query: req.query || {},
    params: req.params || {},
  }, res)
  assert.notEqual(res.body, undefined, `${key} produced a JSON body`)
  return res
}

function assertOkResponse(res, status) {
  assert.equal(res.statusCode, status)
  assert.equal(res.body.ok, true)
  assert.ok('data' in res.body)
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

  function matches(row, where = {}) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === undefined) return true
      if (value === null) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  function applyOptions(result, options = {}) {
    let selected = result.slice()
    if (Array.isArray(options.orderBy) && options.orderBy.length >= 2) {
      const [field, direction] = options.orderBy
      selected.sort((left, right) => {
        const a = left[field] || ''
        const b = right[field] || ''
        const order = a < b ? -1 : a > b ? 1 : 0
        return String(direction).toUpperCase() === 'DESC' ? -order : order
      })
    }
    if (Number.isInteger(options.offset) && options.offset > 0) {
      selected = selected.slice(options.offset)
    }
    if (Number.isInteger(options.limit) && options.limit > 0) {
      selected = selected.slice(0, options.limit)
    }
    return selected
  }

  return {
    tables,
    async selectOne(table, where) {
      return rows(table).find((row) => matches(row, where)) || null
    },
    async insertOne(table, row) {
      const stored = {
        ...row,
        created_at: row.created_at || '2026-05-07T10:00:00.000Z',
        updated_at: row.updated_at || '2026-05-07T10:00:00.000Z',
      }
      rows(table).push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      const row = rows(table).find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, set, {
        updated_at: set.updated_at || '2026-05-07T10:05:00.000Z',
      })
      return [row]
    },
    async select(table, options = {}) {
      return applyOptions(rows(table).filter((row) => matches(row, options.where || {})), options)
    },
  }
}

function normalizeWorkspaceId(value) {
  return value === undefined || value === null || value === '' ? null : String(value)
}

function publicExternalSystem(system) {
  if (!system) return null
  const safe = clone(system)
  delete safe.credentials
  delete safe.credentialsEncrypted
  safe.hasCredentials = Boolean(system.credentials || system.credentialsEncrypted)
  return safe
}

function createExternalSystemRegistry() {
  const systems = new Map()
  let nextSystem = 1

  function scoped(input = {}) {
    return {
      tenantId: input.tenantId,
      workspaceId: normalizeWorkspaceId(input.workspaceId),
    }
  }

  function inScope(system, input = {}) {
    const scope = scoped(input)
    return system.tenantId === scope.tenantId && normalizeWorkspaceId(system.workspaceId) === scope.workspaceId
  }

  return {
    async upsertExternalSystem(input = {}) {
      const id = input.id || `sys_${nextSystem++}`
      const existing = systems.get(id) || {}
      const stored = {
        ...existing,
        ...clone(input),
        id,
        workspaceId: normalizeWorkspaceId(input.workspaceId ?? existing.workspaceId),
      }
      systems.set(id, stored)
      return publicExternalSystem(stored)
    },
    async getExternalSystem(input = {}) {
      const system = systems.get(input.id)
      return system && inScope(system, input) ? publicExternalSystem(system) : null
    },
    async getExternalSystemForAdapter(input = {}) {
      const system = systems.get(input.id)
      return system && inScope(system, input) ? clone(system) : null
    },
    async listExternalSystems(input = {}) {
      return Array.from(systems.values())
        .filter((system) => inScope(system, input))
        .filter((system) => !input.kind || system.kind === input.kind)
        .filter((system) => !input.status || system.status === input.status)
        .map(publicExternalSystem)
    },
  }
}

function runFromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    pipelineId: row.pipeline_id,
    mode: row.mode,
    triggeredBy: row.triggered_by,
    status: row.status,
    rowsRead: row.rows_read,
    rowsCleaned: row.rows_cleaned,
    rowsWritten: row.rows_written,
    rowsFailed: row.rows_failed,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    durationMs: row.duration_ms ?? null,
    errorSummary: row.error_summary ?? null,
    details: row.details || {},
  }
}

function createPipelineRegistry(db) {
  const pipelines = new Map()
  let nextPipeline = 1
  let nextRun = 1

  function inScope(record, input = {}) {
    return record.tenantId === input.tenantId && normalizeWorkspaceId(record.workspaceId) === normalizeWorkspaceId(input.workspaceId)
  }

  return {
    async upsertPipeline(input = {}) {
      const id = input.id || `pipe_${nextPipeline++}`
      const existing = pipelines.get(id) || {}
      const stored = {
        ...existing,
        ...clone(input),
        id,
        workspaceId: normalizeWorkspaceId(input.workspaceId ?? existing.workspaceId),
      }
      pipelines.set(id, stored)
      return clone(stored)
    },
    async getPipeline(input = {}) {
      const pipeline = pipelines.get(input.id)
      return pipeline && inScope(pipeline, input) ? clone(pipeline) : null
    },
    async listPipelines(input = {}) {
      return Array.from(pipelines.values())
        .filter((pipeline) => inScope(pipeline, input))
        .filter((pipeline) => !input.status || pipeline.status === input.status)
        .filter((pipeline) => !input.sourceSystemId || pipeline.sourceSystemId === input.sourceSystemId)
        .filter((pipeline) => !input.targetSystemId || pipeline.targetSystemId === input.targetSystemId)
        .map(clone)
    },
    async createPipelineRun(input = {}) {
      const id = input.id || `run_${nextRun++}`
      const row = {
        id,
        tenant_id: input.tenantId,
        workspace_id: normalizeWorkspaceId(input.workspaceId),
        pipeline_id: input.pipelineId,
        mode: input.mode,
        triggered_by: input.triggeredBy,
        status: input.status,
        rows_read: 0,
        rows_cleaned: 0,
        rows_written: 0,
        rows_failed: 0,
        started_at: input.startedAt || null,
        finished_at: input.finishedAt || null,
        duration_ms: input.durationMs || null,
        error_summary: input.errorSummary || null,
        details: input.details || {},
      }
      await db.insertOne('integration_runs', row)
      return runFromRow(row)
    },
    async updatePipelineRun(input = {}) {
      const updated = await db.updateRow('integration_runs', {
        status: input.status,
        rows_read: input.rowsRead,
        rows_cleaned: input.rowsCleaned,
        rows_written: input.rowsWritten,
        rows_failed: input.rowsFailed,
        finished_at: input.finishedAt || null,
        duration_ms: input.durationMs,
        error_summary: input.errorSummary || null,
        details: input.details || {},
      }, {
        tenant_id: input.tenantId,
        workspace_id: normalizeWorkspaceId(input.workspaceId),
        id: input.id,
      })
      return updated[0] ? runFromRow(updated[0]) : null
    },
    async listPipelineRuns(input = {}) {
      const rows = await db.select('integration_runs', {
        where: {
          tenant_id: input.tenantId,
          workspace_id: normalizeWorkspaceId(input.workspaceId),
          pipeline_id: input.pipelineId || undefined,
          status: input.status || undefined,
        },
        orderBy: ['created_at', 'DESC'],
        limit: input.limit,
        offset: input.offset,
      })
      return rows.map(runFromRow)
    },
  }
}

function createHarness() {
  const db = createMockDb()
  const externalSystemRegistry = createExternalSystemRegistry()
  const pipelineRegistry = createPipelineRegistry(db)
  const k3FetchMock = createK3FetchMock()
  const feedbackUpdates = []
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('plm:yuantus-wrapper', createYuantusPlmWrapperAdapterFactory({ plmClient: createPlmClient() }))
    .registerAdapter('erp:k3-wise-webapi', createK3WiseWebApiAdapterFactory({ fetchImpl: k3FetchMock.fetchImpl }))

  const runLogger = createRunLogger({
    pipelineRegistry,
    clock: (() => {
      let tick = 0
      return () => `2026-05-07T10:00:${String(tick++).padStart(2, '0')}.000Z`
    })(),
  })

  const deadLetterStore = createDeadLetterStore({
    db,
    idGenerator: () => `dl_${db.tables.get('integration_dead_letters').length + 1}`,
  })

  const pipelineRunner = createPipelineRunner({
    pipelineRegistry,
    externalSystemRegistry,
    adapterRegistry,
    deadLetterStore,
    watermarkStore: createWatermarkStore({ db }),
    runLogger,
    erpFeedbackWriter: createErpFeedbackWriter({
      clock: () => '2026-05-07T11:00:00.000Z',
      stagingWriter: {
        async updateRecords(input) {
          feedbackUpdates.push(clone(input))
          return {
            ok: true,
            written: input.updates.length,
            patched: input.updates.length,
            created: 0,
          }
        },
      },
    }),
    clock: (() => {
      let tick = 0
      return () => tick++ * 25
    })(),
  })

  const stagingInstaller = {
    listStagingDescriptors() {
      return [
        { id: 'standard_materials', name: 'Standard Materials', fields: ['code', 'name'] },
        { id: 'bom_cleanse', name: 'BOM Cleanse', fields: ['parentCode', 'childCode'] },
      ]
    },
    async installStaging(input = {}) {
      return {
        tenantId: input.tenantId,
        workspaceId: normalizeWorkspaceId(input.workspaceId),
        projectId: input.projectId,
        sheetIds: {
          standard_materials: 'sheet_materials',
          bom_cleanse: 'sheet_bom',
        },
        warnings: [],
      }
    },
  }

  const { context, routes } = createMockContext()
  registerIntegrationRoutes({
    context,
    services: {
      externalSystemRegistry,
      adapterRegistry,
      pipelineRegistry,
      pipelineRunner,
      deadLetterStore,
      stagingInstaller,
    },
    logger: {
      warn() {},
      error() {},
      info() {},
    },
  })

  return {
    db,
    feedbackUpdates,
    k3FetchMock,
    routes,
  }
}

function materialPipelineBody({ sourceSystemId, targetSystemId }) {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: 'PLM material to K3 WISE route PoC',
    sourceSystemId,
    sourceObject: 'materials',
    targetSystemId,
    targetObject: 'material',
    mode: 'incremental',
    status: 'active',
    idempotencyKeyFields: ['sourceId', 'revision'],
    options: {
      batchSize: 10,
      watermark: { type: 'updated_at', field: 'updatedAt' },
      target: { autoSubmit: false, autoAudit: false },
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
}

async function createRouteControlPlaneScenario(routes) {
  let res = await invoke(routes, 'POST', '/api/integration/external-systems', {
    user: WRITE_USER,
    body: {
      tenantId: TENANT_ID,
      name: 'Yuantus PLM',
      kind: 'plm:yuantus-wrapper',
      role: 'source',
      status: 'active',
      config: {},
    },
  })
  assertOkResponse(res, 201)
  const plm = res.body.data
  assert.equal(plm.credentials, undefined)

  res = await invoke(routes, 'POST', '/api/integration/external-systems', {
    user: WRITE_USER,
    body: {
      tenantId: TENANT_ID,
      name: 'K3 WISE WebAPI',
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
    },
  })
  assertOkResponse(res, 201)
  const k3 = res.body.data
  assert.equal(k3.credentials, undefined)
  assert.equal(k3.hasCredentials, true)

  res = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITE_USER,
    params: { id: plm.id },
    body: { tenantId: TENANT_ID },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.ok, true)
  assert.equal(res.body.data.system.credentials, undefined)

  res = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITE_USER,
    params: { id: k3.id },
    body: { tenantId: TENANT_ID },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.ok, true)
  assert.equal(res.body.data.system.credentials, undefined)

  res = await invoke(routes, 'POST', '/api/integration/staging/install', {
    user: WRITE_USER,
    body: {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    },
  })
  assertOkResponse(res, 201)
  assert.equal(res.body.data.sheetIds.standard_materials, 'sheet_materials')

  res = await invoke(routes, 'POST', '/api/integration/pipelines', {
    user: WRITE_USER,
    body: materialPipelineBody({
      sourceSystemId: plm.id,
      targetSystemId: k3.id,
    }),
  })
  assertOkResponse(res, 201)
  return {
    plm,
    k3,
    pipeline: res.body.data,
  }
}

async function main() {
  const harness = createHarness()
  const scenario = await createRouteControlPlaneScenario(harness.routes)

  let res = await invoke(harness.routes, 'POST', '/api/integration/pipelines/:id/dry-run', {
    user: WRITE_USER,
    params: { id: scenario.pipeline.id },
    body: {
      tenantId: TENANT_ID,
      mode: 'incremental',
      sampleLimit: 2,
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.metrics.rowsRead, 2)
  assert.equal(res.body.data.metrics.rowsCleaned, 2)
  assert.equal(res.body.data.metrics.rowsWritten, 0)
  assert.equal(res.body.data.metrics.rowsFailed, 0)
  assert.equal(res.body.data.preview.records.length, 2)
  assert.equal(harness.k3FetchMock.calls.some((call) => call.pathname === '/K3API/Material/Save'), false)
  assert.equal(harness.db.tables.get('integration_dead_letters').length, 0)
  assert.equal(harness.feedbackUpdates.length, 0)

  res = await invoke(harness.routes, 'POST', '/api/integration/pipelines/:id/run', {
    user: WRITE_USER,
    params: { id: scenario.pipeline.id },
    body: {
      tenantId: TENANT_ID,
      mode: 'incremental',
    },
  })
  assertOkResponse(res, 202)
  assert.equal(res.body.data.run.status, 'partial')
  assert.equal(res.body.data.metrics.rowsRead, 2)
  assert.equal(res.body.data.metrics.rowsCleaned, 2)
  assert.equal(res.body.data.metrics.rowsWritten, 1)
  assert.equal(res.body.data.metrics.rowsFailed, 1)

  const saveCalls = harness.k3FetchMock.calls.filter((call) => call.pathname === '/K3API/Material/Save')
  assert.equal(saveCalls.length, 2)
  assert.deepEqual(saveCalls.map((call) => call.body.Model.FNumber), ['GOOD-01', 'BAD-02'])
  assert.equal(harness.k3FetchMock.calls.some((call) => call.pathname === '/K3API/Material/Submit'), false)
  assert.equal(harness.k3FetchMock.calls.some((call) => call.pathname === '/K3API/Material/Audit'), false)

  assert.equal(harness.feedbackUpdates.length, 1)
  assert.equal(harness.feedbackUpdates[0].projectId, PROJECT_ID)
  assert.equal(harness.feedbackUpdates[0].objectId, 'standard_materials')
  assert.equal(harness.feedbackUpdates[0].updates.length, 2)
  const synced = harness.feedbackUpdates[0].updates.find((update) => update.status === 'synced')
  const failed = harness.feedbackUpdates[0].updates.find((update) => update.status === 'failed')
  assert.equal(synced.fields.erpSyncStatus, 'synced')
  assert.equal(synced.fields.erpExternalId, 'k3_GOOD-01')
  assert.equal(synced.fields.erpBillNo, 'BILL-GOOD-01')
  assert.equal(failed.fields.erpSyncStatus, 'failed')
  assert.equal(failed.fields.erpResponseCode, 'K3_MATERIAL_INVALID')

  res = await invoke(harness.routes, 'GET', '/api/integration/runs', {
    user: READ_USER,
    query: {
      tenantId: TENANT_ID,
      pipelineId: scenario.pipeline.id,
    },
  })
  assertOkResponse(res, 200)
  assert.deepEqual(new Set(res.body.data.map((run) => run.status)), new Set(['succeeded', 'partial']))

  res = await invoke(harness.routes, 'GET', '/api/integration/dead-letters', {
    user: READ_USER,
    query: {
      tenantId: TENANT_ID,
      pipelineId: scenario.pipeline.id,
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.length, 1)
  assert.equal(res.body.data[0].errorCode, 'K3_MATERIAL_INVALID')
  assert.equal(res.body.data[0].payloadRedacted, true)
  assert.equal(res.body.data[0].sourcePayload, undefined)
  assert.equal(res.body.data[0].transformedPayload, undefined)

  res = await invoke(harness.routes, 'GET', '/api/integration/dead-letters', {
    user: ADMIN_USER,
    query: {
      tenantId: TENANT_ID,
      pipelineId: scenario.pipeline.id,
      includePayload: 'true',
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.length, 1)
  assert.equal(res.body.data[0].sourcePayload.code, ' bad-02 ')
  assert.equal(res.body.data[0].sourcePayload.rawPayload, '[redacted]')
  assert.equal(res.body.data[0].transformedPayload.FNumber, 'BAD-02')
  assert.equal(res.body.data[0].payloadRedacted, true)

  console.log('✓ http-routes-plm-k3wise-poc: REST PLM -> K3 WISE mock control-plane chain passed')
}

main().catch((err) => {
  console.error('✗ http-routes-plm-k3wise-poc FAILED')
  console.error(err)
  process.exit(1)
})
