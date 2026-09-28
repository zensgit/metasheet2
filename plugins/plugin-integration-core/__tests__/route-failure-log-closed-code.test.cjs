'use strict'

// ---------------------------------------------------------------------------
// R2 — the route-failure log line names the response's error code, from a CLOSED list only.
// (docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §5 R2)
//
// Driven through the REAL route registration (registerIntegrationRoutes). Pins:
//   1. a listed code reaches the log verbatim, and it is the same code the response carries;
//   2. an unlisted code that SHARES a listed prefix (CONNECTION_ / DATA_SOURCE_ / SOURCE_), carries
//      a value, differs only by case or whitespace, or names an Object.prototype key is logged as
//      UNLISTED, and the raw string is nowhere in the log call;
//   3. a non-string or missing code is logged as UNLISTED (thrown primitives fall back to
//      INTERNAL_ERROR, which is what the response says too);
//   4. the HTTP status and body are byte-identical to the pre-R2 wrapper (replicated verbatim below)
//      for every case, and HttpRouteError still produces no log line;
//   5. TIMING — against the real external-systems registry + real connection resolver, a connection
//      that EXISTS but is refused and one that does NOT exist produce the same trace: the same
//      single warn call, in the same position, with the same arguments, the same number of
//      microtask ticks, and no read beyond the ones the pre-R2 wrapper already caused. The log
//      computation is synchronous and does no I/O, so it cannot open an existence side channel.
//
// Mutation self-check (each must turn this suite red): admit a code by prefix; log the raw
// `error.code`; drop the `code` field; put an `await` in front of the warn.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  ROUTES,
  registerIntegrationRoutes,
  createHandlers,
  HttpRouteError,
  __internals,
} = require(path.join(LIB, 'http-routes.cjs'))
const {
  sendError,
  ROUTE_FAILURE_LOGGABLE_CODES,
  ROUTE_FAILURE_UNLISTED_CODE,
  loggableRouteFailureCode,
} = __internals
const {
  createExternalSystemRegistry,
  ExternalSystemValidationError,
  ExternalSystemNotFoundError,
  ExternalSystemConflictError,
} = require(path.join(LIB, 'external-systems.cjs'))
const { createConnectionResolver } = require(path.join(LIB, 'connection-resolver.cjs'))

// Every value a case plants carries this marker, so "no value reached the log" is one substring check.
const MARK = 'zq9mark'
const METHOD = 'POST'
const ROUTE_PATH = '/api/integration/external-systems/:id/test'
const LOG_MESSAGE = `[plugin-integration-core] route failed: ${METHOD} ${ROUTE_PATH}`
const TENANT_ID = 'tenant_r2'
const USER_ID = 'user_r2'
const SYSTEM_ID = `sys_${MARK}`
const CONNECTION_ID = `ds_${MARK}`

