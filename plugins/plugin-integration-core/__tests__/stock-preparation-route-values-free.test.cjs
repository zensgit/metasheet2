'use strict'

// VALUES-FREE 500s ON EVERY STOCK-PREP AND TABLE-ACTION ROUTE (integration-layer audit, 2026-10-10).
//
// lib/http-routes.cjs `VALUES_FREE_ROUTE_ERROR_MAPPERS`: a stock-prep / table-action handler that lets an UNTYPED
// error escape answers ONE fixed code and message with empty details (the four S3 handlers keep their own
// STOCK_PREPARATION_PROJECT_ROUTE_FAILED); a typed refusal answers exactly what the plain `sendError` answered
// before. This suite is the guard:
//
//   V-1  COMPLETENESS, derived from the registration code (every `addRoute` call `registerIntegrationRoutes`
//        makes, the internal SQL Server run included): a stock-prep / table-action route whose handler is in no
//        values-free set is red; any other route that is in neither a values-free set nor the integration
//        line's pending list is red; the sets are disjoint and name no unregistered handler.
//   V-2  the derivation is live: a route pushed onto ROUTES at test time (stock-prep, unwrapped) and one
//        (integration, unlisted) are both reported — a hand-written route list would miss them.
//   V-3  every registered stock-prep / table-action route, with the REQUEST itself throwing an untyped error
//        that carries a sentinel host and password: 500, the fixed code and message, empty details, the
//        sentinel nowhere in the body; exactly one warn line, naming the route template, sentinel-free.
//   V-4  other untyped shapes (driver code without status, pg SQLSTATE, a status-500 error with a non-code
//        `code`, an out-of-range status, a thrown string, a throwing getter) — same fixed 500, no sentinel.
//   V-5  a handler DEPENDENCY throwing: an admin request against services / host APIs whose every method
//        throws the sentinel — no body carries it, every 500 is the fixed code, and the dependency path is
//        actually reached on many routes (not vacuous).
//   V-6  typed refusals are unchanged: on every stock-prep route, the wrapped answer for 400 / 401 / 403 / 404 /
//        409 / 422 / 501 / typed-500 / class-named / data-source-message errors deep-equals what the plain
//        `sendError` answers for the same error.
//   V-7  the typed predicate never throws.
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { runFailClosedSuite } = require(path.join(__dirname, 'support', 'fail-closed-suite-runner.cjs'))

const {
  STOCK_PREPARATION_S3_VALUES_FREE_HANDLERS,
  STOCK_PREPARATION_VALUES_FREE_HANDLERS,
  INTEGRATION_ADMIN_VALUES_FREE_PENDING,
  VALUES_FREE_ROUTE_ERROR_MAPPERS,
  STOCK_PREPARATION_ROUTE_FAILED_CODE,
  stockPreparationRouteErrorIsTyped,
  sendError,
} = httpRoutes.__internals

const SENTINEL_HOST = 'spvf-sentinel-db.internal.example'
const SENTINEL_SECRET = 'Spvf-Pw-7731'
const SENTINEL_MESSAGE = `connect ECONNREFUSED ${SENTINEL_HOST}:5432 password=${SENTINEL_SECRET}`
const S3_ROUTE_FAILED_CODE = 'STOCK_PREPARATION_PROJECT_ROUTE_FAILED'
const FIXED_MESSAGE = 'the request could not be completed; this response does not describe the failure'

/** A stock-prep or table-action route — by its registered PATH, never by a list. */
function isStockPreparationRoutePath(routePath) {
  return /\/stock-preparation(\/|$)/.test(routePath) || /^\/api\/integration\/table-actions(\/|$)/.test(routePath)
}

function inertService(name, makeError) {
  return new Proxy({}, {
    get: (_target, method) => {
      if (method === 'then') return undefined
      return async () => { throw makeError(`${name}.${String(method)}`) }
    },
  })
}

/**
 * Mount the REAL registration with every service present (so the optional internal SQL Server run route is
 * registered too) and capture every `addRoute` it makes. The returned list IS the route list under guard.
 */
