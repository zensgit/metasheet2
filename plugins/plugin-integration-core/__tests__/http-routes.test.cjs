'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const HTTP_ROUTES_PATH = path.join(__dirname, '..', 'lib', 'http-routes.cjs')
const httpRoutes = require(HTTP_ROUTES_PATH)
const { MAX_LIST_LIMIT } = httpRoutes

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

function createMockContext() {
  const routes = new Map()

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
      },
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

function mountRoutes(services) {
  const { context, routes } = createMockContext()
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
        return ['http', 'erp:k3-wise-sqlserver', 'metasheet:staging', 'metasheet:multitable', 'custom:unknown']
      },
      createAdapter(input) {
        calls.push(['createAdapter', input])
        return {
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
          { name: 'FBaseUnitID', label: 'Base unit', type: 'string' },
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
      FBaseUnitID: 'Pcs',
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

async function main() {
  await testUnauthenticatedWriteRequestIsRejected()
  await testExternalSystemRoutes()
  await testExternalSystemTestPersistsFailureAndPreservesInactive()
  await testExternalSystemTestRequiresSavedSystem()
  await testExternalSystemTestRedactsAdapterResultSecrets()
  await testDiscoveryRoutes()
  await testDiscoveryRoutesRejectUnknownSystem()
  await testDocumentTemplateValidation()
  await testPipelineRoutes()
  await testTemplatePreviewRoute()
  await testStagingRoutes()
  await testRunAndDeadLetterRoutes()
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