// The wrapper exactly as it stood before R2 (registerIntegrationRoutes, origin/main 3d4984077),
// fed the same `createHandlers` handler. It is the "before" every response and trace is compared to.
function preR2RouteWrapper(method, routePath, handler, logger) {
  return async (req, res) => {
    try {
      return await handler(req, res)
    } catch (error) {
      if (logger && typeof logger.warn === 'function' && !(error instanceof HttpRouteError)) {
        logger.warn(`[plugin-integration-core] route failed: ${method} ${routePath}`)
      }
      return sendError(res, error)
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function unused(name) {
  return async () => { throw new Error(`${name} is not part of this suite`) }
}

function baseServices(externalSystemRegistry) {
  return {
    externalSystemRegistry,
    adapterRegistry: {
      listAdapterKinds() { return [] },
      createAdapter() { throw new Error('the load fails first; no adapter may be built') },
    },
    pipelineRegistry: {
      upsertPipeline: unused('upsertPipeline'),
      getPipeline: unused('getPipeline'),
      listPipelines: unused('listPipelines'),
      listPipelineRuns: unused('listPipelineRuns'),
    },
    pipelineRunner: { runPipeline: unused('runPipeline') },
    deadLetterStore: { listDeadLetters: unused('listDeadLetters') },
    stagingInstaller: { listStagingDescriptors() { return [] }, installStaging: unused('installStaging') },
    templateRegistry: {
      upsertTemplate: unused('upsertTemplate'),
      getTemplate: unused('getTemplate'),
      listTemplates: unused('listTemplates'),
      deleteTemplate: unused('deleteTemplate'),
      instantiateTemplate: unused('instantiateTemplate'),
    },
    readSourceConfigStore: {
      saveVersion: unused('saveVersion'), list: unused('list'), get: unused('get'), approve: unused('approve'),
      retire: unused('retire'), listAudit: unused('listAudit'), getForRuntime: unused('getForRuntime'),
    },
    readSourceCompositionConfigStore: {
      saveVersion: unused('saveVersion'), list: unused('list'), get: unused('get'), approve: unused('approve'),
      retire: unused('retire'), listAudit: unused('listAudit'), getForRuntime: unused('getForRuntime'),
    },
    bridgeAgentChecklistStore: {
      saveVersion: unused('saveVersion'), approve: unused('approve'), retire: unused('retire'), getForApply: unused('getForApply'),
    },
  }
}

// A registry whose adapter load throws whatever the case supplies (a fresh value per call).
function stubRegistry(events, makeThrown) {
  return {
    async listExternalSystems() { return [] },
    async upsertExternalSystem() { throw new Error('unused') },
    async getExternalSystem() { throw new Error('unused') },
    async deleteExternalSystem() { throw new Error('unused') },
    async getExternalSystemForAdapter() {
      events.push(['registry.getExternalSystemForAdapter'])
      throw makeThrown()
    },
  }
}

function createContext(routes) {
  return {
    api: {
      http: {
        addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
      },
      multitable: {
        provisioning: { async findObjectSheet() { return null }, async resolveFieldIds() { return {} }, async ensureObject() { throw new Error('unused') } },
        records: { async queryRecords() { return [] }, async createRecord() { throw new Error('unused') }, async patchRecord() { throw new Error('unused') } },
      },
    },
    storage: { async get() { return null }, async set() {}, async delete() {} },
    config: {},
  }
}

function createLogger(events) {
  const warns = []
  return {
    warns,
    logger: {
      info() {},
      error() {},
      warn(...args) {
        warns.push(args)
        events.push(['logger.warn', args])
        // Anything that ran between the warn and the response would land before this marker.
        queueMicrotask(() => events.push(['microtask queued by warn']))
      },
    },
  }
}

function createResponse(events) {
  return {
    statusCode: 200,
    body: undefined,
    bytes: undefined,
    status(code) {
      events.push(['res.status', code])
      this.statusCode = code
      return this
    },
    json(body) {
      const bytes = JSON.stringify(body)
      events.push(['res.json', bytes])
      this.body = body
      this.bytes = bytes
      return this
    },
  }
}

function createRequest() {
  return {
    user: { id: USER_ID, tenantId: TENANT_ID, permissions: ['integration:write'] },
    // A request value on every surface the wrapper could have interpolated.
    params: { id: SYSTEM_ID },
    query: { note: MARK },
    body: { note: MARK },
  }
}

// Count microtask ticks until the route promise settles. Deterministic for a given await structure,
// so an extra `await` / scheduled step anywhere on the failure path changes the number.
async function settleCounted(invoke) {
  let settled = false
  let outcome
  const run = (async () => {
    try {
      outcome = { ok: true, value: await invoke() }
    } catch (error) {
      outcome = { ok: false, error }
    }
    settled = true
  })()
  let ticks = 0
  while (!settled) {
    ticks += 1
    if (ticks > 100000) throw new Error('the route never settled on microtasks alone')
    await null
  }
  await run
  return { ticks, outcome }
}

// Mount the route both ways over ONE services object built by `buildServices(events)` and fire one
// request through the chosen wrapper. Fresh everything per call.
async function fire(kind, buildServices) {
  const events = []
  const routes = new Map()
  const context = createContext(routes)
  const { logger, warns } = createLogger(events)
  const services = buildServices(events)
  let route
  if (kind === 'r2') {
    registerIntegrationRoutes({ context, services, logger })
    route = routes.get(`${METHOD} ${ROUTE_PATH}`)
  } else {
    // The handler name this route is registered with, read from the shipped ROUTES table.
    const [, , handlerName] = ROUTES.find(([method, routePath]) => method === METHOD && routePath === ROUTE_PATH)
    route = preR2RouteWrapper(METHOD, ROUTE_PATH, createHandlers(services, { context, logger })[handlerName], logger)
  }
  assert.equal(typeof route, 'function', `route ${METHOD} ${ROUTE_PATH} must be registered`)
  const res = createResponse(events)
  const { ticks, outcome } = await settleCounted(() => route(createRequest(), res))
  // Let the marker queued by warn (if any) land before the trace is read.
  await null
  return { events, warns, res, ticks, outcome }
}

// The trace with each warn call reduced to its message — the only part the pre-R2 wrapper had.
function withoutWarnMeta(events) {
  return events.map((event) => (event[0] === 'logger.warn' ? ['logger.warn', [event[1][0]]] : event))
}

function describeOutcome(outcome) {
  if (outcome.ok) return { ok: true }
  const error = outcome.error
  return { ok: false, name: error && error.name, message: error && error.message }
}

// Fire one thrown value through both wrappers; assert everything the pre-R2 wrapper did is
// unchanged and return the R2 run for the case-specific log assertions.
async function fireBoth(makeThrown, label) {
  const build = (events) => baseServices(stubRegistry(events, makeThrown))
  const before = await fire('preR2', build)
  const after = await fire('r2', build)
  assert.equal(after.res.statusCode, before.res.statusCode, `${label}: status must not change`)
  assert.equal(after.res.bytes, before.res.bytes, `${label}: body bytes must not change`)
  assert.deepEqual(describeOutcome(after.outcome), describeOutcome(before.outcome), `${label}: settle outcome must not change`)
  assert.deepEqual(withoutWarnMeta(after.events), withoutWarnMeta(before.events), `${label}: same calls in the same order`)
  assert.equal(after.ticks, before.ticks, `${label}: no added async step`)
  assert.equal(after.warns.length, before.warns.length, `${label}: same number of warn calls`)
  return after
}

function assertLoggedCode(run, expected, label, { forbidden = [] } = {}) {
  assert.equal(run.warns.length, 1, `${label}: exactly one warn`)
  assert.deepEqual(run.warns[0], [LOG_MESSAGE, { code: expected }], `${label}: warn arguments`)
  const serialized = JSON.stringify(run.warns)
  assert.ok(!serialized.includes(MARK), `${label}: no planted value may reach the log`)
  for (const raw of forbidden) {
    if (typeof raw === 'string' && raw.length > 0) {
      assert.ok(!serialized.includes(raw), `${label}: the raw code must not reach the log`)
    }
  }
}

function codedError(code, name) {
  const error = new Error(`${MARK} message that must stay out of the log`)
  if (name !== undefined) error.name = name
  if (code !== undefined) error.code = code
  return error
}

// ---------------------------------------------------------------------------
// 0. The list itself.
// ---------------------------------------------------------------------------
function testListShape() {
  assert.ok(Object.isFrozen(ROUTE_FAILURE_LOGGABLE_CODES), 'the exported list is frozen')
  assert.equal(ROUTE_FAILURE_UNLISTED_CODE, 'UNLISTED')
  assert.ok(!ROUTE_FAILURE_LOGGABLE_CODES.includes(ROUTE_FAILURE_UNLISTED_CODE))
  assert.equal(new Set(ROUTE_FAILURE_LOGGABLE_CODES).size, ROUTE_FAILURE_LOGGABLE_CODES.length, 'no duplicates')
  for (const code of ROUTE_FAILURE_LOGGABLE_CODES) {
    assert.match(code, /^[A-Za-z][A-Za-z0-9_]*$/, `listed word ${code} is a bare identifier`)
  }
  // Pinned verbatim: widening the list is a reviewed change to this array, never a side effect.
  assert.deepEqual([...ROUTE_FAILURE_LOGGABLE_CODES].sort(), [
    'CONNECTION_BINDING_MISMATCH',
    'CONNECTION_CANONICAL_UNAVAILABLE',
    'CONNECTION_ID_MISMATCH',
    'CONNECTION_ID_REQUIRED',
    'CONNECTION_LEGACY_FALLBACK_DENIED',
    'CONNECTION_LEGACY_POINTER_REQUIRED',
    'CONNECTION_LEGACY_UNAVAILABLE',
    'CONNECTION_REGISTRATION_INVALID',
    'CONNECTION_RESOLUTION_FAILED',
    'CONNECTION_RESOLUTION_INVALID_BINDING',
    'CONNECTION_RESOLUTION_UNAVAILABLE',
    'CONNECTION_SEALED_SNAPSHOT_INVALID',
    'CONNECTION_SEALED_SNAPSHOT_KIND_UNSUPPORTED',
    'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
    'CONNECTION_SEALED_SNAPSHOT_USER_REQUIRED',
    'CONNECTION_TENANT_MISMATCH',
    'CONNECTION_TYPE_UNSUPPORTED',
    'DATA_SOURCE_C6_WRITE_TARGET_DELETE_UNSUPPORTED',
    'DATA_SOURCE_C6_WRITE_TARGET_QUERY_DISABLED',
    'DATA_SOURCE_NOT_C6_WRITE_TARGET',
    'DATA_SOURCE_NOT_FOUND',
    'DATA_SOURCE_NOT_READ_ONLY',
    'DATA_SOURCE_NOT_WRITABLE',
    'DATA_SOURCE_PRINCIPAL_REQUIRED',
    'DATA_SOURCE_QUERY_INVALID',
    'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED',
    'DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID',
    'ExternalSystemConflictError',
    'ExternalSystemNotFoundError',
    'ExternalSystemValidationError',
    'INTERNAL_ERROR',
    'SOURCE_UNAVAILABLE',
  ].sort())

  // Both directions against connection-resolver.cjs: every code it can throw is listed, and every
  // listed CONNECTION_* word (bar the registry's own fallback) is one it throws.
  const resolverSource = fs.readFileSync(path.join(LIB, 'connection-resolver.cjs'), 'utf8')
  const thrown = new Set()
  for (const match of resolverSource.matchAll(/new ConnectionResolutionError\(\s*'([A-Z_]+)'/g)) thrown.add(match[1])
  assert.ok(thrown.size >= 16, `the scan must find the throws it guards (found ${thrown.size})`)
  for (const code of thrown) {
    assert.ok(ROUTE_FAILURE_LOGGABLE_CODES.includes(code), `resolver code ${code} must be loggable`)
  }
  const listedConnectionCodes = ROUTE_FAILURE_LOGGABLE_CODES.filter((code) => code.startsWith('CONNECTION_'))
  assert.deepEqual(
    listedConnectionCodes.filter((code) => !thrown.has(code)),
    ['CONNECTION_RESOLUTION_FAILED'],
    'the only listed CONNECTION_* word the resolver does not throw is the registry fallback',
  )
  const registrySource = fs.readFileSync(path.join(LIB, 'external-systems.cjs'), 'utf8')
  assert.ok(registrySource.includes("'CONNECTION_RESOLUTION_FAILED'"), 'the registry fallback word exists where the list says')
  console.log('  ✓ list is closed, frozen, pinned and complete against connection-resolver.cjs')
}

// ---------------------------------------------------------------------------
// 1. Listed codes reach the log verbatim — and equal the response's code.
// ---------------------------------------------------------------------------
async function testListedCodes() {
  for (const code of ROUTE_FAILURE_LOGGABLE_CODES) {
    const run = await fireBoth(() => codedError(code), `listed ${code}`)
    assertLoggedCode(run, code, `listed ${code}`)
    assert.equal(run.res.body.error.code, code, `listed ${code}: the log names the response's own code`)
  }
  // The class-name fallback, as the registry actually throws it (no code of its own).
  for (const [ErrorClass, expected] of [
    [ExternalSystemValidationError, 'ExternalSystemValidationError'],
    [ExternalSystemNotFoundError, 'ExternalSystemNotFoundError'],
    [ExternalSystemConflictError, 'ExternalSystemConflictError'],
  ]) {
    const run = await fireBoth(() => new ErrorClass(`${MARK} message`, { id: `${MARK}-id` }), `class ${expected}`)
    assertLoggedCode(run, expected, `class ${expected}`)
    assert.equal(run.res.body.error.code, expected)
  }
  // The registry wrapping a resolver refusal: the code rides in `details.code`.
  {
    const run = await fireBoth(
      () => new ExternalSystemValidationError(`${MARK} canonical connection is unavailable`, { field: 'connectionId', code: 'CONNECTION_CANONICAL_UNAVAILABLE' }),
      'wrapped resolver refusal',
    )
    assertLoggedCode(run, 'CONNECTION_CANONICAL_UNAVAILABLE', 'wrapped resolver refusal')
    assert.equal(run.res.statusCode, 400)
  }
  console.log(`  ✓ ${ROUTE_FAILURE_LOGGABLE_CODES.length} listed codes + 3 class-name fallbacks logged verbatim`)
}

// ---------------------------------------------------------------------------
// 2. Unlisted — including same-prefix, value-carrying and near-miss strings — log UNLISTED only.
// ---------------------------------------------------------------------------
async function testUnlistedCodes() {
  const cases = [
    // same prefix, value-carrying
    `CONNECTION_CANONICAL_UNAVAILABLE:${MARK}-ds-42`,
    `CONNECTION_CANONICAL_UNAVAILABLE id=${MARK}-ds-42 tenant=${MARK}-t`,
    `CONNECTION_${MARK.toUpperCase()}`,
    `CONNECTION_${MARK}_host_${MARK}`,
    'CONNECTION_',
    // DATA_SOURCE_* — inferErrorCode passes these through to the RESPONSE verbatim (unchanged);
    // the log must still refuse them.
    `DATA_SOURCE_NOT_FOUND:${MARK}-ds`,
    `DATA_SOURCE_${MARK.toUpperCase()}_SECRET`,
    'DATA_SOURCE_',
    `SOURCE_UNAVAILABLE_${MARK.toUpperCase()}`,
    // near misses of listed words
    'connection_canonical_unavailable',
    ' CONNECTION_CANONICAL_UNAVAILABLE',
    'CONNECTION_CANONICAL_UNAVAILABLE\n',
    'CONNECTION_CANONICAL_UNAVAILABLE ',
    'INTERNAL_ERRORS',
    // Object.prototype keys — an object-lookup implementation would admit these
    'constructor',
    '__proto__',
    'hasOwnProperty',
    'toString',
    // an arbitrary coded error from a dependency
    'ECONNREFUSED',
  ]
  for (const code of cases) {
    const label = `unlisted ${JSON.stringify(code)}`
    const run = await fireBoth(() => codedError(code), label)
    assertLoggedCode(run, ROUTE_FAILURE_UNLISTED_CODE, label, { forbidden: [code.trim()] })
  }
  // An unlisted class name with no code.
  {
    const run = await fireBoth(() => codedError(undefined, `${MARK}Error`), 'unlisted class name')
    assertLoggedCode(run, ROUTE_FAILURE_UNLISTED_CODE, 'unlisted class name')
  }
  console.log(`  ✓ ${cases.length + 1} unlisted / same-prefix / near-miss codes logged as UNLISTED, raw string absent`)
}

// ---------------------------------------------------------------------------
// 3. Non-string / missing code.
// ---------------------------------------------------------------------------
async function testNonStringAndMissing() {
  const nonStringCodes = [
    ['number', 42],
    ['boolean', true],
    ['array holding a listed word', ['CONNECTION_CANONICAL_UNAVAILABLE']],
    ['String object of a listed word', new String('CONNECTION_CANONICAL_UNAVAILABLE')], // eslint-disable-line no-new-wrappers
    ['object whose toString is a listed word', { toString() { return 'CONNECTION_CANONICAL_UNAVAILABLE' } }],
    ['object whose toString is a listed DATA_SOURCE word', { toString() { return 'DATA_SOURCE_NOT_FOUND' } }],
  ]
  for (const [label, code] of nonStringCodes) {
    const run = await fireBoth(() => codedError(code), `non-string code: ${label}`)
    if (label === 'object whose toString is a listed DATA_SOURCE word') {
      // inferErrorCode already stringifies a DATA_SOURCE_* lookalike for the response; the log
      // follows the response's own (listed) word — a bare identifier, never the object.
      assertLoggedCode(run, 'DATA_SOURCE_NOT_FOUND', `non-string code: ${label}`)
      assert.equal(run.res.body.error.code, 'DATA_SOURCE_NOT_FOUND')
    } else {
      assertLoggedCode(run, ROUTE_FAILURE_UNLISTED_CODE, `non-string code: ${label}`)
    }
  }
  // No code at all: a plain Error falls back to its class name "Error", which is not listed.
  {
    const run = await fireBoth(() => codedError(undefined), 'missing code')
    assertLoggedCode(run, ROUTE_FAILURE_UNLISTED_CODE, 'missing code')
    assert.equal(run.res.body.error.code, 'Error', 'the response is unchanged: it still says "Error"')
  }
  // Empty-string code on a plain Error: same fallback.
  {
    const run = await fireBoth(() => codedError(''), 'empty code')
    assertLoggedCode(run, ROUTE_FAILURE_UNLISTED_CODE, 'empty code')
  }
  // Thrown primitives carry no code or name: the response says INTERNAL_ERROR, and so does the log.
  for (const [label, value] of [
    ['string', `CONNECTION_CANONICAL_UNAVAILABLE ${MARK}`],
    ['number', 7],
  ]) {
    const run = await fireBoth(() => value, `thrown ${label}`)
    assertLoggedCode(run, 'INTERNAL_ERROR', `thrown ${label}`)
    assert.equal(run.res.body.error.code, 'INTERNAL_ERROR')
  }
  // Thrown null / undefined: `sendError` itself throws on these, before and after R2 alike — the
  // log computation must not be the thing that throws first (the warn still happens, with UNLISTED).
  for (const [label, value] of [['null', null], ['undefined', undefined]]) {
    const run = await fireBoth(() => value, `thrown ${label}`)
    assert.equal(run.outcome.ok, false, `thrown ${label}: the route still rejects as before`)
    assert.ok(run.outcome.error instanceof TypeError)
    assertLoggedCode(run, ROUTE_FAILURE_UNLISTED_CODE, `thrown ${label}`)
    assert.equal(run.res.bytes, undefined, `thrown ${label}: no response, as before`)
  }
  // A throwing `code` getter: the log gets UNLISTED, and `sendError` then throws the getter's own
  // error exactly as it did before R2.
  {
    const make = () => {
      const error = new Error(`${MARK} message`)
      Object.defineProperty(error, 'code', { get() { throw new RangeError(`${MARK} getter`) }, configurable: true })
      return error
    }
    const run = await fireBoth(make, 'throwing code getter')
    assert.equal(run.outcome.ok, false)
    assert.ok(run.outcome.error instanceof RangeError)
    assertLoggedCode(run, ROUTE_FAILURE_UNLISTED_CODE, 'throwing code getter')
  }
  // The helper itself never throws and never returns anything but a string.
  for (const value of [null, undefined, 0, '', Symbol('x'), Object.create(null), new Proxy({}, { get() { throw new Error('trap') } })]) {
    const code = loggableRouteFailureCode(value)
    assert.equal(typeof code, 'string')
  }
  console.log('  ✓ non-string / missing / hostile codes logged as UNLISTED; thrown primitives as the response\'s INTERNAL_ERROR')
}

// ---------------------------------------------------------------------------
// 4. HttpRouteError still produces no log line, before and after.
// ---------------------------------------------------------------------------
async function testHttpRouteErrorStaysSilent() {
  const run = await fireBoth(
    () => new HttpRouteError(409, `CONNECTION_${MARK.toUpperCase()}`, `${MARK} refused`),
    'HttpRouteError',
  )
  assert.equal(run.warns.length, 0, 'HttpRouteError is answered without a warn, as before')
  assert.equal(run.res.statusCode, 409)
  console.log('  ✓ HttpRouteError answered with no warn, response unchanged')
}

// ---------------------------------------------------------------------------
// 5. Timing: an existing-but-refused connection vs a non-existent one, through the REAL registry
//    and resolver. The fake host facade refuses both the same way the real one does (one uniform
//    not-found, one await), so any difference in the route trace would be the route's own.
// ---------------------------------------------------------------------------
function bindingRow(overrides) {
  return {
    id: SYSTEM_ID,
    tenant_id: TENANT_ID,
    workspace_id: null,
    project_id: null,
    name: `r2 ${MARK}`,
    kind: 'data-source:sql-readonly',
    role: 'source',
    capabilities: {},
    status: 'active',
    last_tested_at: null,
    last_error: null,
    credentials_encrypted: null,
    created_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:00:00.000Z',
    ...overrides,
  }
}

const CANONICAL_ROW = bindingRow({ config: { schema: 'dbo' }, connection_id: CONNECTION_ID, legacy_connection_fallback_eligible: false })
const LEGACY_ROW = bindingRow({ config: { dataSourceId: CONNECTION_ID, schema: 'dbo' }, connection_id: null, legacy_connection_fallback_eligible: true })

function realChainServices(row, { connectionExists }) {
  return (events) => {
    // The host registry: the connection is either loaded but owned by someone else, or not there.
    const registrations = new Map(connectionExists
      ? [[CONNECTION_ID, { ownerId: `other_${MARK}`, tenantId: TENANT_ID }]]
      : [])
    const facade = {
      async resolveConnectionRegistration(id, input) {
        events.push(['facade.resolveConnectionRegistration', id])
        await null
        const entry = registrations.get(id)
        if (!entry || entry.ownerId !== input.principal) {
          const refusal = new Error(`Data source with id '${id}' not found`)
          refusal.code = 'DATA_SOURCE_NOT_FOUND'
          throw refusal
        }
        return { id, tenantId: entry.tenantId, type: 'sqlserver', scopeKind: 'legacy_private' }
      },
    }
    const db = {
      async selectOne(table, where) {
        events.push(['db.selectOne', table, JSON.stringify(where)])
        return [row].find((candidate) => Object.entries(where).every(([key, value]) => (
          value === null || value === undefined ? candidate[key] == null : candidate[key] === value
        ))) || null
      },
      insertOne: unused('db.insertOne'),
      updateRow: unused('db.updateRow'),
      select: unused('db.select'),
      deleteRows: unused('db.deleteRows'),
      countRows: unused('db.countRows'),
    }
    const credentialStore = {
      encrypt: unused('encrypt'), decrypt: unused('decrypt'), fingerprint: unused('fingerprint'),
    }
    const connectionResolver = createConnectionResolver({ facade })
    return baseServices(createExternalSystemRegistry({ db, credentialStore, connectionResolver }))
  }
}

async function testExistsVersusAbsentTiming() {
  for (const [shape, row, expectedCode] of [
    ['canonical', CANONICAL_ROW, 'CONNECTION_CANONICAL_UNAVAILABLE'],
    ['legacy', LEGACY_ROW, 'CONNECTION_LEGACY_UNAVAILABLE'],
  ]) {
    const runs = {}
    for (const connectionExists of [true, false]) {
      const build = realChainServices(row, { connectionExists })
      const before = await fire('preR2', build)
      const after = await fire('r2', build)
      const label = `${shape} / connection ${connectionExists ? 'exists (refused)' : 'absent'}`
      // Same as before R2 on this failure class: status, bytes, calls, order, ticks.
      assert.equal(after.res.statusCode, 400, `${label}: 400`)
      assert.equal(after.res.bytes, before.res.bytes, `${label}: body bytes unchanged`)
      assert.deepEqual(withoutWarnMeta(after.events), withoutWarnMeta(before.events), `${label}: same calls, same order as before R2`)
      assert.equal(after.ticks, before.ticks, `${label}: same microtask count as before R2`)
      // One warn, written synchronously between the refusal and the response — nothing in between.
      const names = after.events.map((event) => event[0])
      assert.deepEqual(names, [
        'db.selectOne',
        'facade.resolveConnectionRegistration',
        'logger.warn',
        'res.status',
        'res.json',
        'microtask queued by warn',
      ], `${label}: one read, one facade call, then warn -> status -> json in one synchronous run`)
      assertLoggedCode(after, expectedCode, label)
      runs[connectionExists ? 'exists' : 'absent'] = after
    }
    // The two failure classes are indistinguishable at the route: same trace (arguments included),
    // same warn arguments, same response bytes, same tick count.
    assert.deepEqual(runs.exists.events, runs.absent.events, `${shape}: exists vs absent — identical trace`)
    assert.deepEqual(runs.exists.warns, runs.absent.warns, `${shape}: exists vs absent — identical log call`)
    assert.equal(runs.exists.res.bytes, runs.absent.res.bytes, `${shape}: exists vs absent — identical response`)
    assert.equal(runs.exists.ticks, runs.absent.ticks, `${shape}: exists vs absent — identical microtask count`)
  }
  console.log('  ✓ exists-vs-absent: identical single warn, order, reads, bytes and tick count; same as the pre-R2 wrapper')
}

async function main() {
  console.log('route-failure-log-closed-code')
  testListShape()
  await testListedCodes()
  await testUnlistedCodes()
  await testNonStringAndMissing()
  await testHttpRouteErrorStaysSilent()
  await testExistsVersusAbsentTiming()
  console.log('route-failure-log-closed-code OK')
}

main().catch((err) => {
  console.error('route-failure-log-closed-code FAILED')
  console.error(err)
  process.exit(1)
})
