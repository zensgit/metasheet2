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

async function main() {
  await testUnauthenticatedWriteRequestIsRejected()
  await testExternalSystemRoutes()
  await testPipelineRoutes()
  await testRunAndDeadLetterRoutes()
  await testErrorResponseShape()
  await testTenantGuards()

  console.log('http-routes: REST auth/list/upsert/run/dry-run/replay tests passed')
}

main().catch((err) => {
  console.error('http-routes FAILED')
  console.error(err)
  process.exit(1)
})