function mountAll({ makeError = () => new Error('unexpected service call') } = {}) {
  const routes = []
  const warnings = []
  const services = new Proxy({}, { get: (_target, name) => (typeof name === 'string' ? inertService(name, makeError) : undefined) })
  httpRoutes.registerIntegrationRoutes({
    context: {
      api: {
        http: { addRoute(method, routePath, handler) { routes.push({ method, path: routePath, key: `${method} ${routePath}`, handler }) } },
        multitable: { provisioning: inertService('provisioning', makeError), records: inertService('records', makeError) },
      },
      storage: new Map(),
      config: {},
    },
    services,
    logger: { info() {}, error() {}, warn(...args) { warnings.push(args) } },
  })
  return { routes, warnings }
}

/** The registered [method, path] → handler-name pairs, joined back to the definitions the registration used. */
function registeredRouteDefinitions() {
  const { routes } = mountAll()
  const definitions = [...httpRoutes.ROUTES, httpRoutes.STOCK_PREPARATION_SQLSERVER_RUNTIME_ROUTE]
  const byKey = new Map(definitions.map(([method, routePath, handlerName]) => [`${method} ${routePath}`, handlerName]))
  return routes.map((route) => {
    assert.ok(byKey.has(route.key), `registered route ${route.key} has a definition`)
    return { method: route.method, path: route.path, handlerName: byKey.get(route.key) }
  })
}

/** What V-1 checks, as data: every way a registered route can escape the values-free registry. */
function valuesFreeCoverageProblems(definitions) {
  const problems = []
  const pending = new Set(INTEGRATION_ADMIN_VALUES_FREE_PENDING)
  const wrapped = (name) => VALUES_FREE_ROUTE_ERROR_MAPPERS.some((entry) => entry.handlers.has(name))
  for (const { method, path: routePath, handlerName } of definitions) {
    if (isStockPreparationRoutePath(routePath)) {
      if (!wrapped(handlerName)) problems.push(`stock-prep route ${method} ${routePath} (${handlerName}) is in no values-free set`)
      if (pending.has(handlerName)) problems.push(`stock-prep route ${method} ${routePath} (${handlerName}) is listed as integration-pending`)
    } else {
      if (STOCK_PREPARATION_VALUES_FREE_HANDLERS.has(handlerName) || STOCK_PREPARATION_S3_VALUES_FREE_HANDLERS.has(handlerName)) {
        problems.push(`non-stock-prep route ${method} ${routePath} (${handlerName}) is in a stock-prep values-free set`)
      }
      if (!wrapped(handlerName) && !pending.has(handlerName)) {
        problems.push(`route ${method} ${routePath} (${handlerName}) is in neither a values-free set nor INTEGRATION_ADMIN_VALUES_FREE_PENDING`)
      }
    }
  }
  return problems
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(payload) { this.sentBuffer = payload; return this },
  }
}

/** A request object whose every property read throws `thrown` — the handler's first touch of its input fails. */
function throwingRequest(makeThrown) {
  return new Proxy({}, { get: () => { throw makeThrown() } })
}

async function invoke(route, req) {
  const res = createResponse()
  await route.handler(req, res)
  return res
}

/** What the plain `sendError` answers for `error` — "today", before any values-free mapping. */
function plainAnswer(error) {
  const res = createResponse()
  sendError(res, error)
  return { status: res.statusCode, body: JSON.parse(JSON.stringify(res.body)) }
}

function expectedFixedCode(handlerName) {
  return STOCK_PREPARATION_S3_VALUES_FREE_HANDLERS.has(handlerName) ? S3_ROUTE_FAILED_CODE : STOCK_PREPARATION_ROUTE_FAILED_CODE
}

function assertSentinelFree(text, label) {
  assert.ok(!text.includes(SENTINEL_HOST), `${label}: the sentinel host is echoed: ${text}`)
  assert.ok(!text.includes(SENTINEL_SECRET), `${label}: the sentinel secret is echoed: ${text}`)
  assert.ok(!text.includes('spvf-sentinel'), `${label}: a sentinel fragment is echoed: ${text}`)
}

function stockPreparationRoutes(mounted, definitions) {
  const byKey = new Map(definitions.map((definition) => [`${definition.method} ${definition.path}`, definition.handlerName]))
  return mounted.routes
    .filter((route) => isStockPreparationRoutePath(route.path))
    .map((route) => ({ ...route, handlerName: byKey.get(route.key) }))
}

