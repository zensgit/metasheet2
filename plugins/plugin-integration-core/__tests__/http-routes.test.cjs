'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const HTTP_ROUTES_PATH = path.join(__dirname, '..', 'lib', 'http-routes.cjs')
const httpRoutes = require(HTTP_ROUTES_PATH)
const { MAX_LIST_LIMIT } = httpRoutes
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))
const STOCK_PREPARATION_RESOLVED_FIELD_ID_MAP = Object.fromEntries(
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, `fld_${field.id}`]),
)

const READ_USER = {
  id: 'user_read',
  tenantId: 'tenant_1',
  permissions: ['integration:read'],
}

const WRITE_USER = {
  id: 'user_write',
  email: 'writer@example.test',
  tenantId: 'tenant_1',
  permissions: ['integration:write'],
}

const ADMIN_USER = {
  id: 'user_admin',
  tenantId: 'tenant_1',
  roles: ['admin'],
  permissions: ['integration:admin'],
}

function createMemoryStorage() {
  const map = new Map()
  return {
    map,
    async get(key) {
      return map.get(key) || null
    },
    async set(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)))
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

function createMockContext(options = {}) {
  const routes = new Map()
  const records = options.recordsApi || {
    async queryRecords() { return [] },
    async createRecord() { throw new Error('createRecord not configured in test context') },
    async patchRecord() { throw new Error('patchRecord not configured in test context') },
  }
  const provisioning = options.provisioningApi || {
    async findObjectSheet() { return null },
    async resolveFieldIds() { return {} },
    async ensureObject() { throw new Error('ensureObject not configured in test context') },
  }

  return {
    context: {
      api: {
        http: {
          addRoute(method, routePath, handler) {
            assert.equal(typeof method, 'string', 'method is a string')
            assert.equal(typeof routePath, 'string', 'path is a string')
            assert.equal(typeof handler, 'function', 'handler is a function')
            routes.set(`${method.toUpperCase()} ${routePath}`, { method, path: routePath, handler })
          },
        },
        multitable: {
          provisioning,
          records,
        },
      },
      storage: options.storage || createMemoryStorage(),
      config: options.config || {},
    },
    routes,
  }
}

