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
          { id: 'standard_materials', name: 'Standard Materials', fields: ['code', 'name'] },
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
  assert.equal(inactiveUpdate.status, 'inactive', 'successful test does not activate inactive systems')
  assert.equal(inactiveUpdate.lastError, null)
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
    projectId: 'project_1',
    baseId: 'base_1',
  })

  const missingProject = await invoke(routes, 'POST', '/api/integration/staging/install', {
    user: WRITE_USER,
    body: {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
    },
  })
  assertErrorResponse(missingProject, [400])
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
  assert.deepEqual(res.body.error, {
    code: 'EXTERNAL_SYSTEM_CONFLICT',
    message: 'external system conflict',
    details: { id: 'sys_1' },
  })

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
  await testPipelineRoutes()
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