const tests = []
function test(name, fn) { tests.push([name, fn]) }

// ── V-1 ────────────────────────────────────────────────────────────────────────────────────────────
test('V-1 completeness: every registered stock-prep / table-action route is in a values-free set, every other route is values-free or explicitly pending, the sets are disjoint and name only registered handlers', () => {
  const definitions = registeredRouteDefinitions()
  assert.deepEqual(valuesFreeCoverageProblems(definitions), [])
  const registeredHandlers = new Set(definitions.map((definition) => definition.handlerName))
  const stockPrepCount = definitions.filter((definition) => isStockPreparationRoutePath(definition.path)).length
  // Not vacuous: the stock-prep surface is large and the internal SQL Server run is among it.
  assert.ok(stockPrepCount >= 85, `stock-prep / table-action routes registered: ${stockPrepCount}`)
  assert.ok(definitions.some((definition) => definition.handlerName === 'stockPreparationSqlServerSealedSnapshotRun'))
  // Disjoint: a handler belongs to at most one values-free set, and never to one AND the pending list.
  const seen = new Map()
  const lists = [
    ...VALUES_FREE_ROUTE_ERROR_MAPPERS.map((entry, index) => [`mapper#${index}`, [...entry.handlers]]),
    ['pending', [...INTEGRATION_ADMIN_VALUES_FREE_PENDING]],
  ]
  for (const [label, names] of lists) {
    for (const name of names) {
      assert.ok(!seen.has(name), `${name} is in both ${seen.get(name)} and ${label}`)
      seen.set(name, label)
      assert.ok(registeredHandlers.has(name), `${label} names ${name}, which no registered route uses`)
    }
  }
  assert.ok(VALUES_FREE_ROUTE_ERROR_MAPPERS.some((entry) => entry.handlers === STOCK_PREPARATION_VALUES_FREE_HANDLERS))
  assert.ok(VALUES_FREE_ROUTE_ERROR_MAPPERS.some((entry) => entry.handlers === STOCK_PREPARATION_S3_VALUES_FREE_HANDLERS))
})

// ── V-2 ────────────────────────────────────────────────────────────────────────────────────────────
test('V-2 the derivation is live: a stock-prep route added to ROUTES without the wrapper, and an integration route in neither list, are both reported', () => {
  const probeStockPrep = ['GET', '/api/integration/stock-preparation/spvf-probe-unwrapped', 'spvfProbeUnwrappedStockPreparation']
  const probeIntegration = ['GET', '/api/integration/spvf-probe-unlisted', 'spvfProbeUnlistedIntegration']
  const before = httpRoutes.ROUTES.length
  httpRoutes.ROUTES.push(probeStockPrep, probeIntegration)
  try {
    const problems = valuesFreeCoverageProblems(registeredRouteDefinitions())
    assert.ok(problems.some((line) => line.includes('spvfProbeUnwrappedStockPreparation') && line.includes('in no values-free set')), problems.join('\n'))
    assert.ok(problems.some((line) => line.includes('spvfProbeUnlistedIntegration') && line.includes('neither')), problems.join('\n'))
    assert.equal(problems.length, 2, problems.join('\n'))
  } finally {
    httpRoutes.ROUTES.splice(before, 2)
  }
  assert.equal(httpRoutes.ROUTES.length, before)
  assert.deepEqual(valuesFreeCoverageProblems(registeredRouteDefinitions()), [])
})