function mergeServiceOverrides(target, overrides) {
  for (const [key, value] of Object.entries(overrides || {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      Object.assign(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}

function createMockServices(overrides = {}) {
  const calls = []
  const system = {
    id: 'sys_1',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    projectId: 'project_1',
    name: 'K3 WISE',
    kind: 'erp',
    role: 'target',
    status: 'active',
    hasCredentials: true,
  }
  const pipeline = {
    id: 'pipe_1',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    name: 'Material sync',
    status: 'active',
    sourceSystemId: 'plm_1',
    targetSystemId: 'sys_1',
    fieldMappings: [],
  }
  const run = {
    id: 'run_1',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    pipelineId: 'pipe_1',
    status: 'succeeded',
    rowsRead: 2,
    rowsWritten: 2,
  }
  const deadLetter = {
    id: 'dl_1',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    runId: 'run_1',
    pipelineId: 'pipe_1',
    status: 'open',
    errorCode: 'VALIDATION_FAILED',
    sourcePayload: {
      code: 'MAT-001',
      password: 'source-secret',
      headers: { Authorization: 'Bearer source-token' },
    },
    transformedPayload: {
      FNumber: 'MAT-001',
      token: 'target-token',
    },
  }

  const services = {
    externalSystemRegistry: {
      async listExternalSystems(input) {
        calls.push(['listExternalSystems', input])
        return [system]
      },
      async upsertExternalSystem(input) {
        calls.push(['upsertExternalSystem', input])
        return { ...system, ...input, id: input.id || system.id }
      },
      async getExternalSystem(input) {
        calls.push(['getExternalSystem', input])
        return { ...system, id: input.id }
      },
      async deleteExternalSystem(input) {
        calls.push(['deleteExternalSystem', input])
        return { deleted: true, system: { ...system, id: input.id } }
      },
      async getExternalSystemForAdapter(input) {
        calls.push(['getExternalSystemForAdapter', input])
        return { ...system, id: input.id, credentials: { bearerToken: 'secret-token' } }
      },
    },
    adapterRegistry: {
      listAdapterKinds() {
        calls.push(['listAdapterKinds'])
        return ['http']
      },
      createAdapter(input) {
        calls.push(['createAdapter', input])
        return {
          async testConnection(body) {
            calls.push(['testConnection', body])
            return { ok: true, status: 200 }
          },
        }
      },
    },
    pipelineRegistry: {
      async listPipelines(input) {
        calls.push(['listPipelines', input])
        return [pipeline]
      },
      async upsertPipeline(input) {
        calls.push(['upsertPipeline', input])
        return { ...pipeline, ...input, id: input.id || pipeline.id }
      },
      async getPipeline(input) {
        calls.push(['getPipeline', input])
        return { ...pipeline, id: input.id }
      },
      async listPipelineRuns(input) {
        calls.push(['listPipelineRuns', input])
        return [run]
      },
      async listProvenanceByRow(input) {
        calls.push(['listProvenanceByRow', input])
        return [{
          runId: 'run_1', pipelineId: input.pipelineId || 'pipe_1', rowId: input.rowId,
          eventType: 'target_write_succeeded', at: '2026-04-24T01:00:00.000Z', attrs: {},
          eventIndex: 1, runStatus: 'succeeded', runMode: 'full', runCreatedAt: '2026-04-24T01:00:00.000Z',
        }]
      },
    },
    pipelineRunner: {
      async runPipeline(input) {
        calls.push(['runPipeline', input])
        return {
          run: {
            ...run,
            pipelineId: input.pipelineId,
            details: { dryRun: input.dryRun === true },
          },
          metrics: {
            rowsRead: 2,
            rowsCleaned: input.dryRun ? 2 : 0,
            rowsWritten: input.dryRun ? 0 : 2,
            rowsFailed: 0,
          },
        }
      },
      async replayDeadLetter(input) {
        calls.push(['replayDeadLetter', input])
        return {
          deadLetter: { ...deadLetter, id: input.id, status: 'replayed' },
          run: { ...run, id: 'run_replay_1', status: 'succeeded' },
        }
      },
    },
    deadLetterStore: {
      async listDeadLetters(input) {
        calls.push(['listDeadLetters', input])
        return [deadLetter]
      },
    },
    stagingInstaller: {
      listStagingDescriptors() {
        calls.push(['listStagingDescriptors'])
        return [
          {
            id: 'standard_materials',
            name: 'Standard Materials',
            fields: ['code', 'name'],
            fieldDetails: [
              { id: 'code', name: 'Material Code', type: 'string' },
              { id: 'name', name: 'Material Name', type: 'string' },
            ],
          },
          { id: 'bom_cleanse', name: 'BOM Cleanse', fields: ['parentCode', 'childCode'] },
        ]
      },
      async installStaging(input) {
        calls.push(['installStaging', input])
        return {
          sheetIds: {
            standard_materials: 'sheet_materials',
            bom_cleanse: 'sheet_bom',
          },
          warnings: [],
        }
      },
    },
  }

  return {
    calls,
    services: mergeServiceOverrides(services, overrides),
  }
}

function mountRoutes(services, contextOptions = {}) {
  const { context, routes } = createMockContext(contextOptions)
  const registerRoutes = httpRoutes.registerIntegrationRoutes || httpRoutes.createIntegrationHttpRouter
  assert.equal(typeof registerRoutes, 'function', 'HTTP routes module exports a registration function')

  const registered = registerRoutes({
    context,
    services,
    logger: {
      warn() {},
      error() {},
      info() {},
    },
  })

  return { routes, registered }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function getRoute(routes, method, routePath) {
  const key = `${method.toUpperCase()} ${routePath}`
  const route = routes.get(key)
  assert.ok(route, `expected route ${key} to be registered`)
  return route
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
  const route = getRoute(routes, method, routePath)
  const res = createResponse()
  await route.handler({
    user: req.user,
    authUser: req.authUser,
    body: req.body || {},
    query: req.query || {},
    params: req.params || {},
  }, res)
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a JSON body`)
  return res
}

function findCall(calls, name) {
  const call = calls.find(([callName]) => callName === name)
  assert.ok(call, `expected ${name} to be called`)
  return call
}

function findCalls(calls, name) {
  return calls.filter(([callName]) => callName === name)
}

function assertOkResponse(res, expectedStatus) {
  assert.equal(res.statusCode, expectedStatus)
  assert.equal(res.body.ok, true)
  assert.ok('data' in res.body, 'success responses wrap payload in data')
}

function assertErrorResponse(res, allowedStatuses) {
  assert.ok(allowedStatuses.includes(res.statusCode), `status ${res.statusCode} is allowed`)
  assert.equal(res.body.ok, false)
  assert.equal(typeof res.body.error, 'object')
  assert.equal(typeof res.body.error.code, 'string')
  assert.ok(res.body.error.code.length > 0)
}

async function testUnauthenticatedWriteRequestIsRejected() {
  const { calls, services } = createMockServices()
  const { routes } = mountRoutes(services)

  const res = await invoke(routes, 'POST', '/api/integration/pipelines', {
    body: {
      tenantId: 'tenant_1',
      name: 'Material sync',
    },
  })

  assertErrorResponse(res, [401, 403])
  assert.equal(calls.length, 0, 'unauthenticated write did not reach services')
}

async function testExternalSystemRoutes() {
  const { calls, services } = createMockServices()
  const { routes, registered } = mountRoutes(services)

  assert.ok(
    registered.includes('GET /api/integration/external-systems'),
    'external systems list route registered',
  )
  assert.ok(
    registered.includes('DELETE /api/integration/external-systems/:id'),
    'external systems delete route registered',
  )

  let res = await invoke(routes, 'GET', '/api/integration/external-systems', {
    user: READ_USER,
    query: {
      workspaceId: 'workspace_1',
      kind: 'erp',
      status: 'active',
      limit: '25',
      offset: '2',
    },
  })
  assertOkResponse(res, 200)
  assert.deepEqual(res.body.data.map((item) => item.id), ['sys_1'])
  assert.deepEqual(findCall(calls, 'listExternalSystems')[1], {
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    kind: 'erp',
    status: 'active',
    limit: 25,
    offset: 2,
  })

  res = await invoke(routes, 'POST', '/api/integration/external-systems', {
    user: WRITE_USER,
    body: {
      id: 'sys_2',
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      name: 'Kingdee K3',
      kind: 'erp',
      role: 'target',
      status: 'active',
      credentials: { token: 'secret' },
    },
  })
  assertOkResponse(res, 201)
  assert.equal(res.body.data.id, 'sys_2')
  assert.deepEqual(findCall(calls, 'upsertExternalSystem')[1], {
    id: 'sys_2',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    name: 'Kingdee K3',
    kind: 'erp',
    role: 'target',
    status: 'active',
    credentials: { token: 'secret' },
  })

  res = await invoke(routes, 'GET', '/api/integration/external-systems/:id', {
    user: READ_USER,
    params: { id: 'sys_2' },
    query: { workspaceId: 'workspace_1' },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.id, 'sys_2')
  assert.deepEqual(findCall(calls, 'getExternalSystem')[1], {
    id: 'sys_2',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
  })

  res = await invoke(routes, 'DELETE', '/api/integration/external-systems/:id', {
    user: WRITE_USER,
    params: { id: 'sys_2' },
    query: { workspaceId: 'workspace_1' },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.deleted, true)
  assert.equal(res.body.data.system.id, 'sys_2')
  assert.deepEqual(findCall(calls, 'deleteExternalSystem')[1], {
    id: 'sys_2',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
  })

  res = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITE_USER,
    params: { id: 'sys_2' },
    query: { workspaceId: 'workspace_1' },
    body: { path: '/health' },
  })
  assertOkResponse(res, 200)
  assert.deepEqual(findCall(calls, 'getExternalSystemForAdapter')[1], {
    id: 'sys_2',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
  })
  assert.deepEqual(findCall(calls, 'createAdapter')[1].credentials, { bearerToken: 'secret-token' })
  assert.equal(res.body.data.ok, true)
  assert.equal(res.body.data.credentials, undefined, 'test response does not leak credentials')
  assert.equal(res.body.data.system.credentials, undefined, 'test response system does not leak credentials')
  assert.equal(res.body.data.system.credentialsEncrypted, undefined, 'test response system does not leak ciphertext')
  const statusUpdates = findCalls(calls, 'upsertExternalSystem')
  assert.equal(statusUpdates.length, 2, 'external system create plus test status update were persisted')
  assert.deepEqual(statusUpdates[1][1], {
    id: 'sys_2',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    projectId: 'project_1',
    name: 'K3 WISE',
    kind: 'erp',
    role: 'target',
    status: 'active',
    lastTestedAt: statusUpdates[1][1].lastTestedAt,
    lastError: null,
  })
  assert.ok(!Number.isNaN(Date.parse(statusUpdates[1][1].lastTestedAt)), 'test status update stores ISO timestamp')

  calls.length = 0
  const { routes: conflictRoutes } = mountRoutes(createMockServices({
    externalSystemRegistry: {
      async deleteExternalSystem(input) {
        calls.push(['deleteExternalSystem', input])
        const error = new Error('external system is used by pipelines')
        error.name = 'ExternalSystemConflictError'
        error.details = {
          referencedPipelineCount: 2,
          sourcePipelineCount: 1,
          targetPipelineCount: 1,
        }
        throw error
      },
    },
  }).services)
  const conflict = await invoke(conflictRoutes, 'DELETE', '/api/integration/external-systems/:id', {
    user: WRITE_USER,
    params: { id: 'sys_referenced' },
    query: { workspaceId: 'workspace_1' },
  })
  assertErrorResponse(conflict, [409])
  assert.equal(conflict.body.error.code, 'ExternalSystemConflictError')
  assert.equal(conflict.body.error.details.referencedPipelineCount, 2)
}

async function testExternalSystemUpsertPreservesObjectSchema() {
  // A4 route-fidelity probe (isolated harness): the HTTP upsert route MUST forward
  // config.objects.material.schema (incl. each field's reference.identifier) verbatim —
  // not strip it via route / requestBody / scopedInput / response path. The store + get +
  // sanitize round-trip is covered separately by external-systems.test.cjs §7e (O4).
  const { calls, services } = createMockServices()
  const { routes } = mountRoutes(services)
  const refSchema = [
    { name: 'FBaseUnitID', type: 'reference', reference: { identifier: 'FNumber' } },
    { name: 'FAcctID', type: 'reference', reference: { identifier: 'FID' } },
  ]
  const res = await invoke(routes, 'POST', '/api/integration/external-systems', {
    user: WRITE_USER,
    body: {
      id: 'sys_ref_schema',
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      name: 'K3 WISE ref-schema',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'active',
      config: { objects: { material: { schema: refSchema } } },
    },
  })
  assertOkResponse(res, 201)
  const forwarded = findCall(calls, 'upsertExternalSystem')
  assert.ok(forwarded, 'route forwarded the upsert to the store')
  assert.deepEqual(forwarded[1].config.objects.material.schema, refSchema,
    'A4 route fidelity: config.objects.material.schema (incl. per-field reference.identifier) forwarded verbatim, not stripped')
  assert.equal(res.body.data.config.objects.material.schema[1].reference.identifier, 'FID',
    'A4 route fidelity: response path preserves nested reference.identifier')
}

async function testExternalSystemTestPersistsFailureAndPreservesInactive() {
  const { calls, services } = createMockServices({
    externalSystemRegistry: {
      async getExternalSystemForAdapter(input) {
        calls.push(['getExternalSystemForAdapter', input])
        return {
          id: input.id,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          projectId: 'project_inactive',
          name: 'Inactive ERP',
          kind: 'erp',
          role: 'target',
          status: 'inactive',
          credentials: { bearerToken: 'secret-token' },
        }
      },
    },
    adapterRegistry: {
      createAdapter(input) {
        calls.push(['createAdapter', input])
        return {
          async testConnection() {
            calls.push(['testConnection'])
            return { ok: false, code: 'ERP_DOWN', message: 'ERP endpoint unavailable' }
          },
        }
      },
    },
  })
  const { routes } = mountRoutes(services)

  const res = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITE_USER,
    params: { id: 'sys_inactive' },
    query: { workspaceId: 'workspace_1' },
  })

  assertOkResponse(res, 200)
  assert.equal(res.body.data.ok, false)
  assert.equal(res.body.data.system.status, 'error')
  const statusUpdate = findCall(calls, 'upsertExternalSystem')[1]
  assert.equal(statusUpdate.projectId, 'project_inactive', 'failed connection test preserves project scope')
  assert.equal(statusUpdate.status, 'error')
  assert.equal(statusUpdate.lastError, 'ERP endpoint unavailable')

  calls.length = 0
  services.adapterRegistry.createAdapter = (input) => {
    calls.push(['createAdapter', input])
    return {
      async testConnection() {
        calls.push(['testConnection'])
        return { ok: true, status: 200 }
      },
    }
  }

  const success = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITE_USER,
    params: { id: 'sys_inactive' },
    query: { workspaceId: 'workspace_1' },
  })

  assertOkResponse(success, 200)
  assert.equal(success.body.data.ok, true)
  const inactiveUpdate = findCall(calls, 'upsertExternalSystem')[1]
  assert.equal(inactiveUpdate.projectId, 'project_inactive', 'successful connection test preserves project scope')
  assert.equal(inactiveUpdate.status, 'inactive', 'successful test does not activate inactive systems')
  assert.equal(inactiveUpdate.lastError, null)
}

async function testExternalSystemTestClearsErrorToActiveOnSuccess() {
  // #2223 recovery: a source that went to `error` (e.g. the Bridge Agent was down) returns to `active`
  // on a successful retest — the symmetric lock to inactive-preservation above (error clears; inactive
  // does NOT auto-activate).
  const { calls, services } = createMockServices({
    externalSystemRegistry: {
      async getExternalSystemForAdapter(input) {
        calls.push(['getExternalSystemForAdapter', input])
        return {
          id: input.id,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          projectId: 'project_err',
          name: 'Recovered Source',
          kind: 'erp',
          role: 'source',
          status: 'error',
          credentials: { bearerToken: 'secret-token' },
        }
      },
    },
    adapterRegistry: {
      createAdapter(input) {
        calls.push(['createAdapter', input])
        return {
          async testConnection() {
            calls.push(['testConnection'])
            return { ok: true, status: 200 }
          },
        }
      },
    },
  })
  const { routes } = mountRoutes(services)

  const res = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITE_USER,
    params: { id: 'sys_err' },
    query: { workspaceId: 'workspace_1' },
  })

  assertOkResponse(res, 200)
  assert.equal(res.body.data.ok, true)
  assert.equal(res.body.data.system.status, 'active', 'a successful retest clears error → active')
  const update = findCall(calls, 'upsertExternalSystem')[1]
  assert.equal(update.status, 'active', 'recovery persists status=active')
  assert.equal(update.lastError, null, 'recovery clears lastError')
}

async function testExternalSystemTestRequiresSavedSystem() {
  const { calls, services } = createMockServices({
    externalSystemRegistry: {
      async getExternalSystemForAdapter(input) {
        calls.push(['getExternalSystemForAdapter', input])
        const error = new Error('external system not found')
        error.name = 'ExternalSystemNotFoundError'
        throw error
      },
    },
    adapterRegistry: {
      createAdapter(input) {
        calls.push(['createAdapter', input])
        return {
          async testConnection() {
            calls.push(['testConnection'])
            return { ok: true, status: 200 }
          },
        }
      },
    },
  })
  const { routes } = mountRoutes(services)

  const res = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITE_USER,
    params: { id: 'missing_sys' },
    query: { workspaceId: 'workspace_1' },
    body: {
      name: 'Unsaved K3 draft',
      kind: 'erp:k3-wise-webapi',
      config: { baseUrl: 'https://draft.example.test/K3API/' },
      credentials: { username: 'draft-user', password: 'draft-password', acctId: 'AIS_DRAFT' },
    },
  })

  assertErrorResponse(res, [404])
  assert.deepEqual(findCall(calls, 'getExternalSystemForAdapter')[1], {
    id: 'missing_sys',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
  })
  assert.equal(findCalls(calls, 'createAdapter').length, 0, 'missing systems do not instantiate adapters')
  assert.equal(findCalls(calls, 'testConnection').length, 0, 'missing systems do not run connection tests')
  assert.equal(findCalls(calls, 'upsertExternalSystem').length, 0, 'request body drafts are not persisted by test route')
}

async function testExternalSystemTestRedactsAdapterResultSecrets() {
  const { calls, services } = createMockServices({
    adapterRegistry: {
      createAdapter(input) {
        calls.push(['createAdapter', input])
        return {
          async testConnection() {
            calls.push(['testConnection'])
            return {
              ok: false,
              code: 'ERP_DOWN',
              message: 'failed https://user:pass@k3.example.test/K3API?access_token=live-token-123456 with Bearer liveBearerToken123456',
              raw: {
                credentials: { password: 'raw-password-secret' },
                headers: { Authorization: 'Bearer rawAuthorizationToken123456' },
              },
              headers: {
                Cookie: 'JSESSIONID=raw-session-secret',
              },
            }
          },
        }
      },
    },
  })
  const { routes } = mountRoutes(services)

  const res = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITE_USER,
    params: { id: 'sys_secret_result' },
    query: { workspaceId: 'workspace_1' },
  })

  assertOkResponse(res, 200)
  assert.equal(res.body.data.ok, false)
  assert.equal(res.body.data.raw, undefined, 'test response does not echo adapter raw payload')
  assert.equal(res.body.data.headers, undefined, 'test response does not echo adapter debug headers')
  const serialized = JSON.stringify(res.body)
  assert.equal(serialized.includes('raw-password-secret'), false)
  assert.equal(serialized.includes('rawAuthorizationToken123456'), false)
  assert.equal(serialized.includes('live-token-123456'), false)
  assert.equal(serialized.includes('liveBearerToken123456'), false)
  assert.match(res.body.data.message, /access_token=\[redacted\]/)
  assert.match(res.body.data.message, /Bearer \[redacted\]/)

  const statusUpdate = findCall(calls, 'upsertExternalSystem')[1]
  assert.equal(statusUpdate.status, 'error')
  assert.equal(statusUpdate.lastError.includes('live-token-123456'), false)
  assert.equal(statusUpdate.lastError.includes('liveBearerToken123456'), false)
}

async function testDiscoveryRoutes() {
  const { calls, services } = createMockServices({
    externalSystemRegistry: {
      async getExternalSystemForAdapter(input) {
        calls.push(['getExternalSystemForAdapter', input])
        return {
          id: input.id,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          name: 'Bidirectional CRM',
          kind: 'http',
          role: 'bidirectional',
          config: {
            documentTemplates: [
              {
                id: 'custom.supplier.v1',
                version: '2026.05.v1',
                object: 'supplier',
                label: 'Supplier',
                endpointPath: '/api/suppliers/save',
                bodyKey: 'Data',
                schema: [
                  { name: 'FNumber', label: 'Supplier code', type: 'string', required: true },
                  { name: 'FName', label: 'Supplier name', type: 'string', required: true },
                ],
                password: 'template-secret-should-not-leak',
              },
            ],
          },
          credentials: { bearerToken: 'secret-token' },
        }
      },
    },
    adapterRegistry: {
      listAdapterKinds() {
        calls.push(['listAdapterKinds'])
        return ['http', 'erp:k3-wise-sqlserver', 'bridge:legacy-sql-readonly', 'metasheet:staging', 'metasheet:multitable', 'data-source:sql-readonly', 'custom:unknown']
      },
      createAdapter(input, deps) {
        calls.push(['createAdapter', input, deps])
        return {
          async testConnection() {
            calls.push(['testConnection'])
            return { ok: true }
          },
          async listObjects() {
            calls.push(['listObjects'])
            return [
              {
                name: 'customers_raw',
                label: 'Customers raw',
                operations: ['read'],
                schema: [
                  { name: 'rawName', label: 'Raw name', type: 'string' },
                ],
              },
            ]
          },
          async getSchema(input) {
            calls.push(['getSchema', input])
            return {
              object: input.object,
              fields: [
                { name: 'rawName', label: 'Raw name', type: 'string' },
                { name: 'accessToken', label: 'Token-like source field', type: 'string' },
              ],
              raw: {
                credentials: { password: 'schema-secret-should-not-leak' },
              },
            }
          },
        }
      },
    },
  })
  const { routes, registered } = mountRoutes(services)

  assert.ok(registered.includes('GET /api/integration/adapters'), 'adapter discovery route registered')
  assert.ok(registered.includes('GET /api/integration/external-systems/:id/objects'), 'object discovery route registered')
  assert.ok(registered.includes('GET /api/integration/external-systems/:id/schema'), 'schema discovery route registered')

  let res = await invoke(routes, 'GET', '/api/integration/adapters', {
    user: READ_USER,
  })
  assertOkResponse(res, 200)
  const sqlMetadata = res.body.data.find((adapter) => adapter.kind === 'erp:k3-wise-sqlserver')
  assert.equal(sqlMetadata.label, 'K3 WISE SQL Server Channel')
  assert.equal(sqlMetadata.advanced, true, 'SQL Server channel is marked as advanced')
  assert.deepEqual(sqlMetadata.guardrails, {
    read: {
      requiresTableAllowlist: true,
      allowlistKeys: ['readTables', 'allowedTables'],
    },
    write: {
      requiresMiddleTableMode: true,
      requiresTableAllowlist: true,
      allowlistKeys: ['writeTables', 'allowedTables'],
      writeModes: ['middle-table'],
    },
    ui: {
      hiddenByDefault: true,
      normalUiDirectCoreTableWrites: false,
    },
  })
  const bridgeMetadata = res.body.data.find((adapter) => adapter.kind === 'bridge:legacy-sql-readonly')
  assert.equal(bridgeMetadata.label, 'Readonly Bridge Agent')
  assert.equal(bridgeMetadata.advanced, true, 'Bridge Agent source is marked as advanced')
  assert.deepEqual(bridgeMetadata.roles, ['source'])
  assert.deepEqual(bridgeMetadata.supports, ['testConnection', 'listObjects', 'getSchema', 'read'])
  assert.deepEqual(bridgeMetadata.guardrails.read, {
    localhostOnly: true,
    requiresObjectAllowlist: true,
    maxPreviewLimit: 20,
    noRawSql: true,
    dryRunFriendly: true,
  })
  assert.deepEqual(bridgeMetadata.guardrails.write, { supported: false })
  assert.deepEqual(bridgeMetadata.guardrails.ui, {
    hiddenByDefault: true,
    recommendedForLegacySqlBridge: true,
  })
  const stagingMetadata = res.body.data.find((adapter) => adapter.kind === 'metasheet:staging')
  assert.equal(stagingMetadata.label, 'MetaSheet staging multitable')
  assert.equal(stagingMetadata.advanced, false, 'MetaSheet staging source is not hidden as advanced')
  assert.deepEqual(stagingMetadata.roles, ['source'])
  assert.deepEqual(stagingMetadata.supports, ['testConnection', 'listObjects', 'getSchema', 'read'])
  assert.deepEqual(stagingMetadata.guardrails.read, {
    hostOwned: true,
    dryRunFriendly: true,
    noExternalNetwork: true,
  })
  assert.deepEqual(stagingMetadata.guardrails.write, { supported: false })
  const multitableMetadata = res.body.data.find((adapter) => adapter.kind === 'metasheet:multitable')
  assert.equal(multitableMetadata.label, 'MetaSheet multitable')
  assert.equal(multitableMetadata.advanced, false)
  assert.deepEqual(multitableMetadata.roles, ['target'])
  assert.deepEqual(multitableMetadata.supports, ['testConnection', 'listObjects', 'getSchema', 'upsert'])
  assert.deepEqual(multitableMetadata.guardrails.write, {
    hostOwned: true,
    pluginScopedSheetsOnly: true,
    supportsAppend: true,
    supportsUpsertByKey: true,
  })
  const dataSourceMetadata = res.body.data.find((adapter) => adapter.kind === 'data-source:sql-readonly')
  assert.equal(dataSourceMetadata.label, 'Read-only SQL data source')
  assert.equal(dataSourceMetadata.advanced, true)
  assert.deepEqual(dataSourceMetadata.roles, ['source'], 'data-source:sql-readonly is source-only (NOT source/target/bidirectional)')
  assert.deepEqual(dataSourceMetadata.supports, ['testConnection', 'listObjects', 'getSchema', 'read'], 'data-source:sql-readonly supports has no upsert')
  assert.equal(dataSourceMetadata.supports.includes('upsert'), false, 'data-source:sql-readonly never advertises upsert')
  assert.deepEqual(dataSourceMetadata.guardrails.write, { supported: false }, 'data-source:sql-readonly write is unsupported')
  const unknownMetadata = res.body.data.find((adapter) => adapter.kind === 'custom:unknown')
  assert.equal(unknownMetadata.label, 'custom:unknown')
  assert.equal(unknownMetadata.advanced, false)
  assert.equal(unknownMetadata.guardrails, undefined)
  res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/objects', {
    user: READ_USER,
    params: { id: 'crm_1' },
    query: { workspaceId: 'workspace_1' },
  })
  assertOkResponse(res, 200)
  assert.deepEqual(findCall(calls, 'getExternalSystemForAdapter')[1], {
    id: 'crm_1',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
  })
  assert.deepEqual(res.body.data.map((object) => object.name), ['customers_raw', 'supplier'])
  const supplierObject = res.body.data.find((object) => object.name === 'supplier')
  assert.equal(supplierObject.id, 'custom.supplier.v1')
  assert.equal(supplierObject.label, 'Supplier')
  assert.equal(supplierObject.object, 'supplier')
  assert.equal(supplierObject.source, 'documentTemplate')
  assert.deepEqual(supplierObject.operations, ['upsert'])
  assert.equal(supplierObject.template.bodyKey, 'Data')
  assert.equal(supplierObject.template.id, 'custom.supplier.v1')
  assert.equal(supplierObject.template.endpointPath, '/api/suppliers/save')
  assert.equal(JSON.stringify(res.body).includes('template-secret-should-not-leak'), false)
  assert.equal(JSON.stringify(res.body).includes('secret-token'), false)
  // C2b: the objects route runs the adapter AS the request user — the owner principal is threaded
  // into createAdapter (so the data-source:sql-readonly bridge's facade authorizes), and it is the
  // request user, NOT a system/admin fallback.
  assert.deepEqual(findCall(calls, 'createAdapter')[2], { principal: 'user_read' }, 'objects route threads the request principal to createAdapter')

  calls.length = 0
  res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/schema', {
    user: READ_USER,
    params: { id: 'crm_1' },
    query: { workspaceId: 'workspace_1', object: 'customers_raw' },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.object, 'customers_raw')
  assert.deepEqual(findCall(calls, 'getSchema')[1], { object: 'customers_raw' })
  assert.equal(JSON.stringify(res.body).includes('schema-secret-should-not-leak'), false)
  assert.equal(res.body.data.raw.credentials, '[redacted]')
  assert.deepEqual(findCall(calls, 'createAdapter')[2], { principal: 'user_read' }, 'schema route threads the request principal to createAdapter')

  calls.length = 0
  res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/schema', {
    user: READ_USER,
    params: { id: 'crm_1' },
    query: { workspaceId: 'workspace_1', object: 'supplier' },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.object, 'supplier')
  assert.deepEqual(res.body.data.fields.map((field) => field.name), ['FNumber', 'FName'])
  assert.equal(findCalls(calls, 'getSchema').length, 0, 'template schema does not call adapter getSchema')

  const missingObject = await invoke(routes, 'GET', '/api/integration/external-systems/:id/schema', {
    user: READ_USER,
    params: { id: 'crm_1' },
    query: { workspaceId: 'workspace_1' },
  })
  assert.equal(missingObject.statusCode, 400)
  assert.equal(missingObject.body.error.code, 'OBJECT_REQUIRED')
}

async function testDiscoveryObjectsRouteDoesNotDefaultTruncateAdapterObjects() {
  const largeObjects = Array.from({ length: 109 }, (_, index) => ({
    name: index === 87 ? 'stockorder.stock_info' : `stockorder.table_${String(index + 1).padStart(3, '0')}`,
    label: `table ${index + 1}`,
    operations: ['read'],
    accessToken: index === 0 ? 'secret-token-should-not-leak' : undefined,
  }))
  const { services } = createMockServices({
    adapterRegistry: {
      createAdapter() {
        return {
          async listObjects() {
            return largeObjects
          },
        }
      },
    },
  })
  const { routes } = mountRoutes(services)

  const res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/objects', {
    user: READ_USER,
    params: { id: 'mysql_bridge_1' },
    query: { workspaceId: 'workspace_1' },
  })

  assertOkResponse(res, 200)
  assert.equal(res.body.data.length, 109, 'object discovery returns the full metadata list, not the default 50-item redaction cap')
  assert.ok(
    res.body.data.some((object) => object.name === 'stockorder.stock_info'),
    'business tables beyond the first 50 stay discoverable',
  )
  assert.equal(
    res.body.data.some((object) => typeof object === 'string' && object.includes('more items truncated')),
    false,
    'object discovery does not include the default array truncation marker',
  )
  assert.equal(JSON.stringify(res.body).includes('secret-token-should-not-leak'), false, 'object metadata still runs through redaction')
  assert.equal(res.body.data[0].accessToken, '[redacted]')
}

async function testDiscoveryRoutesRejectUnknownSystem() {
  const { calls, services } = createMockServices()
  services.externalSystemRegistry.getExternalSystemForAdapter = async (input) => {
    calls.push(['getExternalSystemForAdapter', input])
    const error = new Error('external system missing')
    error.name = 'ExternalSystemNotFoundError'
    throw error
  }
  const { routes } = mountRoutes(services)

  let res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/objects', {
    user: READ_USER,
    params: { id: 'missing_sys' },
    query: { workspaceId: 'workspace_1' },
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.error.code, 'ExternalSystemNotFoundError')
  assert.deepEqual(findCall(calls, 'getExternalSystemForAdapter')[1], {
    id: 'missing_sys',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
  })
  assert.equal(findCalls(calls, 'createAdapter').length, 0, 'unknown system does not create an adapter')

  calls.length = 0
  res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/schema', {
    user: READ_USER,
    params: { id: 'missing_sys' },
    query: { workspaceId: 'workspace_1', object: 'material' },
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.error.code, 'ExternalSystemNotFoundError')
  assert.equal(findCalls(calls, 'createAdapter').length, 0, 'unknown system schema lookup does not create an adapter')
}

// #2205 legibility nit: a `data-source:sql-readonly` external system EXISTS, but its bound data
// source (config.dataSourceId) is deleted / not-visible to the principal — so the host facade
// (assertAccess / getDataSource) rejects with a uniform "not found". On the entity machine this
// reached the plugin host as a plain Error (name='Error'), not the TS facade's named class, so the
// route must classify the DATA SOURCE message itself: clean 422, NOT 500, and UNIFORM (no existence
// leak between deleted-vs-not-mine).
async function testBridgeDanglingDataSourceMapsTo4xxNot500() {
  // The exact uniform wording DataSourceManager.assertAccess + getDataSource throw — re-raised
  // verbatim by the facade wrapper; identical for "deleted" and "not yours" → no existence leak.
  const UNIFORM_NOT_FOUND = "Data source with id 'ds_gone' not found"
  const danglingError = () => {
    // Deliberately plain Error: this is the actual runtime failure shape reported in #2250.
    // A test that only throws a named DataSourceUnavailableError is a fixture, not a wire lock.
    return new Error(UNIFORM_NOT_FOUND)
  }

  const { calls, services } = createMockServices({
    externalSystemRegistry: {
      async getExternalSystemForAdapter(input) {
        calls.push(['getExternalSystemForAdapter', input])
        return {
          id: input.id,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          name: 'Read-only SQL bridge',
          kind: 'data-source:sql-readonly',
          role: 'source',
          // No documentTemplates: the schema route must NOT fall back to a template and mask the
          // dangling-source 422 with a 200.
          config: { dataSourceId: 'ds_gone' },
        }
      },
    },
    adapterRegistry: {
      createAdapter(input, deps) {
        calls.push(['createAdapter', input, deps])
        return {
          // Both discovery methods route through the host facade, which throws on a dangling bind.
          async listObjects() {
            calls.push(['listObjects'])
            throw danglingError()
          },
          async getSchema(schemaInput) {
            calls.push(['getSchema', schemaInput])
            throw danglingError()
          },
        }
      },
    },
  })
  const { routes } = mountRoutes(services)

  // objects route
  let res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/objects', {
    user: READ_USER,
    params: { id: 'sql_bridge_1' },
    query: { workspaceId: 'workspace_1' },
  })
  assert.notEqual(res.statusCode, 500, 'a dangling data-source binding is a config error, not a 500')
  assert.equal(res.statusCode, 422, 'objects route maps the dangling-source not-found to 422')
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'DATA_SOURCE_NOT_FOUND', 'distinct code (NOT ExternalSystemNotFoundError) — the system exists, its bound source does not')
  // No-existence-leak: the message is the uniform "not found", unchanged from the facade — it does
  // not reveal whether the source was deleted or simply not owned by this principal.
  assert.equal(res.body.error.message, UNIFORM_NOT_FOUND, 'message stays the uniform not-found (no existence leak)')
  assert.ok(findCall(calls, 'listObjects'), 'objects route reached the adapter (the facade is where it failed)')

  // schema route — same dangling source, same uniform 422 surface (no leak divergence)
  calls.length = 0
  res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/schema', {
    user: READ_USER,
    params: { id: 'sql_bridge_1' },
    query: { workspaceId: 'workspace_1', object: 'public.customers' },
  })
  assert.notEqual(res.statusCode, 500, 'schema route also avoids 500 for a dangling source')
  assert.equal(res.statusCode, 422, 'schema route maps the dangling-source not-found to 422')
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'DATA_SOURCE_NOT_FOUND')
  assert.equal(res.body.error.message, UNIFORM_NOT_FOUND, 'schema route keeps the identical uniform message (no leak)')
  assert.ok(findCall(calls, 'getSchema'), 'schema route reached the adapter getSchema')
}

async function testDocumentTemplateValidation() {
  const cases = [
    {
      name: 'missing id',
      template: { label: 'Supplier', object: 'supplier', schema: [{ name: 'FNumber' }] },
      field: 'config.documentTemplates[0].id',
    },
    {
      name: 'missing label',
      template: { id: 'custom.supplier.v1', object: 'supplier', schema: [{ name: 'FNumber' }] },
      field: 'config.documentTemplates[0].label',
    },
    {
      name: 'missing object',
      template: { id: 'custom.supplier.v1', label: 'Supplier', targetObject: 'supplier', schema: [{ name: 'FNumber' }] },
      field: 'config.documentTemplates[0].object',
    },
  ]

  for (const { name, template, field } of cases) {
    const { services } = createMockServices({
      externalSystemRegistry: {
        async getExternalSystemForAdapter(input) {
          return {
            id: input.id,
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            name: 'Template Host',
            kind: 'http',
            role: 'bidirectional',
            config: {
              documentTemplates: [template],
            },
          }
        },
      },
      adapterRegistry: {
        createAdapter() {
          return {
            async listObjects() {
              return []
            },
          }
        },
      },
    })
    const { routes } = mountRoutes(services)

    const res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/objects', {
      user: READ_USER,
      params: { id: `template_${name.replace(/\s+/g, '_')}` },
      query: { workspaceId: 'workspace_1' },
    })

    assert.equal(res.statusCode, 400, `${name} should reject with 400`)
    assert.equal(res.body.error.code, 'INVALID_DOCUMENT_TEMPLATE')
    assert.equal(res.body.error.details.field, field)
  }
}

async function testPipelineRoutes() {
  const { calls, services } = createMockServices()
  const { routes } = mountRoutes(services)

  let res = await invoke(routes, 'GET', '/api/integration/pipelines', {
    user: READ_USER,
    query: {
      workspaceId: 'workspace_1',
      status: 'active',
      sourceSystemId: 'plm_1',
      targetSystemId: 'sys_1',
      limit: '10',
      offset: '2',
    },
  })
  assertOkResponse(res, 200)
  assert.deepEqual(res.body.data.map((item) => item.id), ['pipe_1'])
  assert.deepEqual(findCall(calls, 'listPipelines')[1], {
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    status: 'active',
    sourceSystemId: 'plm_1',
    targetSystemId: 'sys_1',
    limit: 10,
    offset: 2,
  })

  res = await invoke(routes, 'POST', '/api/integration/pipelines', {
    user: WRITE_USER,
    body: {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      name: 'Material sync v2',
      sourceSystemId: 'plm_1',
      sourceObject: 'materials',
      targetSystemId: 'sys_1',
      targetObject: 'BD_MATERIAL',
      status: 'active',
      fieldMappings: [],
      createdBy: 'spoofed_actor',
    },
  })
  assertOkResponse(res, 201)
  assert.equal(res.body.data.name, 'Material sync v2')
  assert.equal(findCall(calls, 'upsertPipeline')[1].createdBy, 'user_write')

  res = await invoke(routes, 'POST', '/api/integration/pipelines/:id/run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      mode: 'manual',
      allowInactive: true,
      sourceRecords: [{ code: 'spoofed' }],
      triggeredBy: 'spoofed',
      details: { unsafe: true },
    },
  })
  assertOkResponse(res, 202)
  const runCall = findCalls(calls, 'runPipeline')[0]
  assert.deepEqual(runCall[1], {
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    mode: 'manual',
    pipelineId: 'pipe_1',
    triggeredBy: 'api',
  })
  assert.equal('allowInactive' in runCall[1], false)
  assert.equal('sourceRecords' in runCall[1], false)
  assert.equal('details' in runCall[1], false)

  res = await invoke(routes, 'POST', '/api/integration/pipelines/:id/dry-run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      mode: 'manual',
      sampleLimit: 2,
    },
  })
  assertOkResponse(res, 200)
  const dryRunCall = findCalls(calls, 'runPipeline')[1]
  assert.equal(dryRunCall[1].pipelineId, 'pipe_1')
  assert.equal(dryRunCall[1].triggeredBy, 'api')
  assert.equal(dryRunCall[1].dryRun, true)
  assert.equal(dryRunCall[1].sampleLimit, 2)
  assert.equal(res.body.data.metrics.rowsWritten, 0, 'dry-run response does not report target writes')

  // --- run mode validation: only run-ledger modes exposed to users pass ---
  for (const goodMode of ['manual', 'incremental', 'full']) {
    const modeRes = await invoke(routes, 'POST', '/api/integration/pipelines/:id/run', {
      user: WRITE_USER,
      params: { id: 'pipe_1' },
      body: { tenantId: 'tenant_1', workspaceId: 'workspace_1', mode: goodMode },
    })
    assertOkResponse(modeRes, 202)
    assert.equal(findCalls(calls, 'runPipeline').at(-1)[1].mode, goodMode)
  }

  // internal-only, scheduler trigger labels, and unknown modes are rejected
  for (const badMode of ['replay', 'scheduled', 'hacker', 'MANUAL', 'Incremental', '']) {
    const modeRes = await invoke(routes, 'POST', '/api/integration/pipelines/:id/run', {
      user: WRITE_USER,
      params: { id: 'pipe_1' },
      body: { tenantId: 'tenant_1', workspaceId: 'workspace_1', mode: badMode },
    })
    // empty string is treated as absent by publicRunInput (passes through)
    if (badMode === '') {
      assertOkResponse(modeRes, 202)
    } else {
      assert.equal(modeRes.statusCode, 400, `mode '${badMode}' must be rejected with 400`)
      assert.equal(modeRes.body.error.code, 'INVALID_RUN_MODE', `mode '${badMode}' must yield INVALID_RUN_MODE`)
    }
  }

  // dry-run also validates mode
  const dryModeRes = await invoke(routes, 'POST', '/api/integration/pipelines/:id/dry-run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { tenantId: 'tenant_1', workspaceId: 'workspace_1', mode: 'replay' },
  })
  assert.equal(dryModeRes.statusCode, 400, "mode 'replay' must be rejected on dry-run too")
  assert.equal(dryModeRes.body.error.code, 'INVALID_RUN_MODE')
}

async function testTemplatePreviewRoute() {
  const { calls, services } = createMockServices()
  const { routes, registered } = mountRoutes(services)

  assert.ok(
    registered.includes('POST /api/integration/templates/preview'),
    'template preview route registered',
  )

  let res = await invoke(routes, 'POST', '/api/integration/templates/preview', {
    user: WRITE_USER,
    body: {
      sourceRecord: {
        code: ' mat-001 ',
        name: ' Bolt ',
        uom: 'EA',
        quantity: '2',
        password: 'source-secret-should-not-leak',
      },
      fieldMappings: [
        {
          sourceField: 'code',
          targetField: 'FNumber',
          transform: ['trim', 'upper'],
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'name',
          targetField: 'FName',
          transform: { fn: 'trim' },
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'uom',
          targetField: 'FBaseUnitID',
          transform: {
            fn: 'dictMap',
            map: { EA: 'Pcs', PCS: 'Pcs', KG: 'Kg' },
          },
        },
        {
          sourceField: 'quantity',
          targetField: 'FQty',
          transform: { fn: 'toNumber' },
          validation: [{ type: 'min', value: 0.000001 }],
        },
      ],
      template: {
        id: 'k3wise.material.preview',
        version: '2026.05.v1',
        documentType: 'material',
        bodyKey: 'Data',
        endpointPath: '/K3API/Material/Save',
        schema: [
          { name: 'FNumber', label: 'Material code', type: 'string', required: true },
          { name: 'FName', label: 'Material name', type: 'string', required: true },
          { name: 'FBaseUnitID', label: 'Base unit', type: 'reference', reference: { identifier: 'FNumber' } },
          { name: 'FQty', label: 'Quantity', type: 'number' },
        ],
      },
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.valid, true)
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.data.payload)), {
    Data: {
      FNumber: 'MAT-001',
      FName: 'Bolt',
      FBaseUnitID: { FNumber: 'Pcs' },
      FQty: 2,
    },
  })
  assert.deepEqual(res.body.data.errors, [])
  assert.equal(JSON.stringify(res.body).includes('source-secret-should-not-leak'), false)
  assert.equal(calls.length, 0, 'template preview does not call integration services')

  res = await invoke(routes, 'POST', '/api/integration/templates/preview', {
    user: WRITE_USER,
    body: {
      sourceRecord: {
        parentCode: ' bom-parent-001 ',
        childCode: ' mat-child-002 ',
        quantity: '2.5',
        scrapRate: '0.03',
        password: 'bom-secret-should-not-leak',
      },
      fieldMappings: [
        {
          sourceField: 'parentCode',
          targetField: 'FParentItemNumber',
          transform: ['trim', 'upper'],
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'childCode',
          targetField: 'FChildItemNumber',
          transform: ['trim', 'upper'],
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'quantity',
          targetField: 'FQty',
          transform: { fn: 'toNumber' },
          validation: [{ type: 'min', value: 0.000001 }],
        },
        {
          sourceField: 'scrapRate',
          targetField: 'FScrapRate',
          transform: { fn: 'toNumber' },
        },
      ],
      template: {
        id: 'k3wise.bom.preview',
        version: '2026.05.v1',
        documentType: 'bom',
        bodyKey: 'Data',
        endpointPath: '/K3API/BOM/Save',
        schema: [
          { name: 'FParentItemNumber', label: 'Parent material', type: 'string', required: true },
          { name: 'FChildItemNumber', label: 'Child material', type: 'string', required: true },
          { name: 'FQty', label: 'Quantity', type: 'number', required: true },
          { name: 'FScrapRate', label: 'Scrap rate', type: 'number' },
        ],
      },
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.valid, true)
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.data.payload)), {
    Data: {
      FParentItemNumber: 'BOM-PARENT-001',
      FChildItemNumber: 'MAT-CHILD-002',
      FQty: 2.5,
      FScrapRate: 0.03,
    },
  })
  assert.deepEqual(res.body.data.errors, [])
  assert.equal(JSON.stringify(res.body).includes('bom-secret-should-not-leak'), false)
  assert.equal(calls.length, 0, 'BOM template preview does not call integration services')

  res = await invoke(routes, 'POST', '/api/integration/templates/preview', {
    user: WRITE_USER,
    body: {
      sourceRecord: {
        code: '',
      },
      fieldMappings: [
        {
          sourceField: 'code',
          targetField: 'FNumber',
          transform: { fn: 'trim' },
          validation: [{ type: 'required' }],
        },
      ],
      template: {
        bodyKey: 'Data',
        schema: [
          { name: 'FNumber', label: 'Material code', required: true },
          { name: 'FName', label: 'Material name', required: true },
        ],
      },
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.valid, false)
  assert.ok(res.body.data.errors.some((error) => error.field === 'FNumber' && error.code === 'REQUIRED'))
  assert.ok(res.body.data.errors.some((error) => error.field === 'FName' && error.code === 'REQUIRED'))

  res = await invoke(routes, 'POST', '/api/integration/templates/preview', {
    user: WRITE_USER,
    body: {
      sourceRecord: {
        code: 'MAT-001',
      },
      fieldMappings: [
        {
          sourceField: 'code',
          targetField: 'FNumber',
          transform: { fn: 'unsafeUserScript' },
        },
      ],
      template: {
        bodyKey: 'Data',
        schema: [
          { name: 'FNumber', label: 'Material code', required: true },
        ],
      },
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.valid, false)
  assert.ok(res.body.data.transformErrors.some((error) => /unsupported transform/.test(error.message)))

  const unsafeTemplate = await invoke(routes, 'POST', '/api/integration/templates/preview', {
    user: WRITE_USER,
    body: {
      sourceRecord: {},
      fieldMappings: [],
      template: {
        bodyKey: '__proto__',
      },
    },
  })
  assert.equal(unsafeTemplate.statusCode, 400)
  assert.equal(unsafeTemplate.body.error.code, 'INVALID_TEMPLATE_PREVIEW')

  const readOnlyPreview = await invoke(routes, 'POST', '/api/integration/templates/preview', {
    user: READ_USER,
    body: {
      sourceRecord: {},
      fieldMappings: [],
    },
  })
  assert.equal(readOnlyPreview.statusCode, 403, 'preview is restricted to integration write users')
}

async function testStagingRoutes() {
  const { calls, services } = createMockServices()
  const { routes, registered } = mountRoutes(services)

  assert.ok(
    registered.includes('GET /api/integration/staging/descriptors'),
    'staging descriptors route registered',
  )
  assert.ok(
    registered.includes('POST /api/integration/staging/install'),
    'staging install route registered',
  )

  let res = await invoke(routes, 'GET', '/api/integration/staging/descriptors', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1' },
  })
  assertOkResponse(res, 200)
  assert.deepEqual(res.body.data.map((item) => item.id), ['standard_materials', 'bom_cleanse'])
  assert.deepEqual(res.body.data[0].fieldDetails[0], {
    id: 'code',
    name: 'Material Code',
    type: 'string',
  })
  assert.equal(findCalls(calls, 'listStagingDescriptors').length, 1)

  res = await invoke(routes, 'POST', '/api/integration/staging/install', {
    user: WRITE_USER,
    body: {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      baseId: 'base_1',
    },
  })
  assertOkResponse(res, 201)
  assert.deepEqual(res.body.data.sheetIds, {
    standard_materials: 'sheet_materials',
    bom_cleanse: 'sheet_bom',
  })
  assert.deepEqual(findCall(calls, 'installStaging')[1], {
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    projectId: 'tenant_1:integration-core',
    baseId: 'base_1',
  })

  const missingProject = await invoke(routes, 'POST', '/api/integration/staging/install', {
    user: WRITE_USER,
    body: {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
    },
  })
  assertOkResponse(missingProject, 201)
  assert.equal(findCalls(calls, 'installStaging')[1][1].projectId, 'tenant_1:integration-core')

  const scopedProject = await invoke(routes, 'POST', '/api/integration/staging/install', {
    user: WRITE_USER,
    body: {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'tenant_1:plugin-integration-core',
    },
  })
  assertOkResponse(scopedProject, 201)
  assert.equal(
    findCalls(calls, 'installStaging')[2][1].projectId,
    'tenant_1:plugin-integration-core',
    'already plugin-scoped project ids are preserved',
  )
}

async function testRunAndDeadLetterRoutes() {
  const { calls, services } = createMockServices()
  const { routes } = mountRoutes(services)

  let res = await invoke(routes, 'GET', '/api/integration/runs', {
    user: READ_USER,
    query: {
      workspaceId: 'workspace_1',
      pipelineId: 'pipe_1',
      status: 'succeeded',
      limit: '20',
      offset: '2',
    },
  })
  assertOkResponse(res, 200)
  assert.deepEqual(res.body.data.map((item) => item.id), ['run_1'])
  assert.deepEqual(findCall(calls, 'listPipelineRuns')[1], {
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    pipelineId: 'pipe_1',
    status: 'succeeded',
    limit: 20,
    offset: 2,
  })

  // limit above MAX_LIST_LIMIT is clamped
  const { calls: largeCalls, services: largeServices } = createMockServices()
  const { routes: largeRoutes } = mountRoutes(largeServices)
  const largeRes = await invoke(largeRoutes, 'GET', '/api/integration/runs', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', limit: String(MAX_LIST_LIMIT + 10000) },
  })
  assertOkResponse(largeRes, 200)
  assert.equal(findCall(largeCalls, 'listPipelineRuns')[1].limit, MAX_LIST_LIMIT,
    `limit clamped to MAX_LIST_LIMIT (${MAX_LIST_LIMIT})`)

  // limit within MAX_LIST_LIMIT is passed through unchanged
  const { calls: smallCalls, services: smallServices } = createMockServices()
  const { routes: smallRoutes } = mountRoutes(smallServices)
  await invoke(smallRoutes, 'GET', '/api/integration/runs', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', limit: '10' },
  })
  assert.equal(findCall(smallCalls, 'listPipelineRuns')[1].limit, 10, 'small limit is unchanged')

  res = await invoke(routes, 'GET', '/api/integration/dead-letters', {
    user: READ_USER,
    query: {
      workspaceId: 'workspace_1',
      pipelineId: 'pipe_1',
      runId: 'run_1',
      status: 'open',
      limit: '20',
      offset: '2',
    },
  })
  assertOkResponse(res, 200)
  assert.deepEqual(res.body.data.map((item) => item.id), ['dl_1'])
  assert.equal(res.body.data[0].sourcePayload, undefined, 'read users get redacted dead-letter payloads')
  assert.equal(res.body.data[0].payloadRedacted, true)
  assert.deepEqual(findCall(calls, 'listDeadLetters')[1], {
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    pipelineId: 'pipe_1',
    runId: 'run_1',
    status: 'open',
    limit: 20,
    offset: 2,
  })

  // dead-letters list also caps at MAX_LIST_LIMIT
  const { calls: dlLargeCalls, services: dlLargeServices } = createMockServices()
  const { routes: dlLargeRoutes } = mountRoutes(dlLargeServices)
  await invoke(dlLargeRoutes, 'GET', '/api/integration/dead-letters', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', limit: '999999' },
  })
  assert.equal(findCall(dlLargeCalls, 'listDeadLetters')[1].limit, MAX_LIST_LIMIT,
    'dead-letters limit clamped to MAX_LIST_LIMIT')

  res = await invoke(routes, 'GET', '/api/integration/dead-letters', {
    user: WRITE_USER,
    query: {
      workspaceId: 'workspace_1',
      includePayload: 'true',
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data[0].sourcePayload, undefined, 'write users are not admins for full payload reads')
  assert.equal(res.body.data[0].transformedPayload, undefined, 'write users cannot include dead-letter payloads')
  assert.equal(res.body.data[0].payloadRedacted, true)

  res = await invoke(routes, 'GET', '/api/integration/dead-letters', {
    user: ADMIN_USER,
    query: {
      workspaceId: 'workspace_1',
      includePayload: 'true',
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data[0].sourcePayload.code, 'MAT-001')
  assert.equal(res.body.data[0].sourcePayload.password, '[redacted]')
  assert.equal(res.body.data[0].sourcePayload.headers.Authorization, '[redacted]')
  assert.equal(res.body.data[0].transformedPayload.token, '[redacted]')
  assert.equal(res.body.data[0].payloadRedacted, true)

  res = await invoke(routes, 'POST', '/api/integration/dead-letters/:id/replay', {
    user: WRITE_USER,
    params: { id: 'dl_1' },
    body: {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      mode: 'replay',
      triggeredBy: 'spoofed_actor',
      allowInactive: true,
      sourceRecords: [{ code: 'spoofed' }],
      details: { unsafe: true },
    },
  })
  assertOkResponse(res, 202)
  assert.equal(res.body.data.deadLetter.status, 'replayed')
  assert.deepEqual(findCall(calls, 'replayDeadLetter')[1], {
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    mode: 'replay',
    id: 'dl_1',
    triggeredBy: 'api',
  })
  assert.equal('allowInactive' in findCall(calls, 'replayDeadLetter')[1], false)
  assert.equal('sourceRecords' in findCall(calls, 'replayDeadLetter')[1], false)
  assert.equal('details' in findCall(calls, 'replayDeadLetter')[1], false)
}

async function testErrorResponseShape() {
  const serviceError = new Error('external system conflict')
  serviceError.status = 409
  serviceError.code = 'EXTERNAL_SYSTEM_CONFLICT'
  serviceError.details = { id: 'sys_1' }

  const { services } = createMockServices({
    externalSystemRegistry: {
      async listExternalSystems() {
        throw serviceError
      },
    },
  })
  const { routes } = mountRoutes(services)

  const res = await invoke(routes, 'GET', '/api/integration/external-systems', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1' },
  })

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'EXTERNAL_SYSTEM_CONFLICT')
  assert.equal(res.body.error.message, 'external system conflict')
  assert.equal(res.body.error.details.id, 'sys_1')

  const sensitiveDetailsError = new Error('target adapter rejected request')
  sensitiveDetailsError.status = 502
  sensitiveDetailsError.code = 'ERP_REQUEST_FAILED'
  sensitiveDetailsError.details = {
    id: 'pipe_1',
    password: 'plain-password',
    headers: {
      Authorization: 'Bearer live-token',
      'x-api-key': 'api-key-value',
    },
    rawPayload: {
      token: 'raw-token',
    },
    nested: {
      cookie: 'sid=secret',
    },
  }
  const { services: sensitiveDetailsServices } = createMockServices({
    pipelineRegistry: {
      async listPipelines() {
        throw sensitiveDetailsError
      },
    },
  })
  const { routes: sensitiveDetailsRoutes } = mountRoutes(sensitiveDetailsServices)
  const sensitiveDetailsRes = await invoke(sensitiveDetailsRoutes, 'GET', '/api/integration/pipelines', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1' },
  })
  assert.equal(sensitiveDetailsRes.statusCode, 502)
  assert.equal(sensitiveDetailsRes.body.error.code, 'ERP_REQUEST_FAILED')
  assert.equal(sensitiveDetailsRes.body.error.details.id, 'pipe_1')
  assert.equal(sensitiveDetailsRes.body.error.details.password, '[redacted]')
  assert.equal(sensitiveDetailsRes.body.error.details.headers.Authorization, '[redacted]')
  assert.equal(sensitiveDetailsRes.body.error.details.headers['x-api-key'], '[redacted]')
  assert.equal(sensitiveDetailsRes.body.error.details.rawPayload, '[redacted]')
  assert.equal(sensitiveDetailsRes.body.error.details.nested.cookie, '[redacted]')
  const errorJson = JSON.stringify(sensitiveDetailsRes.body.error)
  assert.doesNotMatch(errorJson, /plain-password|live-token|api-key-value|raw-token|sid=secret/)

  const validationError = new Error('bad input')
  validationError.name = 'PipelineValidationError'
  const { services: validationServices } = createMockServices({
    pipelineRegistry: {
      async listPipelines() {
        throw validationError
      },
    },
  })
  const { routes: validationRoutes } = mountRoutes(validationServices)
  const validationRes = await invoke(validationRoutes, 'GET', '/api/integration/pipelines', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1' },
  })
  assert.equal(validationRes.statusCode, 400)
  assert.equal(validationRes.body.error.code, 'PipelineValidationError')

  const notFoundError = new Error('not found')
  notFoundError.name = 'ExternalSystemNotFoundError'
  const { services: notFoundServices } = createMockServices({
    externalSystemRegistry: {
      async getExternalSystem() {
        throw notFoundError
      },
    },
  })
  const { routes: notFoundRoutes } = mountRoutes(notFoundServices)
  const notFoundRes = await invoke(notFoundRoutes, 'GET', '/api/integration/external-systems/:id', {
    user: READ_USER,
    params: { id: 'missing' },
    query: { workspaceId: 'workspace_1' },
  })
  assert.equal(notFoundRes.statusCode, 404)

  // PipelineConflictError (thrown by concurrent-run guard) maps to 409
  const conflictError = new Error('pipeline already has a run in progress')
  conflictError.name = 'PipelineConflictError'
  conflictError.details = { pipelineId: 'pipe_1', runningRunId: 'run_existing' }
  const { services: conflictServices } = createMockServices({
    pipelineRunner: {
      async runPipeline() {
        throw conflictError
      },
    },
  })
  const { routes: conflictRoutes } = mountRoutes(conflictServices)
  const conflictRes = await invoke(conflictRoutes, 'POST', '/api/integration/pipelines/:id/run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1' },
  })
  assert.equal(conflictRes.statusCode, 409)
  assert.equal(conflictRes.body.ok, false)
  assert.equal(conflictRes.body.error.code, 'PipelineConflictError')
  assert.equal(conflictRes.body.error.details.runningRunId, 'run_existing')
}

async function testTenantGuards() {
  const { services } = createMockServices()
  const { routes } = mountRoutes(services)

  const mismatch = await invoke(routes, 'GET', '/api/integration/pipelines', {
    user: READ_USER,
    query: { tenantId: 'tenant_2', workspaceId: 'workspace_1' },
  })
  assert.equal(mismatch.statusCode, 403)
  assert.equal(mismatch.body.error.code, 'TENANT_MISMATCH')

  const missingContext = await invoke(routes, 'GET', '/api/integration/pipelines', {
    user: { id: 'reader_without_tenant', permissions: ['integration:read'] },
    query: { tenantId: 'tenant_1', workspaceId: 'workspace_1' },
  })
  assert.equal(missingContext.statusCode, 403)
  assert.equal(missingContext.body.error.code, 'TENANT_CONTEXT_REQUIRED')

  const blankContext = await invoke(routes, 'GET', '/api/integration/pipelines', {
    user: { id: 'reader_blank_tenant', tenantId: '   ', permissions: ['integration:read'] },
    query: { tenantId: 'tenant_1', workspaceId: 'workspace_1' },
  })
  assert.equal(blankContext.statusCode, 403)
  assert.equal(blankContext.body.error.code, 'TENANT_CONTEXT_REQUIRED')
}

async function testCursorStringGuard() {
  const { calls, services } = createMockServices()
  const { routes } = mountRoutes(services)

  // cursor as object → 400 INVALID_CURSOR
  const objRes = await invoke(routes, 'POST', '/api/integration/pipelines/:id/run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1', cursor: { malicious: true } },
  })
  assert.equal(objRes.statusCode, 400, 'object cursor → 400')
  assert.equal(objRes.body.error.code, 'INVALID_CURSOR', 'error code is INVALID_CURSOR')
  assert.equal(objRes.body.error.details.received, 'object', 'received=object reported')

  // cursor as array → 400 INVALID_CURSOR (received=array, not object)
  const arrRes = await invoke(routes, 'POST', '/api/integration/pipelines/:id/dry-run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1', cursor: ['c', 'd'] },
  })
  assert.equal(arrRes.statusCode, 400, 'array cursor → 400')
  assert.equal(arrRes.body.error.code, 'INVALID_CURSOR')
  assert.equal(arrRes.body.error.details.received, 'array', 'received=array (distinguished from object)')

  // cursor as number → 400 INVALID_CURSOR
  const numRes = await invoke(routes, 'POST', '/api/integration/pipelines/:id/run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1', cursor: 42 },
  })
  assert.equal(numRes.statusCode, 400, 'numeric cursor → 400')
  assert.equal(numRes.body.error.code, 'INVALID_CURSOR')

  // cursor as valid string → passes through to runPipeline
  const strRes = await invoke(routes, 'POST', '/api/integration/pipelines/:id/run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1', cursor: 'page-token-abc' },
  })
  assertOkResponse(strRes, 202)
  const runCall = findCall(calls, 'runPipeline')
  assert.equal(runCall[1].cursor, 'page-token-abc', 'string cursor passed through')

  // No cursor → not in input
  const { calls: noCalls, services: noServices } = createMockServices()
  const { routes: noRoutes } = mountRoutes(noServices)
  await invoke(noRoutes, 'POST', '/api/integration/pipelines/:id/run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1' },
  })
  assert.equal('cursor' in findCall(noCalls, 'runPipeline')[1], false, 'absent cursor → not in input')
}

async function testSampleLimitCap() {
  const { MAX_SAMPLE_LIMIT } = httpRoutes
  assert.equal(typeof MAX_SAMPLE_LIMIT, 'number', 'MAX_SAMPLE_LIMIT is exported')

  // Huge sampleLimit on /run is clamped to MAX_SAMPLE_LIMIT
  const { calls: runCalls, services: runServices } = createMockServices()
  const { routes: runRoutes } = mountRoutes(runServices)
  const hugeLimit = String(MAX_SAMPLE_LIMIT + 999999)
  await invoke(runRoutes, 'POST', '/api/integration/pipelines/:id/run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1', sampleLimit: hugeLimit },
  })
  assert.equal(findCall(runCalls, 'runPipeline')[1].sampleLimit, MAX_SAMPLE_LIMIT,
    '/run: huge sampleLimit clamped to MAX_SAMPLE_LIMIT')

  // Huge sampleLimit on /dry-run is also clamped
  const { calls: dryCalls, services: dryServices } = createMockServices()
  const { routes: dryRoutes } = mountRoutes(dryServices)
  await invoke(dryRoutes, 'POST', '/api/integration/pipelines/:id/dry-run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1', sampleLimit: hugeLimit },
  })
  assert.equal(findCall(dryCalls, 'runPipeline')[1].sampleLimit, MAX_SAMPLE_LIMIT,
    '/dry-run: huge sampleLimit clamped to MAX_SAMPLE_LIMIT')

  // sampleLimit = 0 → stripped (undefined)
  const { calls: zeroCalls, services: zeroServices } = createMockServices()
  const { routes: zeroRoutes } = mountRoutes(zeroServices)
  await invoke(zeroRoutes, 'POST', '/api/integration/pipelines/:id/dry-run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1', sampleLimit: 0 },
  })
  assert.equal('sampleLimit' in findCall(zeroCalls, 'runPipeline')[1], false,
    'sampleLimit=0 is stripped from input (publicRunInput deletes falsy keys)')

  // Small valid sampleLimit passes through unchanged
  const { calls: smallCalls, services: smallServices } = createMockServices()
  const { routes: smallRoutes } = mountRoutes(smallServices)
  await invoke(smallRoutes, 'POST', '/api/integration/pipelines/:id/dry-run', {
    user: WRITE_USER,
    params: { id: 'pipe_1' },
    body: { workspaceId: 'workspace_1', sampleLimit: 5 },
  })
  assert.equal(findCall(smallCalls, 'runPipeline')[1].sampleLimit, 5,
    'small valid sampleLimit passes through unchanged')
}

async function testListOffsetCap() {
  const { MAX_LIST_OFFSET } = httpRoutes
  assert.equal(typeof MAX_LIST_OFFSET, 'number', 'MAX_LIST_OFFSET is exported')

  // Large offset (above cap) must be clamped at all 4 list endpoints
  const hugeOffset = String(MAX_LIST_OFFSET + 999999)
  const { calls: sysCalls, services: sysServices } = createMockServices()
  const { routes: sysRoutes } = mountRoutes(sysServices)
  await invoke(sysRoutes, 'GET', '/api/integration/external-systems', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', offset: hugeOffset },
  })
  assert.equal(findCall(sysCalls, 'listExternalSystems')[1].offset, MAX_LIST_OFFSET,
    'external-systems: huge offset clamped to MAX_LIST_OFFSET')

  const { calls: pipCalls, services: pipServices } = createMockServices()
  const { routes: pipRoutes } = mountRoutes(pipServices)
  await invoke(pipRoutes, 'GET', '/api/integration/pipelines', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', offset: hugeOffset },
  })
  assert.equal(findCall(pipCalls, 'listPipelines')[1].offset, MAX_LIST_OFFSET,
    'pipelines: huge offset clamped to MAX_LIST_OFFSET')

  const { calls: runCalls, services: runServices } = createMockServices()
  const { routes: runRoutes } = mountRoutes(runServices)
  await invoke(runRoutes, 'GET', '/api/integration/runs', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', offset: hugeOffset },
  })
  assert.equal(findCall(runCalls, 'listPipelineRuns')[1].offset, MAX_LIST_OFFSET,
    'runs: huge offset clamped to MAX_LIST_OFFSET')

  const { calls: dlCalls, services: dlServices } = createMockServices()
  const { routes: dlRoutes } = mountRoutes(dlServices)
  await invoke(dlRoutes, 'GET', '/api/integration/dead-letters', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', offset: hugeOffset },
  })
  assert.equal(findCall(dlCalls, 'listDeadLetters')[1].offset, MAX_LIST_OFFSET,
    'dead-letters: huge offset clamped to MAX_LIST_OFFSET')

  // offset = 0 → treated as no offset (undefined)
  const { calls: zeroCalls, services: zeroServices } = createMockServices()
  const { routes: zeroRoutes } = mountRoutes(zeroServices)
  await invoke(zeroRoutes, 'GET', '/api/integration/pipelines', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', offset: '0' },
  })
  assert.equal(findCall(zeroCalls, 'listPipelines')[1].offset, undefined,
    'offset=0 is treated as no offset (undefined)')

  // Small valid offset passes through unchanged
  const { calls: smallCalls, services: smallServices } = createMockServices()
  const { routes: smallRoutes } = mountRoutes(smallServices)
  await invoke(smallRoutes, 'GET', '/api/integration/pipelines', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', offset: '50' },
  })
  assert.equal(findCall(smallCalls, 'listPipelines')[1].offset, 50,
    'small valid offset passes through unchanged')
}

async function testProvenanceReadRoute() {
  const { calls, services } = createMockServices()
  const { routes, registered } = mountRoutes(services)
  assert.ok(registered.includes('GET /api/integration/provenance'), 'provenance read route registered')

  // unauthenticated → 401/403, reached no service
  let res = await invoke(routes, 'GET', '/api/integration/provenance', { query: { rowId: 'k1' } })
  assertErrorResponse(res, [401, 403])
  assert.equal(findCalls(calls, 'listProvenanceByRow').length, 0, 'unauthenticated read did not reach the registry')

  // a non-integration permission → 403
  res = await invoke(routes, 'GET', '/api/integration/provenance', { user: { permissions: ['other:read'] }, query: { rowId: 'k1' } })
  assertErrorResponse(res, [403])

  // read permission but missing rowId → 400, short-circuits before the registry
  res = await invoke(routes, 'GET', '/api/integration/provenance', { user: READ_USER, query: {} })
  assertErrorResponse(res, [400])
  assert.equal(res.body.error.code, 'ROW_ID_REQUIRED')
  assert.equal(findCalls(calls, 'listProvenanceByRow').length, 0, 'missing rowId short-circuits before the registry')

  // happy path: read permission + rowId → 200; scoped input carries rowId/window/pipeline
  res = await invoke(routes, 'GET', '/api/integration/provenance', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1', rowId: 'k1', pipelineId: 'pipe_1', from: '2026-04-24T00:00:00.000Z', to: '2026-04-25T00:00:00.000Z' },
  })
  assertOkResponse(res, 200)
  assert.ok(Array.isArray(res.body.data) && res.body.data.length === 1, 'timeline array returned')
  assert.deepEqual(
    Object.keys(res.body.data[0]).sort(),
    ['at', 'attrs', 'eventIndex', 'eventType', 'pipelineId', 'rowId', 'runCreatedAt', 'runId', 'runMode', 'runStatus'],
    'serialized entry has exactly the timeline fields (no drop, no extra)',
  )
  const provCall = findCall(calls, 'listProvenanceByRow')[1]
  assert.equal(provCall.rowId, 'k1')
  assert.equal(provCall.pipelineId, 'pipe_1')
  assert.equal(provCall.from, '2026-04-24T00:00:00.000Z')
  assert.equal(provCall.to, '2026-04-25T00:00:00.000Z')

  // write permission also grants read (and reaches the registry, not just a 200 shell)
  res = await invoke(routes, 'GET', '/api/integration/provenance', { user: WRITE_USER, query: { rowId: 'k1' } })
  assertOkResponse(res, 200)
  assert.ok(findCalls(calls, 'listProvenanceByRow').length >= 2, 'write permission also reached the registry')

  // 501 when a host's registry predates listProvenanceByRow (optional-method, like replay)
  const noProv = createMockServices()
  delete noProv.services.pipelineRegistry.listProvenanceByRow
  const { routes: noProvRoutes } = mountRoutes(noProv.services)
  res = await invoke(noProvRoutes, 'GET', '/api/integration/provenance', { user: READ_USER, query: { rowId: 'k1' } })
  assertErrorResponse(res, [501])
  assert.equal(res.body.error.code, 'PROVENANCE_READ_NOT_IMPLEMENTED')
}

async function testTemplatesDeriveRoute() {
  const { services } = createMockServices()
  const { routes } = mountRoutes(services)
  const sample = {
    FNumber: 'M1',
    FName: 'Widget',
    FUnitID: { FNumber: '01', FName: 'PCS' },
    FBaseUnitID: { FNumber: '01', FName: 'PCS' },
  }

  // unauthenticated → 401/403
  let res = await invoke(routes, 'POST', '/api/integration/templates/derive', { body: { payloadTemplate: sample } })
  assertErrorResponse(res, [401, 403])

  // read user → 200 (READ-ONLY route); response is the DF-T2a draft (the route reuses T2a)
  res = await invoke(routes, 'POST', '/api/integration/templates/derive', { user: READ_USER, body: { payloadTemplate: sample } })
  assertOkResponse(res, 200)
  const draft = res.body.data
  const byField = Object.fromEntries(draft.fieldRules.map((rule) => [rule.targetField, rule]))
  assert.equal(byField.FNumber.sourceType, 'from_staging', 'scalar → replace')
  assert.equal(byField.FUnitID.sourceType, 'preserve_template', 'reference → preserve')
  assert.ok(!('FBaseUnitID' in byField), 'gated FBaseUnitID excluded from authorable rules')
  assert.deepEqual(draft.gatedFields, ['FBaseUnitID'])
  // P1: the response does NOT echo the raw payloadTemplate (no operator-local customer values);
  // it returns a values-free evidence summary instead.
  assert.ok(!('payloadTemplate' in draft), 'response does not echo the raw payloadTemplate')
  assert.ok(draft.evidence && Array.isArray(draft.evidence.fields), 'response includes a values-free evidence summary')
  const draftJson = JSON.stringify(draft)
  assert.ok(!draftJson.includes('Widget') && !draftJson.includes('PCS'), 'response carries no raw customer values')

  // 400 when payloadTemplate is missing / not an object
  res = await invoke(routes, 'POST', '/api/integration/templates/derive', { user: READ_USER, body: {} })
  assertErrorResponse(res, [400])
  assert.equal(res.body.error.code, 'PAYLOAD_TEMPLATE_REQUIRED')

  // 400 (fail-closed) on an outer K3 { Data: … } envelope — the DF-T2a guard, surfaced by the route
  res = await invoke(routes, 'POST', '/api/integration/templates/derive', { user: READ_USER, body: { payloadTemplate: { Data: { FNumber: 'X' } } } })
  assertErrorResponse(res, [400])
  assert.equal(res.body.error.code, 'TEMPLATE_DERIVE_REJECTED')

  // 400 (fail-closed) on a redaction marker — never derive an executable template from it
  res = await invoke(routes, 'POST', '/api/integration/templates/derive', { user: READ_USER, body: { payloadTemplate: { FNumber: '[redacted]', FName: 'X' } } })
  assertErrorResponse(res, [400])
  assert.equal(res.body.error.code, 'TEMPLATE_DERIVE_REJECTED')
}

// DF-T3b-2a: the OPERATOR preview surface (buildTargetPayloadPreview) must actually RESOLVE a
// from_reference_table reference via the injected (server-side) mapping index — the parity test does
// not exercise this path, so it gets its own coverage here (wire-vs-fixture: test the real surface).
async function testTemplatePreviewReferenceMappingResolution() {
  const { buildTargetPayloadPreview } = httpRoutes.__internals
  const { buildReferenceMappingIndex } = require(path.join(__dirname, '..', 'lib', 'reference-mapping-resolver.cjs'))
  const { K3_REFERENCE_MAPPING_TEMPLATES } = require(path.join(__dirname, '..', 'lib', 'reference-mapping-templates.cjs'))
  const unitGroup = K3_REFERENCE_MAPPING_TEMPLATES.find((t) => t.domain === 'unit-group')
  const input = {
    bodyKey: 'Data',
    payloadTemplate: {},
    sourceRecord: { unitGroupSourceCode: 'STD' },
    fieldRules: [{ targetField: 'FUnitGroupID', sourceType: 'from_reference_table', domain: 'unit-group', sourceField: 'unitGroupSourceCode', shape: 'object-passthrough', completeness: 'require-fnumber-fname' }],
  }

  // happy: injected index → resolved object in the payload; evidence 'resolved'; valid; values-free
  const okIndexes = { 'unit-group': buildReferenceMappingIndex(unitGroup, [{ sourceCode: 'STD', fNumber: '10', fName: 'Each', enabled: true }]) }
  const ok = buildTargetPayloadPreview(input, { referenceMappingIndexes: okIndexes })
  // field-level asserts (the payload uses null-prototype objects from setPath — fine for JSON/wire,
  // but node:assert/strict deepEqual is prototype-sensitive).
  assert.equal(ok.payload.Data.FUnitGroupID.FNumber, '10', 'operator preview resolves FNumber via the injected index')
  assert.equal(ok.payload.Data.FUnitGroupID.FName, 'Each', 'operator preview resolves FName via the injected index')
  assert.equal(ok.valid, true)
  const okRes = ok.targetPayloadPreview.referenceResolutions
  assert.equal(okRes.length, 1)
  assert.equal(okRes[0].status, 'resolved')
  assert.equal(okRes[0].field, 'FUnitGroupID')
  assert.equal(okRes[0].evidence.errorType, undefined, 'resolved → no errorType')
  assert.ok(!JSON.stringify(okRes[0].evidence).includes('Each') && !JSON.stringify(okRes[0].evidence).includes('STD'), 'resolution evidence is values-free')

  // three non-resolved statuses → valid:false (fail-closed via placeholder) + correct errorType
  const cases = {
    unresolved: [{ sourceCode: 'OTHER', fNumber: '9', fName: 'X', enabled: true }],
    ambiguous: [{ sourceCode: 'STD', fNumber: 'A', fName: 'X', enabled: true }, { sourceCode: 'STD', fNumber: 'B', fName: 'Y', enabled: true }],
    'incomplete-row': [{ sourceCode: 'STD', fNumber: 'A', enabled: true }],
  }
  for (const [errorType, rows] of Object.entries(cases)) {
    const out = buildTargetPayloadPreview(input, { referenceMappingIndexes: { 'unit-group': buildReferenceMappingIndex(unitGroup, rows) } })
    assert.equal(out.valid, false, `${errorType}: operator preview fail-closed`)
    assert.ok(out.placeholderErrors.some((e) => /FUnitGroupID/.test(e.field)), `${errorType}: placeholder fires on the unresolved field`)
    assert.equal(out.targetPayloadPreview.referenceResolutions[0].evidence.errorType, errorType, `${errorType}: evidence errorType`)
  }

  // no index injected (T3b-2a default; live bulk-read is T3b-2b) → unresolved fail-closed
  const noIdx = buildTargetPayloadPreview(input, {})
  assert.equal(noIdx.valid, false, 'no index → unresolved fail-closed')
  assert.equal(noIdx.targetPayloadPreview.referenceResolutions[0].evidence.errorType, 'unresolved')
}

// DF-T3b-2b: the preview ROUTE performs a LIVE mapping-sheet bulk-read via the staging source-adapter
// (real adapter + mocked recordsApi through the registry) and resolves from_reference_table — read-only.
async function testTemplatePreviewLiveBulkRead() {
  const { createMetaSheetStagingSourceAdapter } = require(path.join(__dirname, '..', 'lib', 'adapters', 'metasheet-staging-source-adapter.cjs'))
  const stagingSystem = {
    id: 'ms_staging_1', tenantId: 'tenant_1', workspaceId: 'workspace_1', name: 'staging', kind: 'metasheet:staging', role: 'source',
    config: { objects: { unit_dict: { name: 'unit_dict', sheetId: 'sheet_unit', fieldDetails: [
      { id: 'sourceCode', name: 'sourceCode', type: 'string' }, { id: 'fNumber', name: 'fNumber', type: 'string' },
      { id: 'fName', name: 'fName', type: 'string' }, { id: 'enabled', name: 'enabled', type: 'boolean' },
    ] } } },
  }
  let queryCalls = 0
  let currentRows = []
  const { services } = createMockServices()
  services.externalSystemRegistry.getExternalSystemForAdapter = async (input) => ({ ...stagingSystem, id: input.id })
  // a REAL staging source-adapter backed by a mocked recordsApi (the live bulk-read path, not a fixture index)
  services.adapterRegistry.createAdapter = () => createMetaSheetStagingSourceAdapter({
    system: stagingSystem,
    context: { api: { multitable: { records: { async queryRecords(input) {
      queryCalls += 1
      const offset = Number(input.offset || 0); const limit = Number(input.limit || currentRows.length)
      return currentRows.slice(offset, offset + limit)
    } } } } },
  })
  const { routes } = mountRoutes(services)
  const previewBody = () => ({
    bodyKey: 'Data', payloadTemplate: {}, sourceRecord: { unitGroupSourceCode: 'STD' },
    fieldRules: [{ targetField: 'FUnitGroupID', sourceType: 'from_reference_table', domain: 'unit', sourceField: 'unitGroupSourceCode', shape: 'object-passthrough', completeness: 'require-fnumber-fname' }],
    referenceMappingSources: [{ domain: 'unit', systemId: 'ms_staging_1', object: 'unit_dict' }],
  })

  // resolved via the LIVE bulk-read
  currentRows = [{ id: 'm1', sheetId: 'sheet_unit', data: { sourceCode: 'STD', fNumber: '10', fName: 'Each', enabled: true } }]
  let res = await invoke(routes, 'POST', '/api/integration/templates/preview', { user: WRITE_USER, body: previewBody() })
  assert.ok(queryCalls >= 1, 'route ran a live bulk-read (queryRecords called via the staging adapter)')
  assert.equal(res.body.data.payload.Data.FUnitGroupID.FNumber, '10', 'preview resolved FNumber from the live mapping sheet')
  assert.equal(res.body.data.payload.Data.FUnitGroupID.FName, 'Each')
  assert.equal(res.body.data.valid, true)
  assert.equal(res.body.data.targetPayloadPreview.referenceResolutions[0].status, 'resolved')

  // three-state fail-closed at the preview layer, all via the live bulk-read
  const cases = {
    unresolved: [{ id: 'm1', sheetId: 'sheet_unit', data: { sourceCode: 'OTHER', fNumber: '9', fName: 'X', enabled: true } }],
    ambiguous: [
      { id: 'm1', sheetId: 'sheet_unit', data: { sourceCode: 'STD', fNumber: 'A', fName: 'X', enabled: true } },
      { id: 'm2', sheetId: 'sheet_unit', data: { sourceCode: 'STD', fNumber: 'B', fName: 'Y', enabled: true } },
    ],
    'incomplete-row': [{ id: 'm1', sheetId: 'sheet_unit', data: { sourceCode: 'STD', fNumber: 'A', enabled: true } }],
  }
  for (const [errorType, rows] of Object.entries(cases)) {
    currentRows = rows
    res = await invoke(routes, 'POST', '/api/integration/templates/preview', { user: WRITE_USER, body: previewBody() })
    assert.equal(res.body.data.valid, false, `${errorType}: preview fail-closed via live bulk-read`)
    assert.equal(res.body.data.targetPayloadPreview.referenceResolutions[0].evidence.errorType, errorType, `${errorType}: evidence errorType`)
  }

  // a bad domain (no built-in template) is rejected 400
  currentRows = []
  res = await invoke(routes, 'POST', '/api/integration/templates/preview', { user: WRITE_USER, body: { ...previewBody(), referenceMappingSources: [{ domain: 'not-a-domain', systemId: 'ms_staging_1', object: 'x' }] } })
  assert.equal(res.body.error.code, 'INVALID_TEMPLATE_PREVIEW', 'unknown reference mapping domain rejected')
}

// DF-T3b-2b P1/P2: the bulk-read entry point must fail closed on (P1) a non-staging system — so the
// preview can't become an arbitrary-adapter read() into K3/other externals — and (P2) a duplicate
// domain — never silently last-wins. Both reject BEFORE any adapter is created / any read runs.
async function testTemplatePreviewBulkReadGuards() {
  const { createMetaSheetStagingSourceAdapter } = require(path.join(__dirname, '..', 'lib', 'adapters', 'metasheet-staging-source-adapter.cjs'))
  const stagingSystem = {
    id: 'ms_staging_1', tenantId: 'tenant_1', workspaceId: 'workspace_1', name: 'staging', kind: 'metasheet:staging', role: 'source',
    config: { objects: { unit_dict: { name: 'unit_dict', sheetId: 'sheet_unit', fieldDetails: [
      { id: 'sourceCode', name: 'sourceCode', type: 'string' }, { id: 'fNumber', name: 'fNumber', type: 'string' },
      { id: 'fName', name: 'fName', type: 'string' }, { id: 'enabled', name: 'enabled', type: 'boolean' },
    ] } } },
  }
  let createAdapterCalls = 0
  let queryCalls = 0
  const { services } = createMockServices()
  // an 'erp' (non-staging) system for id 'erp_sys'; staging otherwise
  services.externalSystemRegistry.getExternalSystemForAdapter = async (input) =>
    input.id === 'erp_sys'
      ? { id: 'erp_sys', tenantId: 'tenant_1', workspaceId: 'workspace_1', name: 'K3', kind: 'erp', role: 'target' }
      : { ...stagingSystem, id: input.id }
  services.adapterRegistry.createAdapter = (system) => {
    createAdapterCalls += 1
    return createMetaSheetStagingSourceAdapter({ system, context: { api: { multitable: { records: { async queryRecords() { queryCalls += 1; return [] } } } } } })
  }
  const { routes } = mountRoutes(services)
  const rule = { targetField: 'FUnitGroupID', sourceType: 'from_reference_table', domain: 'unit', sourceField: 'unitGroupSourceCode', shape: 'object-passthrough', completeness: 'require-fnumber-fname' }
  const base = { bodyKey: 'Data', payloadTemplate: {}, sourceRecord: { unitGroupSourceCode: 'STD' }, fieldRules: [rule] }

  // P1: a non-staging systemId → 400, and the adapter is NEVER created / NO read runs
  let res = await invoke(routes, 'POST', '/api/integration/templates/preview', { user: WRITE_USER, body: { ...base, referenceMappingSources: [{ domain: 'unit', systemId: 'erp_sys', object: 'unit_dict' }] } })
  assert.equal(res.body.error.code, 'INVALID_TEMPLATE_PREVIEW', 'P1: non-staging system rejected')
  assert.equal(createAdapterCalls, 0, 'P1: a non-staging system NEVER creates an adapter')
  assert.equal(queryCalls, 0, 'P1: a non-staging system NEVER triggers a read')

  // P2: duplicate domain → 400, rejected before any adapter/read (no silent last-wins)
  res = await invoke(routes, 'POST', '/api/integration/templates/preview', { user: WRITE_USER, body: { ...base, referenceMappingSources: [
    { domain: 'unit', systemId: 'ms_staging_1', object: 'unit_dict' },
    { domain: 'unit', systemId: 'ms_staging_1', object: 'other_sheet' },
  ] } })
  assert.equal(res.body.error.code, 'INVALID_TEMPLATE_PREVIEW', 'P2: duplicate domain rejected')
  assert.equal(createAdapterCalls, 0, 'P2: duplicate-domain config rejected before any adapter/read')

  // control: a valid staging source still works (the guards do not block the happy path)
  res = await invoke(routes, 'POST', '/api/integration/templates/preview', { user: WRITE_USER, body: { ...base, referenceMappingSources: [{ domain: 'unit', systemId: 'ms_staging_1', object: 'unit_dict' }] } })
  assert.equal(createAdapterCalls, 1, 'a valid staging source DOES create the adapter')
  assert.ok(queryCalls >= 1, 'a valid staging source DOES read')
}

function tableActionConfig(overrides = {}) {
  const { source: sourceOverrides = {}, target: targetOverrides = {}, ...rest } = overrides
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    ...rest,
    source: {
      externalSystemId: 'plm_sql_source',
      kind: 'data-source:sql-readonly',
      ...sourceOverrides,
    },
    target: {
      sheetId: 'sheet_stock_configured',
      objectId: 'stockPreparationMain',
      ...targetOverrides,
    },
  }
}

function tableActionConfigWithIncompleteTargetFieldMap() {
  return {
    ...tableActionConfig(),
    target: {
      sheetId: 'sheet_stock_configured',
      objectId: 'stockPreparationMain',
      fieldIdMap: {
        projectNo: 'fld_project_no',
        componentSourceId: 'fld_component_source_id',
      },
    },
  }
}

function tableActionPlmData() {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function createTableActionSourceAdapter(data = tableActionPlmData(), calls = []) {
  return {
    async read(input = {}) {
      calls.push(['sourceRead', clone(input)])
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected),
      )
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || 1000
      const records = matches.slice(offset, offset + limit).map(clone)
      return {
        records,
        done: offset + records.length >= matches.length,
        nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null,
      }
    },
  }
}

function createTableActionRecordsApi() {
  const rows = []
  const calls = []
  const recordsApi = {
    async queryRecords(input = {}) {
      calls.push(['queryRecords', clone(input)])
      return rows
        .filter((row) => row.sheetId === input.sheetId)
        .filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row.data[field] === expected))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
        .map(clone)
    },
    async createRecord(input = {}) {
      calls.push(['createRecord', clone(input)])
      const record = {
        id: `rec_${rows.length + 1}`,
        sheetId: input.sheetId,
        version: 1,
        data: { ...(input.data || {}) },
      }
      rows.push(record)
      return clone(record)
    },
    async patchRecord(input = {}) {
      calls.push(['patchRecord', clone(input)])
      const row = rows.find((entry) => entry.sheetId === input.sheetId && entry.id === input.recordId)
      if (!row) throw new Error(`record not found: ${input.recordId}`)
      row.version += 1
      row.data = { ...row.data, ...(input.changes || {}) }
      return clone(row)
    },
  }
  return { rows, calls, recordsApi }
}

function createStockPreparationTargetProvisioningApi({
  sheetExists = false,
  missingFields = [],
} = {}) {
  const calls = []
  let sheet = sheetExists
    ? { id: 'sheet_stock_canonical_private', baseId: 'base_stock', name: 'PLM Stock Preparation Main', description: null }
    : null
  let missing = new Set(missingFields)
  const api = {
    async findObjectSheet(input) {
      calls.push(['findObjectSheet', clone(input)])
      return sheet ? clone(sheet) : null
    },
    async resolveFieldIds(input) {
      calls.push(['resolveFieldIds', clone(input)])
      const out = {}
      for (const fieldId of input.fieldIds || []) {
        if (!missing.has(fieldId)) out[fieldId] = `fld_${fieldId}`
      }
      return out
    },
    async ensureObject(input) {
      calls.push(['ensureObject', clone(input)])
      sheet = { id: 'sheet_stock_canonical_created', baseId: input.baseId || 'base_default', name: input.descriptor.name, description: input.descriptor.description || null }
      missing = new Set()
      return {
        baseId: sheet.baseId,
        sheet: clone(sheet),
        fields: input.descriptor.fields.map((field, index) => ({
          id: `physical_${index}_${field.id}`,
          sheetId: sheet.id,
          name: field.name,
          type: field.type,
          property: field.property || {},
          order: index,
        })),
      }
    },
    async patchObjectFieldProperty(input) {
      calls.push(['patchObjectFieldProperty', clone(input)])
      return {
        id: `fld_${input.fieldId}`,
        sheetId: sheet ? sheet.id : 'sheet_stock_canonical_private',
        name: input.fieldId,
        type: 'select',
        property: clone(input.propertyPatch || {}),
        order: calls.length,
      }
    },
  }
  return { api, calls }
}

async function testStockPreparationTargetProvisioningRoutes() {
  const provisioning = createStockPreparationTargetProvisioningApi()
  const records = createTableActionRecordsApi()
  const { routes, registered } = mountRoutes(createMockServices().services, {
    provisioningApi: provisioning.api,
    recordsApi: records.recordsApi,
  })

  assert.ok(
    registered.includes('GET /api/integration/stock-preparation/target/readiness'),
    'stock-preparation target readiness route registered',
  )
  assert.ok(
    registered.includes('POST /api/integration/stock-preparation/target/ensure'),
    'stock-preparation target ensure route registered',
  )

  let res = await invoke(routes, 'GET', '/api/integration/stock-preparation/target/readiness', {
    user: WRITE_USER,
    query: { projectId: 'tenant_1:integration-core' },
  })
  assert.equal(res.statusCode, 403, 'write user cannot inspect target readiness')
  assert.equal(provisioning.calls.length, 0, 'non-admin request does not reach provisioning API')

  res = await invoke(routes, 'POST', '/api/integration/stock-preparation/target/ensure', {
    user: ADMIN_USER,
    body: { projectId: 'tenant_1:integration-core', sheetId: 'evil_sheet', permission: 'admin' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_TARGET_REQUEST_INVALID')
  assert.equal(provisioning.calls.length, 0, 'client-supplied sheetId/permission is rejected before provisioning')

  res = await invoke(routes, 'GET', '/api/integration/stock-preparation/target/readiness', {
    user: ADMIN_USER,
    query: { projectId: 'tenant_1:integration-core' },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.ready, false)
  assert.equal(res.body.data.mode, 'canonical_missing')
  assert.equal(res.body.data.targetBinding, null)
  assert.equal(res.body.data.evidence.status, 'missing')
  assert.equal(res.body.data.evidence.missingFields.length, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.length)
  assert.equal(JSON.stringify(res.body.data.evidence).includes('sheet_stock'), false, 'readiness evidence hides sheet id')
  assert.equal(records.calls.length, 0, 'readiness route never uses records API')

  res = await invoke(routes, 'POST', '/api/integration/stock-preparation/target/ensure', {
    user: ADMIN_USER,
    body: { projectId: 'tenant_1:integration-core', baseId: 'base_stock' },
  })
  assertOkResponse(res, 201)
  assert.equal(res.body.data.ready, true)
  assert.equal(res.body.data.mode, 'canonical_create')
  assert.deepEqual(res.body.data.targetBinding, {
    sheetId: 'sheet_stock_canonical_created',
    objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    keyField: 'idempotencyKey',
    fieldIdMap: STOCK_PREPARATION_RESOLVED_FIELD_ID_MAP,
  })
  assert.equal(res.body.data.evidence.target.fieldIdMapEmpty, false)
  assert.equal(JSON.stringify(res.body.data.evidence).includes('sheet_stock_canonical_created'), false, 'ensure evidence hides sheet id')
  const ensureCall = findCalls(provisioning.calls, 'ensureObject')[0]
  assert.equal(ensureCall[1].projectId, 'tenant_1:integration-core')
  assert.equal(ensureCall[1].baseId, 'base_stock')
  assert.deepEqual(
    ensureCall[1].descriptor.fields.map((field) => field.id),
    STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id),
    'ensure descriptor is manifest-derived',
  )
  assert.equal(records.calls.length, 0, 'ensure route never uses records API')

  const existing = createStockPreparationTargetProvisioningApi({ sheetExists: true })
  const existingMount = mountRoutes(createMockServices().services, {
    provisioningApi: existing.api,
    recordsApi: createTableActionRecordsApi().recordsApi,
  })
  res = await invoke(existingMount.routes, 'POST', '/api/integration/stock-preparation/target/ensure', {
    user: ADMIN_USER,
    body: { workspaceId: 'workspace_1' },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.mode, 'canonical_existing')
  assert.deepEqual(res.body.data.targetBinding.fieldIdMap, STOCK_PREPARATION_RESOLVED_FIELD_ID_MAP)
  assert.equal(res.body.data.evidence.target.fieldIdMapEmpty, false)
  assert.equal(findCalls(existing.calls, 'ensureObject').length, 0, 'existing complete target is bound, not recreated')
  assert.equal(findCalls(existing.calls, 'findObjectSheet')[0][1].projectId, 'tenant_1:integration-core', 'default projectId is integration-core scoped')

  const incomplete = createStockPreparationTargetProvisioningApi({ sheetExists: true, missingFields: ['path'] })
  const incompleteMount = mountRoutes(createMockServices().services, {
    provisioningApi: incomplete.api,
    recordsApi: createTableActionRecordsApi().recordsApi,
  })
  res = await invoke(incompleteMount.routes, 'POST', '/api/integration/stock-preparation/target/ensure', {
    user: ADMIN_USER,
    body: { projectId: 'tenant_1:integration-core' },
  })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(res.body.error.details.missingFields, ['path'])
  assert.equal(JSON.stringify(res.body.error).includes('sheet_stock_canonical_private'), false, 'incomplete error hides sheet id')
  assert.equal(findCalls(incomplete.calls, 'ensureObject').length, 0, 'incomplete existing target is not repaired in place')
}

async function testStockPreparationOptionSyncRoute() {
  const provisioning = createStockPreparationTargetProvisioningApi({ sheetExists: true })
  const records = createTableActionRecordsApi()
  const { routes, registered } = mountRoutes(createMockServices().services, {
    provisioningApi: provisioning.api,
    recordsApi: records.recordsApi,
  })

  assert.ok(
    registered.includes('POST /api/integration/stock-preparation/options/sync'),
    'stock-preparation option sync route registered',
  )

  let res = await invoke(routes, 'POST', '/api/integration/stock-preparation/options/sync', {
    user: WRITE_USER,
    body: { projectId: 'tenant_1:integration-core', optionSets: { material_type: [{ value: 'plate' }] } },
  })
  assert.equal(res.statusCode, 403, 'write user cannot sync stock-preparation options')
  assert.equal(findCalls(provisioning.calls, 'patchObjectFieldProperty').length, 0)

  res = await invoke(routes, 'POST', '/api/integration/stock-preparation/options/sync', {
    user: ADMIN_USER,
    body: {
      projectId: 'tenant_1:integration-core',
      optionSets: {
        material_type: [{
          value: 'plate',
          label: 'Plate',
          actionBindings: [{ actionId: PLM_STOCK_PREPARATION_ACTION_ID }],
        }],
        blank_type: [{ value: 'casting', label: 'Casting' }],
        stock_preparation_status: [{ value: 'pending', label: 'Pending' }],
      },
    },
  })
  assertOkResponse(res, 200)
  const patches = findCalls(provisioning.calls, 'patchObjectFieldProperty')
  assert.equal(patches.length, 4, 'route syncs contract decision + three configured option fields')
  const materialPatch = patches.find((call) => call[1].fieldId === 'materialType')
  assert.ok(materialPatch, 'materialType patch is present')
  assert.deepEqual(materialPatch[1].propertyPatch.options, [{ value: 'plate', label: 'Plate' }])
  assert.equal(materialPatch[1].propertyPatch.stockPreparation.optionActionBindings[0].actionId, PLM_STOCK_PREPARATION_ACTION_ID)
  assert.equal(materialPatch[1].propertyPatch.stockPreparation.optionActionBindings[0].requiresDryRun, true)
  assert.equal(JSON.stringify(res.body.data.evidence).includes('plate'), false, 'route evidence hides option values')
  assert.equal(JSON.stringify(res.body.data.evidence).includes('Casting'), false, 'route evidence hides option labels')
  assert.equal(records.calls.length, 0, 'option sync route never uses records API')

  res = await invoke(routes, 'POST', '/api/integration/stock-preparation/options/sync', {
    user: ADMIN_USER,
    body: { projectId: 'tenant_1:integration-core', sql: 'select 1' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'STOCK_PREPARATION_OPTION_SYNC_REQUEST_INVALID')

  res = await invoke(routes, 'POST', '/api/integration/stock-preparation/options/sync', {
    user: ADMIN_USER,
    body: {
      projectId: 'tenant_1:integration-core',
      optionSets: {
        material_type: [{
          value: 'plate',
          actionBindings: [{ actionId: PLM_STOCK_PREPARATION_ACTION_ID, handler: 'runAnything' }],
        }],
      },
    },
  })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.error.code, 'OPTION_SYNC_EXECUTABLE_REJECTED')
}

async function testTableActionRoutes() {
  const adapterCalls = []
  const records = createTableActionRecordsApi()
  const { calls, services } = createMockServices({
    externalSystemRegistry: {
      async getExternalSystemForAdapter(input) {
        calls.push(['getExternalSystemForAdapter', input])
        return {
          id: input.id,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          name: 'Readonly PLM SQL',
          kind: 'data-source:sql-readonly',
          role: 'source',
          config: { dataSourceId: 'ds_plm', object: 'DN_PDM_PathExAttrInfo' },
        }
      },
    },
    adapterRegistry: {
      createAdapter(system, deps) {
        calls.push(['createAdapter', system, deps])
        adapterCalls.push({ system, deps })
        return createTableActionSourceAdapter(tableActionPlmData(), calls)
      },
    },
  })
  const { routes } = mountRoutes(services, {
    recordsApi: records.recordsApi,
    config: {
      stockPreparationTableActions: [tableActionConfig()],
    },
  })

  let res = await invoke(routes, 'GET', '/api/integration/table-actions', {
    user: READ_USER,
    query: { workspaceId: 'workspace_1' },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data[0].actionId, PLM_STOCK_PREPARATION_ACTION_ID)
  assert.equal(res.body.data[0].configured, true)
  assert.equal(JSON.stringify(res.body).includes('sheet_stock_configured'), false, 'list route does not expose target sheetId')
  assert.equal(JSON.stringify(res.body).includes('plm_sql_source'), false, 'list route does not expose source binding')

  res = await invoke(routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', {
    user: READ_USER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: {
      parameters: { projectNo: 'P-001' },
      sheetId: 'evil_sheet',
    },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'TABLE_ACTION_REQUEST_INVALID', 'client-supplied sheetId is rejected at the route boundary')
  assert.equal(adapterCalls.length, 0, 'rejected body does not create a source adapter')

  res = await invoke(routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', {
    user: READ_USER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: { parameters: { projectNo: ' P-001 ' } },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.status, 'ready')
  assert.equal(typeof res.body.data.dryRunToken, 'string', 'dry-run returns a server token')
  assert.equal(adapterCalls[0].deps.principal, 'user_read', 'dry-run source read runs as the request user')
  assert.equal(records.calls[0][1].sheetId, 'sheet_stock_configured', 'existing-row read is scoped to configured target sheet')
  assert.deepEqual(records.calls[0][1].filters, { projectNo: 'P-001' }, 'existing-row read is project-scoped')
  assert.equal(JSON.stringify(res.body.data.evidence).includes('P-001'), false, 'dry-run evidence is values-free')
  const dryRunToken = res.body.data.dryRunToken

  res = await invoke(routes, 'POST', '/api/integration/table-actions/:actionId/apply', {
    user: READ_USER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: {
      parameters: { projectNo: 'P-001' },
      confirm: { dryRunToken },
    },
  })
  assert.equal(res.statusCode, 403, 'read-only user cannot apply')

  res = await invoke(routes, 'POST', '/api/integration/table-actions/:actionId/apply', {
    user: WRITE_USER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: {
      parameters: { projectNo: 'P-001' },
      confirm: { dryRunToken },
      plan: { decisions: [] },
    },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'TABLE_ACTION_REQUEST_INVALID', 'client-supplied C3 plan is rejected')

  // The prior rejected apply did not consume the token because the body was rejected before token validation.
  res = await invoke(routes, 'POST', '/api/integration/table-actions/:actionId/apply', {
    user: ADMIN_USER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: {
      parameters: { projectNo: 'P-001' },
      confirm: { dryRunToken },
    },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.permission, 'admin', 'apply passes the authenticated admin permission, not hardcoded write')
  assert.equal(res.body.data.apply.counts.created, 1)
  const createCall = records.calls.find((call) => call[0] === 'createRecord')
  assert.equal(createCall[1].sheetId, 'sheet_stock_configured', 'apply writes only the configured target sheet')
  assert.equal(JSON.stringify(res.body.data.evidence).includes('P-001'), false, 'apply evidence is values-free')
  assert.equal(JSON.stringify(res.body.data.evidence).includes('A-001'), false, 'apply evidence hides component code')
}

async function testTableActionRoutesSupportExplicitBridgeSource() {
  const adapterCalls = []
  const records = createTableActionRecordsApi()
  const bridgeAction = tableActionConfig({
    source: {
      externalSystemId: 'bridge_plm_source',
      kind: 'bridge:legacy-sql-readonly',
    },
  })
  const { calls, services } = createMockServices({
    externalSystemRegistry: {
      async getExternalSystemForAdapter(input) {
        calls.push(['getExternalSystemForAdapter', input])
        return {
          id: input.id,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          name: 'Readonly Bridge PLM',
          kind: 'bridge:legacy-sql-readonly',
          role: 'source',
          config: { baseUrl: 'http://127.0.0.1:19091/' },
        }
      },
    },
    adapterRegistry: {
      createAdapter(system, deps) {
        calls.push(['createAdapter', system, deps])
        adapterCalls.push({ system, deps })
        return createTableActionSourceAdapter(tableActionPlmData(), calls)
      },
    },
  })
  const { routes } = mountRoutes(services, {
    recordsApi: records.recordsApi,
    config: {
      stockPreparationTableActions: [bridgeAction],
    },
  })

  let res = await invoke(routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', {
    user: READ_USER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: { parameters: { projectNo: 'P-001' } },
  })
  assertOkResponse(res, 200)
  assert.equal(res.body.data.status, 'ready')
  assert.equal(adapterCalls[0].system.kind, 'bridge:legacy-sql-readonly', 'Bridge source action creates the Bridge adapter')
  assert.equal(adapterCalls[0].deps.principal, 'user_read', 'Bridge dry-run source read runs as the request user')
  const sourceReads = findCalls(calls, 'sourceRead')
  assert.ok(sourceReads.length > 0, 'Bridge dry-run reaches the source adapter')
  assert.equal(
    sourceReads.every((call) => call[1].filters && Object.keys(call[1].filters).length > 0),
    true,
    'Bridge dry-run uses equality-filtered flat reads',
  )

  const mismatch = createMockServices({
    externalSystemRegistry: {
      async getExternalSystemForAdapter(input) {
        calls.push(['mismatchGetExternalSystemForAdapter', input])
        return {
          id: input.id,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          name: 'Data Source PLM',
          kind: 'data-source:sql-readonly',
          role: 'source',
        }
      },
    },
    adapterRegistry: {
      createAdapter(system, deps) {
        calls.push(['mismatchCreateAdapter', system, deps])
        return createTableActionSourceAdapter(tableActionPlmData(), calls)
      },
    },
  })
  const mismatchMount = mountRoutes(mismatch.services, {
    recordsApi: createTableActionRecordsApi().recordsApi,
    config: {
      stockPreparationTableActions: [bridgeAction],
    },
  })
  res = await invoke(mismatchMount.routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', {
    user: READ_USER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: { parameters: { projectNo: 'P-001' } },
  })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.error.code, 'TABLE_ACTION_SOURCE_INVALID', 'source kind mismatch fails closed')
  assert.equal(findCalls(mismatch.calls, 'mismatchCreateAdapter').length, 0, 'kind mismatch fails before adapter creation')
}

async function testTableActionTargetPreflightBeforeSourceAdapter() {
  const { calls, services } = createMockServices({
    externalSystemRegistry: {
      async getExternalSystemForAdapter(input) {
        calls.push(['getExternalSystemForAdapter', input])
        return {
          id: input.id,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          name: 'Readonly PLM SQL',
          kind: 'data-source:sql-readonly',
          role: 'source',
        }
      },
    },
    adapterRegistry: {
      createAdapter(system, deps) {
        calls.push(['createAdapter', system, deps])
        return createTableActionSourceAdapter(tableActionPlmData(), calls)
      },
    },
  })
  const records = createTableActionRecordsApi()
  const { routes } = mountRoutes(services, {
    recordsApi: records.recordsApi,
    config: {
      stockPreparationTableActions: [tableActionConfigWithIncompleteTargetFieldMap()],
    },
  })

  const res = await invoke(routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', {
    user: READ_USER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: { parameters: { projectNo: 'P-001' } },
  })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.equal(res.body.error.details.fieldMapMode, 'explicit')
  assert.ok(res.body.error.details.missingFields.includes('idempotencyKey'), 'missing idempotencyKey is reported')
  assert.ok(res.body.error.details.missingFields.includes('path'), 'missing path is reported')
  const errorText = JSON.stringify(res.body.error)
  assert.equal(errorText.includes('sheet_stock_configured'), false, 'target sheetId is not exposed in target-schema error')
  assert.equal(errorText.includes('plm_sql_source'), false, 'source binding is not exposed in target-schema error')
  assert.equal(findCalls(calls, 'getExternalSystemForAdapter').length, 0, 'target preflight fails before loading the source system')
  assert.equal(findCalls(calls, 'createAdapter').length, 0, 'target preflight fails before creating the source adapter')
  assert.equal(records.calls.length, 0, 'target preflight fails before target reads')
}

async function testTableActionUnconfiguredFailsClosed() {
  const { routes } = mountRoutes(createMockServices().services)
  const res = await invoke(routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', {
    user: READ_USER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: { parameters: { projectNo: 'P-001' } },
  })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.error.code, 'TABLE_ACTION_NOT_CONFIGURED')
}

async function main() {
  await testUnauthenticatedWriteRequestIsRejected()
  await testStockPreparationTargetProvisioningRoutes()
  await testStockPreparationOptionSyncRoute()
  await testTableActionRoutes()
  await testTableActionRoutesSupportExplicitBridgeSource()
  await testTableActionTargetPreflightBeforeSourceAdapter()
  await testTableActionUnconfiguredFailsClosed()
  await testTemplatePreviewReferenceMappingResolution()
  await testTemplatePreviewLiveBulkRead()
  await testTemplatePreviewBulkReadGuards()
  await testExternalSystemRoutes()
  await testExternalSystemUpsertPreservesObjectSchema()
  await testExternalSystemTestPersistsFailureAndPreservesInactive()
  await testExternalSystemTestClearsErrorToActiveOnSuccess()
  await testExternalSystemTestRequiresSavedSystem()
  await testExternalSystemTestRedactsAdapterResultSecrets()
  await testDiscoveryRoutes()
  await testDiscoveryObjectsRouteDoesNotDefaultTruncateAdapterObjects()
  await testDiscoveryRoutesRejectUnknownSystem()
  await testBridgeDanglingDataSourceMapsTo4xxNot500()
  await testDocumentTemplateValidation()
  await testPipelineRoutes()
  await testTemplatePreviewRoute()
  await testTemplatesDeriveRoute()
  await testStagingRoutes()
  await testRunAndDeadLetterRoutes()
  await testProvenanceReadRoute()
  await testErrorResponseShape()
  await testTenantGuards()
  await testCursorStringGuard()
  await testSampleLimitCap()
  await testListOffsetCap()

  console.log('http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed')
}

main().catch((err) => {
  console.error('http-routes FAILED')
  console.error(err)
  process.exit(1)
})
