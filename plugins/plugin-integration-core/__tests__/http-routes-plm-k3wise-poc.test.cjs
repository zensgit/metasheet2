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
      const number = (body.Model || body.Data).FNumber
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
    async deleteExternalSystem(input = {}) {
      const system = systems.get(input.id)
      if (!system || !inScope(system, input)) return null
      systems.delete(input.id)
      return publicExternalSystem(system)
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

function createHarness({ readSourceConfigStore } = {}) {
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
      templateRegistry: {
        async upsertTemplate() { return {} },
        async getTemplate() { return {} },
        async listTemplates() { return [] },
        async deleteTemplate() { return { deleted: 0 } },
        async instantiateTemplate() { return {} },
      },
      // S2-c: satisfy requireService('readSourceConfigStore', ...). REVIEW P2-1 (round 9): this
      // used to say "this harness never exercises it", and that was the gap — the B4 consumption
      // SCOPE (tenant / workspace / pipeline-endpoint relation) is built in
      // resolveC6WritePlanInputs and was verified only by a COPY of it in the profile suite, so
      // fail-open widenings there stayed green. An injectable store lets a test drive the REAL
      // route and observe the real scope.
      readSourceConfigStore: readSourceConfigStore || {
        async saveVersion() { return {} },
        async list() { return [] },
        async get() { return {} },
        async approve() { return {} },
        async retire() { return {} },
        async listAudit() { return [] },
        async getForRuntime() { return {} },
      },
      // C-R4-1: satisfy requireService('readSourceCompositionConfigStore', ...) — this
      // K3 PoC harness never exercises composition routes.
      readSourceCompositionConfigStore: {
        async saveVersion() { return {} },
        async list() { return [] },
        async get() { return {} },
        async approve() { return {} },
        async retire() { return {} },
        async listAudit() { return [] },
        async getForRuntime() { return {} },
      },
      // BA-APPLY-2a: satisfy requireService('bridgeAgentChecklistStore', ...) — this harness never
      // exercises the checklist routes.
      bridgeAgentChecklistStore: {
        async saveVersion() { return {} },
        async approve() { return {} },
        async retire() { return {} },
        async getForApply() { return {} },
      },
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
        // RATIFIED (owner, 20260805): material writes require the named customer profile.
        objects: { material: { profile: 'material-k3wise-customer-profile-v1' } },
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

// REVIEW P2-1 (round 9): the B4 consumption SCOPE is assembled in http-routes'
// `resolveC6WritePlanInputs` — tenantId, workspaceId, and the pipeline-endpoint relation. That
// function is not exported, and the profile suite assembles the same object itself ("exactly the
// way http-routes does"), so it judged a COPY: five anchored mutations to the real call sites —
// including two FAIL-OPEN ones (workspaceId collapsed to null; pipelineSystemIds widened with an
// unrelated system) — left every suite green. The second reinstates the round-3 defect of one
// system's read contract vouching for another system's write.
//
// This drives the REAL route and observes the REAL scope object.
const PROBE_WORKSPACE_ID = 'ws_b4_probe'

async function assertB4ScopeIsWiredThroughTheRoute() {
  const {
    K3WISE_MATERIAL_LIST_B4_TEMPLATE,
  } = require(path.join(__dirname, '..', 'lib', 'read-source-k3-material-list-b4-contract.cjs'))
  const { contentKeyFor } = require(path.join(__dirname, '..', 'lib', 'read-source-config-store.cjs'))
  const { normalizeReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))

  function ratifiedRow({ systemId, workspaceId = 'ws_k3_poc' }) {
    const config = { ...K3WISE_MATERIAL_LIST_B4_TEMPLATE, systemId }
    return {
      id: `rsc_${systemId}`,
      object: 'material',
      status: 'approved',
      workspaceId,
      config,
      contentKey: contentKeyFor(normalizeReadSourceConfig(config)),
    }
  }

  // `rows` is what the store returns; `listArgs` records what the ROUTE asked for.
  async function dryRunWith(rows, { requestWorkspaceId, pairedReadBaseUrl } = {}) {
    const listArgs = []
    const harness = createHarness({
      readSourceConfigStore: {
        async saveVersion() { return {} },
        async list(args) { listArgs.push(args); return rows(harnessScenario) },
        async get() { return {} },
        async approve() { return {} },
        async retire() { return {} },
        async listAudit() { return [] },
        async getForRuntime() { return {} },
      },
    })
    // Minimal WORKSPACE-SCOPED scenario, built here rather than by bending the shared PoC one:
    // the probe needs a workspace-scoped pipeline (against a null-workspace pipeline, "collapse
    // workspaceId to null" is indistinguishable from correct behaviour), and a workspace-scoped
    // pipeline resolves only workspace-scoped systems.
    const mkSystem = async (body) => {
      const r = await invoke(harness.routes, 'POST', '/api/integration/external-systems', {
        user: WRITE_USER,
        body: { workspaceId: PROBE_WORKSPACE_ID, tenantId: TENANT_ID, ...body },
      })
      assertOkResponse(r, 201)
      return r.body.data
    }
    const plm = await mkSystem({
      name: 'PLM probe', kind: 'plm:yuantus-wrapper', role: 'source', status: 'active', config: {},
    })
    // OWNER REVIEW 20260806 [P1]: the real customer topology is THREE records — a staging/PLM
    // source, a K3 READ record, and a K3 WRITE target. Without the read record in this harness the
    // same-instance check could only ever be handed the target twice, which is exactly how it came
    // to compare the target with itself and pass.
    const k3Read = pairedReadBaseUrl === undefined ? null : await mkSystem({
      name: 'K3 read probe', kind: 'erp:k3-wise-webapi', role: 'source', status: 'active',
      config: { baseUrl: pairedReadBaseUrl },
      credentials: { username: 'demo', password: 'secret', acctId: '001' },
    })
    const k3 = await mkSystem({
      name: 'K3 probe', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active',
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: false,
        autoAudit: false,
        objects: { material: { profile: 'material-k3wise-customer-profile-v1' } },
        ...(k3Read ? { pairedReadSystemId: k3Read.id } : {}),
      },
      credentials: { username: 'demo', password: 'secret', acctId: '001' },
    })
    assert.equal(plm.workspaceId, PROBE_WORKSPACE_ID, 'the probe systems must actually be workspace-scoped')
    const mkPipeline = await invoke(harness.routes, 'POST', '/api/integration/pipelines', {
      user: WRITE_USER,
      body: {
        ...materialPipelineBody({ sourceSystemId: plm.id, targetSystemId: k3.id }),
        workspaceId: PROBE_WORKSPACE_ID,
        name: 'B4 scope wiring probe',
        // The PoC mappings include sourceId/revision, which the C6 field allowlist correctly
        // refuses — the dry-run would never reach the B4 branch.
        fieldMappings: [
          { sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] },
          { sourceField: 'name', targetField: 'FName', validation: [{ type: 'required' }] },
        ],
      },
    })
    assertOkResponse(mkPipeline, 201)
    assert.equal(mkPipeline.body.data.workspaceId, PROBE_WORKSPACE_ID,
      'the probe pipeline must be workspace-scoped, or the workspaceId assertion cannot discriminate')
    const harnessScenario = { plm, k3, k3Read, pipeline: mkPipeline.body.data }
    const res = await invoke(harness.routes, 'POST', '/api/integration/pipelines/:id/external-write/dry-run', {
      user: WRITE_USER,
      params: { id: mkPipeline.body.data.id },
      body: { tenantId: TENANT_ID, workspaceId: requestWorkspaceId || PROBE_WORKSPACE_ID },
    })
    return { res, listArgs, scenario: harnessScenario }
  }

  // (1) THE SCOPE THE ROUTE ASKS FOR. Kills the "drop readSourceConfigs" and "*ANY*" mutations:
  // if the wiring stops passing the store, nothing is recorded here.
  const seen = await dryRunWith(() => [])
  assert.ok(seen.listArgs.length >= 1,
    'the route must consult the read-source config store for the B4 binding — nothing was asked')
  const args = seen.listArgs[0]
  assert.equal(args.tenantId, TENANT_ID, 'B4 lookup must be scoped to the PIPELINE tenant')
  assert.equal(args.status, 'approved', 'only approved bindings may be consulted')
  assert.equal(args.limit, 500, 'the bounded page limit must reach the store')
  // EXACT value, not merely present: collapsing this to a constant `null` is a FAIL-OPEN
  // widening (a tenant-level binding would vouch for a workspace-scoped pipeline).
  assert.equal(args.workspaceId, PROBE_WORKSPACE_ID,
    'the workspace scope must be the PIPELINE\'s workspace, not a constant')

  // (2) FAIL-OPEN #1 — a binding for an UNRELATED system must not satisfy the gate. This is the
  // one that reinstates "one system's read contract vouching for another system's write".
  const foreign = await dryRunWith(() => [ratifiedRow({ systemId: 'some-other-system-entirely' })])
  const foreignErr = (foreign.res.body && foreign.res.body.error) || {}
  const foreignDetails = foreignErr.details || {}
  // Assert the COUNT, not merely "it failed": widening pipelineSystemIds makes this binding
  // COUNT, and the dry-run may still fail downstream for an unrelated reason — a bare
  // `status !== 200` passes either way and proves nothing. (It did: M15/M18 survived it.)
  assert.equal(foreignDetails.code, 'C6_WRITE_B4_BINDING_REQUIRED',
    `an unrelated system's binding must leave the gate unsatisfied, got: ${JSON.stringify(foreignErr)}`)
  assert.equal(foreignDetails.bindingCount, 0,
    'an unrelated system\'s binding must not be COUNTED — this is the round-3 defect (one system vouching for another)')

  // (3) POSITIVE CONTROL — the same shape bound to a real pipeline endpoint behaves DIFFERENTLY.
  // Without this, a route that refused every dry-run would satisfy (2).
  // (4) THE APPLY CALL SITE. Behavioural coverage of apply would need a fully successful K3
  // dry-run in this harness (credentials, source rows, token) — not achieved here, and stated
  // rather than glossed. Dropping `readSourceConfigs` on apply fails CLOSED (the apply recompute
  // re-runs the same gate and refuses), so this is "the feature silently dies", not a security
  // hole. It is covered STRUCTURALLY: both call sites must pass the same inputs, and the
  // positive control below proves the check can actually fail.
  const routesSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'http-routes.cjs'), 'utf8')
  // `= ` anchors this to CALL SITES: the declaration `function resolveC6WritePlanInputs({...})`
  // otherwise matched too and made the count 3 (the same trap the requestJson enumeration hit).
  const callSites = [...routesSrc.matchAll(/= resolveC6WritePlanInputs\(\{([^}]*)\}\)/g)].map((m) => m[1])
  assert.equal(callSites.length, 2, `expected the dry-run and apply call sites, found ${callSites.length}`)
  assert.deepEqual(callSites[0].split(',').map((t) => t.trim()).filter(Boolean).sort(),
    callSites[1].split(',').map((t) => t.trim()).filter(Boolean).sort(),
    'the apply call site must pass the SAME inputs as dry-run, or the revision fence compares different plans')
  assert.ok(callSites.every((site) => /\breadSourceConfigs\b/.test(site)),
    'both call sites must pass readSourceConfigs — without it the B4 gate is unreachable')
  // POSITIVE CONTROL for the structural check itself.
  assert.equal(/\breadSourceConfigs\b/.test('{ targetSystem, pipeline, context }'), false,
    'the structural check must be able to FAIL — otherwise it asserts nothing')

  // (5) REVIEW P3-3 (round 10): `http-routes.cjs` states the B4 scope is "never request-sourced",
  // and nothing tested it — the probe body carried the SAME values as the pipeline, so it could
  // not discriminate. The protective mechanism is upstream: the pipeline is resolved by an EXACT
  // scope match, so a request claiming a different workspace never reaches the B4 branch at all.
  // Assert that, rather than the comment's wording.
  const spoofed = await dryRunWith(() => [], { requestWorkspaceId: 'ws_attacker_supplied' })
  // The load-bearing assertion. Neutering the upstream scope match makes this RED.
  assert.equal(spoofed.listArgs.length, 0,
    'a request claiming a different workspace must not even reach the B4 lookup')
  // NOT an independent assertion, and labelled rather than dropped: in this harness NO
  // configuration of this route returns 200 (an honest call with 0 rows is 400; with a ratified
  // row it is 500 on missing credentials), so `!== 200` is true by fixture construction. Kept
  // only as a shape guard; the line above is what carries the property.
  assert.notEqual(spoofed.res.statusCode, 200, 'and it must not succeed (vacuous here — see above)')

  // (6) SAME-INSTANCE, THROUGH THE ROUTE. Mutation N3 exposed this gap: http-routes stopped
  // passing `targetBaseUrl` and BOTH suites stayed green — the check was tested, its WIRING was
  // not. Fifth occurrence of that pattern on this line.
  //
  // The witness is exact: a B4 row bound to the PLM SOURCE passes #4769's relation check (the
  // source IS a pipeline endpoint), so only the same-instance check can stop it — and it must,
  // because PLM is not the K3 being written. This is the round-3 defect in its newest disguise:
  // one system's read contract certifying another system's write.
  //
  // EXACT-HEAD REVIEW P2-2 — why this now expects KIND, not INSTANCE. The reviewer showed this
  // assertion was passing for the WRONG REASON: the PLM fixture carries `config: {}`, so
  // `boundBaseUrl` was null and the gate took its "cannot tell" branch. It never exercised the
  // "different instance" branch its own message named. Worse, the reviewer gave the PLM source a
  // baseUrl SHARING the K3 target's origin and the binding was ACCEPTED — a PLM read contract
  // certified the K3 write, failing only later at the read with a misleading 404. Origin equality
  // says nothing about WHAT is at that origin, and on-prem PLM and K3 routinely share a host.
  //
  // The guard now checks the bound record's `kind` first, so a PLM binding is refused for being
  // PLM — which is both the true reason and the one that still holds when the origins match.
  const crossInstance = await dryRunWith((sc) => [ratifiedRow({ systemId: sc.pipeline.sourceSystemId })])
  const crossErr = ((crossInstance.res.body && crossInstance.res.body.error) || {})
  assert.equal(crossErr.details && crossErr.details.code, 'K3_C6_B4_BINDING_KIND_MISMATCH',
    `a binding on the PLM source must be refused because it is not a K3 record, got: ${JSON.stringify(crossErr)}`)

  // (6b) OWNER REVIEW 20260806 [P1] — THE READ/WRITE COMPARISON ITSELF.
  //
  // Everything above binds B4 to the TARGET, which is how the check came to compare the target
  // with itself: the driver made a separate K3 read record, minted B4 on the target, and the route
  // loaded targetBaseUrl from that same target — so no read record ever entered the comparison and
  // two different K3 instances would have passed. These two cases bind B4 to the REAL READ RECORD
  // (admitted by the relation check because the target declares it as pairedReadSystemId) so the
  // guard compares two GENUINELY DIFFERENT records.
  //
  // A -> A: read and write on the same physical K3 (same origin, different path — the step 0-b
  // topology). MUST BE ACCEPTED. Without this control the negative case below could be satisfied
  // by a guard that simply refuses everything.
  const pairedSameInstance = await dryRunWith(
    (sc) => [ratifiedRow({ systemId: sc.k3Read.id })],
    { pairedReadBaseUrl: 'https://k3.example.test/K3API-READ' },
  )
  const pairedSameErr = ((pairedSameInstance.res.body && pairedSameInstance.res.body.error) || {}).details || {}
  assert.notEqual(pairedSameErr.code, 'K3_C6_B4_BINDING_INSTANCE_MISMATCH',
    `a binding on the paired read record of the SAME K3 must be accepted, got: ${JSON.stringify(pairedSameErr)}`)
  assert.notEqual(pairedSameErr.code, 'C6_WRITE_B4_BINDING_REQUIRED',
    'the paired read record must COUNT toward the relation check, or B4 can never bind the real reader')

  // A -> B: read record on a DIFFERENT K3 host. MUST BE REFUSED. This is the case the old
  // arrangement was structurally incapable of producing at all.
  const crossK3 = await dryRunWith(
    (sc) => [ratifiedRow({ systemId: sc.k3Read.id })],
    { pairedReadBaseUrl: 'https://k3-OTHER.example.test/K3API' },
  )
  const crossK3Err = ((crossK3.res.body && crossK3.res.body.error) || {}).details || {}
  assert.equal(crossK3Err.code, 'K3_C6_B4_BINDING_INSTANCE_MISMATCH',
    `a read record on ANOTHER K3 must not certify this write, got: ${JSON.stringify(crossK3Err)}`)

  // (7) THE DISCRIMINATING HALF. (6) alone does not prove the wiring: with `targetBaseUrl`
  // missing, sameK3Instance('') is false, so the gate throws MORE and (6) still passes. What
  // breaks when the wiring is gone is the LEGITIMATE case — a binding on the K3 TARGET, the
  // same physical instance, must be ACCEPTED. Mutation N3 (http-routes stops passing
  // targetBaseUrl) is RED on this assertion and only this one.
  const sameInstance = await dryRunWith((sc) => [ratifiedRow({ systemId: sc.pipeline.targetSystemId })])
  const sameErr = ((sameInstance.res.body && sameInstance.res.body.error) || {})
  assert.notEqual(sameErr.details && sameErr.details.code, 'K3_C6_B4_BINDING_INSTANCE_MISMATCH',
    'a binding on the K3 TARGET is the same physical K3 and must NOT be refused as cross-instance')

  const related = await dryRunWith((sc) => [ratifiedRow({ systemId: sc.pipeline.sourceSystemId })])
  const relatedDetails = ((related.res.body && related.res.body.error) || {}).details || {}
  assert.notEqual(relatedDetails.bindingCount, 0,
    'a binding on a real pipeline endpoint MUST be counted — otherwise the check above passes vacuously')
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

  // --- OWNER REVIEW P1 (20260805) DELIBERATE FLIP -----------------------------------------
  // Mirrors e2e-plm-k3wise-writeback.test.cjs's handling of the same guard.
  // pipeline-runner.cjs's loadPipelineContext now fails closed on ANY non-dryRun runPipeline
  // against a K3 WISE target (details.code === 'K3_WISE_PIPELINE_RUN_DISABLED', thrown before
  // any adapter is created / any read or write happens) — the C6 dry-run -> approval-token ->
  // apply lifecycle is the ONLY sanctioned K3 write entry point now. This live POST
  // .../pipelines/:id/run call used to reach K3 Material/Save for both records and come back
  // 202/partial (1 written GOOD-01 + 1 failed BAD-02, with matching ERP feedback rows); that
  // path is refused before any of that happens. Disposition:
  //   1. [FLIP 20260625->] Prove the refusal itself over HTTP: 422, envelope
  //      { ok:false, error:{ code:'PipelineRunnerError', details:{ code:
  //      'K3_WISE_PIPELINE_RUN_DISABLED' } } } (exact field path confirmed against a live run
  //      of this harness — inferErrorCode() in http-routes.cjs falls back to error.name since
  //      PipelineRunnerError never sets a top-level .code, so the machine-readable code lives
  //      at error.details.code, not error.code) — with zero K3 Save/Submit/Audit calls, zero
  //      ERP feedback writes, zero dead letters, and zero new run rows.
  //   2. NOT reconstructed here: the live write's aggregate run-record semantics
  //      (status='partial', rowsWritten=1/rowsFailed=1), the exact K3 Material/Save request
  //      sequence (['GOOD-01','BAD-02']), and the synced/failed ERP-feedback field values
  //      (erpExternalId/erpBillNo/erpResponseCode). These are generic, non-route-specific
  //      mechanisms already covered elsewhere with real assertions: 'partial'-status run-record
  //      aggregation via a mock (non-K3) target in pipeline-runner.test.cjs (e.g. its line-426
  //      `assert.equal(first.run.status, 'partial')` and siblings), the K3 Save request body /
  //      FNumber sequence via direct adapter.upsert() calls in k3-wise-c6-write-profile.test.cjs
  //      and k3-wise-apply-row-limit.test.cjs, and the synced/failed erpFeedback field mapping
  //      via a direct feedbackWriter.writeBack() call in e2e-plm-k3wise-writeback.test.cjs's own
  //      post-flip body. Re-deriving any of those here would just re-test those other harnesses,
  //      not additional product code for this route, so they are not duplicated in this file.
  res = await invoke(harness.routes, 'POST', '/api/integration/pipelines/:id/run', {
    user: WRITE_USER,
    params: { id: scenario.pipeline.id },
    body: {
      tenantId: TENANT_ID,
      mode: 'incremental',
    },
  })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'PipelineRunnerError')
  assert.equal(res.body.error.details.code, 'K3_WISE_PIPELINE_RUN_DISABLED')

  assert.equal(harness.k3FetchMock.calls.some((call) => call.pathname === '/K3API/Material/Save'), false)
  assert.equal(harness.k3FetchMock.calls.some((call) => call.pathname === '/K3API/Material/Submit'), false)
  assert.equal(harness.k3FetchMock.calls.some((call) => call.pathname === '/K3API/Material/Audit'), false)
  assert.equal(harness.feedbackUpdates.length, 0)
  assert.equal(harness.db.tables.get('integration_dead_letters').length, 0,
    'the guard fires before any write attempt — the refused live run leaves no dead letter')
  assert.equal(harness.db.tables.get('integration_runs').length, 1,
    'guard fires in loadPipelineContext, before runLogger.startRun — only the earlier dry run has a row')

  res = await invoke(harness.routes, 'GET', '/api/integration/runs', {
    user: READ_USER,
    query: {
      tenantId: TENANT_ID,
      pipelineId: scenario.pipeline.id,
    },
  })
  assertOkResponse(res, 200)
  // [FLIP 20260625->] ORIGINAL SEMANTICS: two run rows here (dry-run 'succeeded' + live-run
  // 'partial'). NEW CARRIER (converged to actual runtime output, confirmed by a live run of
  // this harness): the live run above wrote no run row at all, so only the earlier dry run's
  // 'succeeded' row survives.
  assert.equal(res.body.data.length, 1)
  assert.deepEqual(new Set(res.body.data.map((run) => run.status)), new Set(['succeeded']))

  // [FLIP 20260625->] dead-letter generation, to feed the (preserved, unchanged below) redaction
  // assertions. ORIGINAL SEMANTICS: the live run hit K3 Material/Save with the BAD-02 record and
  // got back { success: false, code: 'K3_MATERIAL_INVALID', message: 'material code rejected' };
  // pipeline-runner's writeDeadLetter() then persisted sourcePayload = sanitizeIntegrationPayload
  // of the PLM-normalized source record (code:'bad-02', rawPayload redacted to '[redacted]' by
  // payload-redaction.cjs's SENSITIVE_PAYLOAD_KEYS) and transformedPayload = the K3-shaped record
  // (FNumber:'BAD-02'). NEW CARRIER: that live path is refused now, so insert the identically-
  // shaped dead letter directly through a fresh createDeadLetterStore bound to the SAME mock db
  // the harness's routes read from (same technique as e2e-plm-k3wise-writeback.test.cjs's
  // directDeadLetters / pipeline-runner.test.cjs's k3Letters.createDeadLetter() direct-insert).
  // createDeadLetter() re-applies sanitizeIntegrationPayload itself (see dead-letter.cjs's
  // normalizeJsonPayload), so rawPayload is redacted to '[redacted]' by the store exactly as the
  // live path would have produced it — not pre-redacted by this test.
  const directDeadLetters = createDeadLetterStore({
    db: harness.db,
    idGenerator: () => `dl_direct_${harness.db.tables.get('integration_dead_letters').length + 1}`,
  })
  await directDeadLetters.createDeadLetter({
    tenantId: TENANT_ID,
    workspaceId: null,
    runId: 'run_direct_bad02',
    pipelineId: scenario.pipeline.id,
    sourcePayload: {
      sourceSystemId: scenario.plm.id,
      sourceId: 'plm_bad',
      objectType: 'material',
      code: 'bad-02',
      name: 'Bad material',
      revision: 'A',
      uom: 'PCS',
      status: 'active',
      updatedAt: '2026-05-07T09:05:00.000Z',
      rawPayload: {
        id: 'plm_bad',
        itemCode: ' bad-02 ',
        itemName: ' Bad material ',
        revision: 'A',
        unitName: 'PCS',
        updated_at: '2026-05-07T09:05:00.000Z',
      },
    },
    transformedPayload: {
      FNumber: 'BAD-02',
      FName: 'Bad material',
      sourceId: 'plm_bad',
      revision: 'A',
      _integration_idempotency_key: 'BAD-02|A',
    },
    errorCode: 'K3_MATERIAL_INVALID',
    errorMessage: 'material code rejected',
  })

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
  assert.equal(res.body.data[0].sourcePayload.code, 'bad-02')
  assert.equal(res.body.data[0].sourcePayload.rawPayload, '[redacted]')
  assert.equal(res.body.data[0].transformedPayload.FNumber, 'BAD-02')
  assert.equal(res.body.data[0].payloadRedacted, true)

  await assertB4ScopeIsWiredThroughTheRoute()

  console.log('✓ http-routes-plm-k3wise-poc: REST PLM -> K3 WISE mock control-plane chain passed')
}

main().catch((err) => {
  console.error('✗ http-routes-plm-k3wise-poc FAILED')
  console.error(err)
  process.exit(1)
})