// ── V-3 ────────────────────────────────────────────────────────────────────────────────────────────
test('V-3 every stock-prep / table-action route: an untyped error carrying a host and a password answers the fixed 500 with empty details, and logs one sentinel-free line naming the route template', async () => {
  const definitions = registeredRouteDefinitions()
  const mounted = mountAll()
  const routes = stockPreparationRoutes(mounted, definitions)
  assert.ok(routes.length >= 85, `driven: ${routes.length}`)
  for (const route of routes) {
    const warningsBefore = mounted.warnings.length
    const res = await invoke(route, throwingRequest(() => new Error(SENTINEL_MESSAGE)))
    const text = JSON.stringify(res.body)
    assert.equal(res.statusCode, 500, `${route.key}: ${text}`)
    assert.equal(res.body.ok, false, route.key)
    assert.equal(res.body.error.code, expectedFixedCode(route.handlerName), `${route.key}: ${text}`)
    assert.deepEqual({ ...res.body.error.details }, {}, `${route.key}: details must be empty`)
    if (!STOCK_PREPARATION_S3_VALUES_FREE_HANDLERS.has(route.handlerName)) assert.equal(res.body.error.message, FIXED_MESSAGE, route.key)
    assertSentinelFree(text, route.key)
    const lines = mounted.warnings.slice(warningsBefore)
    assert.equal(lines.length, 1, `${route.key}: exactly one warn line (got ${lines.length})`)
    assert.ok(String(lines[0][0]).includes(`${route.method} ${route.path}`), `${route.key}: the warn line names the route template`)
    assertSentinelFree(JSON.stringify(lines[0]), `${route.key} warn line`)
  }
})

// ── V-4 ────────────────────────────────────────────────────────────────────────────────────────────
test('V-4 other untyped shapes — driver code without status, pg SQLSTATE, a 500 with a non-code `code`, an out-of-range status, a thrown string, a throwing getter — all answer the fixed 500 without the sentinel', async () => {
  const shapes = [
    ['driver code, no status', () => Object.assign(new Error(SENTINEL_MESSAGE), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' })],
    ['pg SQLSTATE 22007', () => Object.assign(new Error(`invalid input syntax for type date: "${SENTINEL_SECRET}" at ${SENTINEL_HOST}`), { code: '22007' })],
    ['pg SQLSTATE 42703', () => Object.assign(new Error(`column "${SENTINEL_SECRET}" does not exist on ${SENTINEL_HOST}`), { code: '42703' })],
    ['status 500, non-code code', () => Object.assign(new Error(SENTINEL_MESSAGE), { status: 500, code: `bad ${SENTINEL_HOST}` })],
    ['status 500, no code', () => Object.assign(new Error(SENTINEL_MESSAGE), { status: 500 })],
    ['status out of range', () => Object.assign(new Error(SENTINEL_MESSAGE), { status: 200, code: 'LOOKS_TYPED' })],
    ['thrown string', () => SENTINEL_MESSAGE],
    ['throwing getter', () => ({ get status() { throw new Error(SENTINEL_MESSAGE) }, get code() { throw new Error(SENTINEL_MESSAGE) }, message: SENTINEL_MESSAGE })],
  ]
  const definitions = registeredRouteDefinitions()
  const mounted = mountAll()
  const routes = stockPreparationRoutes(mounted, definitions).filter((route) => !STOCK_PREPARATION_S3_VALUES_FREE_HANDLERS.has(route.handlerName))
  for (const [label, makeThrown] of shapes) {
    for (const route of routes) {
      const res = await invoke(route, throwingRequest(makeThrown))
      const text = JSON.stringify(res.body)
      assert.equal(res.statusCode, 500, `${label} ${route.key}: ${text}`)
      assert.equal(res.body.error.code, STOCK_PREPARATION_ROUTE_FAILED_CODE, `${label} ${route.key}: ${text}`)
      assertSentinelFree(text, `${label} ${route.key}`)
    }
  }
  assertSentinelFree(JSON.stringify(mounted.warnings.map((args) => args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))))), 'warn lines')
})

// ── V-5 ────────────────────────────────────────────────────────────────────────────────────────────
test('V-5 a handler dependency throwing: an admin request against services and host APIs whose every method throws the sentinel — no body carries it, every 500 is the fixed code, and the dependency path is reached', async () => {
  const definitions = registeredRouteDefinitions()
  const mounted = mountAll({ makeError: (where) => new Error(`${SENTINEL_MESSAGE} (${where})`) })
  const routes = stockPreparationRoutes(mounted, definitions)
  const admin = {
    id: 'u_spvf_admin',
    tenantId: 'tenant-spvf',
    roles: ['admin'],
    permissions: ['integration:admin', 'integration:write', 'integration:read', 'stock-prep:admin', 'stock-prep:operate', 'stock-prep:read', 'stock-prep:pull'],
  }
  const params = { actionId: 'plm-stock-preparation', projectNo: 'SPVF-1', jobId: 'job-spvf', applyJobId: 'apply-spvf', roleId: 'role-spvf', packId: 'pack-spvf', snapshotBatchId: 'batch-spvf' }
  let fixed = 0
  for (const route of routes) {
    const res = await invoke(route, { user: admin, body: {}, query: {}, params, headers: {} })
    const text = JSON.stringify(res.body)
    assertSentinelFree(text, route.key)
    if (res.statusCode === 500) {
      assert.equal(res.body.error.code, expectedFixedCode(route.handlerName), `${route.key}: ${text}`)
      fixed += 1
    }
  }
  assert.ok(fixed >= 15, `routes whose dependency failure reached the fixed 500: ${fixed}`)
})

// ── V-6 ────────────────────────────────────────────────────────────────────────────────────────────
test('V-6 typed refusals are unchanged on every stock-prep / table-action route: the wrapped answer deep-equals the plain sendError answer', async () => {
  const { HttpRouteError } = httpRoutes
  class SpvfThingNotFoundError extends Error { constructor(message) { super(message); this.name = 'SpvfThingNotFoundError' } }
  class SpvfThingConflictError extends Error { constructor(message) { super(message); this.name = 'SpvfThingConflictError' } }
  const typed = [
    [400, () => new HttpRouteError(400, 'SPVF_REQUEST_INVALID', 'bad request', { field: 'projectNo' })],
    [401, () => new HttpRouteError(401, 'UNAUTHENTICATED', 'Authentication required')],
    [403, () => Object.assign(new Error('Insufficient integration permissions'), { status: 403, code: 'FORBIDDEN' })],
    [404, () => new SpvfThingNotFoundError('the thing is not here')],
    [409, () => new SpvfThingConflictError('the thing changed')],
    [409, () => Object.assign(new Error('already exists'), { status: 409, code: 'STOCK_PREPARATION_PROJECT_TARGET_EXISTS', details: { projectNo: 'SPVF-1' } })],
    [422, () => new Error("Data source with id 'ds_spvf' not found")],
    [422, () => Object.assign(new Error('config invalid'), { status: 422, code: 'CONFIRM_CONFIG_INVALID', details: { reason: 'missing' } })],
    [501, () => new HttpRouteError(501, 'LARGE_BOM_JOB_STORE_UNAVAILABLE', 'not available')],
    [503, () => Object.assign(new Error('upgrade first'), { status: 503, code: 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE' })],
    [500, () => Object.assign(new Error('a deliberate typed server fault'), { status: 500, code: 'B2A_CONFIG_INVALID' })],
  ]
  const definitions = registeredRouteDefinitions()
  const mounted = mountAll()
  const routes = stockPreparationRoutes(mounted, definitions).filter((route) => !STOCK_PREPARATION_S3_VALUES_FREE_HANDLERS.has(route.handlerName))
  for (const [status, makeError] of typed) {
    const today = plainAnswer(makeError())
    assert.equal(today.status, status, `fixture ${today.body.error.code} answers ${status} today`)
    for (const route of routes) {
      const res = await invoke(route, throwingRequest(makeError))
      assert.equal(res.statusCode, today.status, `${route.key} ${today.body.error.code}`)
      assert.deepEqual(JSON.parse(JSON.stringify(res.body)), today.body, `${route.key} ${today.body.error.code}`)
    }
  }
})

// ── V-7 ────────────────────────────────────────────────────────────────────────────────────────────
test('V-7 the typed predicate is total: hostile thrown values are untyped, never an exception', () => {
  const hostile = [
    null,
    undefined,
    'a string',
    42,
    { get status() { throw new Error('boom') } },
    new Proxy({}, { get() { throw new Error('boom') }, getPrototypeOf() { throw new Error('boom') } }),
  ]
  for (const value of hostile) assert.equal(stockPreparationRouteErrorIsTyped(value), false)
  assert.equal(stockPreparationRouteErrorIsTyped(Object.assign(new Error('x'), { status: 404 })), true)
  assert.equal(stockPreparationRouteErrorIsTyped(new Error('x')), false)
})

runFailClosedSuite('stock-preparation-route-values-free.test.cjs', tests)
