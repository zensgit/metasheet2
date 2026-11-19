'use strict'

// iPaaS S1-a (ADR adr-ipaas-steps-s1-s4-20261116.md §3.1, §10.1–§10.3): the request-free governed entry
// `runGovernedConfiguredRead`, extracted from the runtime-tier configured-read route
// (`POST /api/integration/read-source-configs/:id/read`) as a REFACTOR ONLY. Synthetic data only: fake
// store, fake external-system registry, fake adapter. No host, no PLM, no K3, no network, no database.
// Dormant: nothing in production calls the entry yet (its first caller is S1-b's connection-call service).
//
//   C-02 BYTE-IDENTICAL HTTP: every failure path (and three success paths) answers the status, the body AND
//        the exact store / system / adapter / read arguments captured from the handler BEFORE the refactor
//        (fixtures/governed-configured-read-route-snapshots.json; collected by `collectConfiguredReadSnapshots`
//        on main e0e4406bf, unchanged).
//   C-03 the principal context built from `req` is what the handler read: the HTTP route and the entry run over
//        `governedPrincipalContextFromRequest(req)` (and over a plain six-field object) make the same calls.
//   C-04 no options: the entry answers what the route answers; the handler passes the entry exactly two
//        arguments and a second argument of exactly { configId, inputs, rowSource } (static).
//   C-05 no options, no workspaceId: plan row cap 10, the overlay's maxListLimit 10, the source's `limit` 10,
//        and no new ENUMERABLE member on the returned object (the executor's own non-enumerable `page` stays).
//   C-06 an already-aborted signal: no system load, no adapter, no read; GOVERNED_ENTRY_ABORTED at `load`.
//   C-07 a refusing checkpoint: at `load` => zero system loads; at `read` => zero outbound reads.
//   C-08 the options key set is CLOSED to { signal, checkpoint }: transport / readPurpose / rowCap / foo,
//        symbol, non-enumerable and inherited keys, non-plain objects and malformed shapes are a TypeError
//        before any store read; the positive controls run.
//   C-09 the optional workspaceId hint reaches BOTH lookups (config row and external system) as one value; the
//        HTTP handler never passes it (static).
//   C-10 `governedEntries` is exactly three entries, non-enumerable; no entry name is an enumerable handler
//        key, and every ROUTES handler name still resolves (this slice only: the handler table is not pinned).
//   C-11 the entry's own gates for a request-free caller: the read tier first, then the closed request shape.
//   C-12 no options (undefined / null / {}) => the checkpoint seam is never called (the `if (governedEntry)`
//        guards), pinned through a require-cache stub of governed-entry-checkpoint.cjs.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const checkpointSeam = require(path.join(LIB, 'governed-entry-checkpoint.cjs'))
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { validateReadSourceConfig } = require(path.join(LIB, 'read-source-config.cjs'))
const { ReadSourceConfigNotApprovedError, ReadSourceConfigNotFoundError } = require(path.join(LIB, 'read-source-config-store.cjs'))
const harness = require('./support/stock-preparation-project-sheet-harness.cjs')
const { runFailClosedSuite } = require('./support/fail-closed-suite-runner.cjs')

const TENANT = 'tenant-s1a-governed'
const PROJECT = 'PRJ-S1A-G1'
const READ_PATH = '/api/integration/read-source-configs/:id/read'
const FIXTURE = path.join(__dirname, 'fixtures', 'governed-configured-read-route-snapshots.json')
// The existing tenant-claim flag (read by the route's tenant resolution); set per case, always restored.
const CLAIM_FLAG = 'MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED'

const READER = Object.freeze({ id: 'u_s1a_reader', tenantId: TENANT, permissions: ['integration:read'] })
const STRANGER = Object.freeze({ id: 'u_s1a_stranger', tenantId: TENANT, permissions: ['multitable:read'] })
const silentLogger = Object.freeze({ info() {}, warn() {}, error() {} })

// ── synthetic configs (S1-normalized through the real validator, as the store would hold them) ──────────

function normalized(mode, extra) {
  const cfg = {
    version: 1,
    systemId: 'sys_s1a',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode,
    readPath: '/K3API/Material/GetDetail',
    readMethod: 'POST',
    operations: ['read'],
    fieldMap: [{ source: 'FSigmaField', target: 'colGamma' }],
    ...extra,
  }
  const result = validateReadSourceConfig(cfg)
  assert.equal(result.valid, true, `${mode} fixture must validate: ${JSON.stringify(result.errors)}`)
  return result.normalized
}

const CONFIGS = Object.freeze({
  single: normalized('single_record', { keyField: 'FNumber', containerPaths: ['Data'] }),
  list: normalized('list_page', { readPath: '/K3API/Material/GetList', containerPaths: ['Data.Data', 'Data.DATA'] }),
  resolver: normalized('resolver_lookup', {
    readPath: '/K3API/Material/GetList', keyField: 'FMaterialId', containerPaths: ['Data.Rows'], resolverRule: 'exactly_one',
    fieldMap: [{ source: 'FItemID', target: 'item_id' }],
  }),
})

// config id => the store row (or the store failure) the fake store answers with.
function storeRowFor(id) {
  switch (id) {
    case 'rsc_single': return { config: CONFIGS.single, systemId: 'sys_s1a' }
    case 'rsc_list': return { config: CONFIGS.list, systemId: 'sys_s1a' }
    case 'rsc_resolver': return { config: CONFIGS.resolver, systemId: 'sys_s1a' }
    case 'rsc_wrong_kind': return { config: CONFIGS.single, systemId: 'sys_s1a_http' }
    case 'rsc_no_system': return { config: CONFIGS.single, systemId: 'sys_s1a_absent' }
    case 'rsc_draft': {
      const error = new ReadSourceConfigNotApprovedError('read-source config version is not approved', { id, status: 'draft' })
      throw error
    }
    default: throw new ReadSourceConfigNotFoundError('read-source config not found', { id })
  }
}

/**
 * The real route stack (the project-sheet harness: real routes over fake host services) with a recording
 * read-source store, external-system registry and adapter registry, plus a handler set over the SAME services
 * so the entry and the HTTP route run over one substrate. `log` records every argument, JSON-cloned in call
 * order — the key ORDER is part of what C-02 pins.
 */
function mountConfiguredRead(routesModule = httpRoutes) {
  const log = { store: [], systems: [], adapters: [], reads: [] }
  const adapter = {
    async read(request) {
      log.reads.push(JSON.parse(JSON.stringify(request)))
      if (request.filters && request.filters.FNumber === 'M-THROW') throw new Error('synthetic source unreachable')
      if (request.options && request.options.k3ReadMode === 'list') {
        return { records: [], raw: { Data: { Data: Array.from({ length: 12 }, (_, i) => ({ FSigmaField: `SIGMA-${i}` })) } } }
      }
      if (request.filters && request.filters.FMaterialId !== undefined) {
        return { records: [], raw: { Data: { Rows: [{ FItemID: 4242 }] } } }
      }
      return { records: [{ FSigmaField: 'REC-SIGMA' }], raw: { Data: { FSigmaField: 'RAW-SIGMA', FUnmapped: 'DROP' } } }
    },
    async upsert() { throw new Error('unexpected write') },
  }
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn: false,
    logger: silentLogger,
    serviceExtras: {
      readSourceConfigStore: {
        ...harness.inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit']),
        async getForRuntime(input) {
          log.store.push(JSON.parse(JSON.stringify(input)))
          const row = storeRowFor(input.id)
          return { id: input.id, systemId: row.systemId, object: 'material', mode: row.config.mode, version: 1, status: 'approved', config: row.config }
        },
      },
      externalSystemRegistry: {
        ...harness.inertService(['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
        async getExternalSystemForAdapter(input) {
          log.systems.push(JSON.parse(JSON.stringify(input)))
          if (input.id === 'sys_s1a_absent') return null
          const kind = input.id === 'sys_s1a_http' ? 'http' : 'erp:k3-wise-webapi'
          return { id: input.id, tenantId: TENANT, kind, credentials: { bearerToken: 'synthetic-s1a-credential' }, config: { objects: {} } }
        },
      },
      adapterRegistry: {
        createAdapter(system, deps) {
          // The credential context is recorded as a presence bit only: no credential-shaped value in a fixture.
          const { credentials, ...withoutCredentials } = system || {}
          log.adapters.push({
            system: JSON.parse(JSON.stringify(withoutCredentials)),
            hasCredentials: Boolean(credentials),
            deps: JSON.parse(JSON.stringify(deps || null)),
          })
          return adapter
        },
        listAdapterKinds() { return [] },
      },
    },
  })
  const handlers = routesModule.createHandlers(h.services, { context: h.context, logger: silentLogger })
  return {
    h,
    log,
    handlers,
    calls() { return JSON.parse(JSON.stringify(log)) },
    reset() { for (const list of Object.values(log)) list.length = 0 },
    http(req) {
      // harness.call builds the request from user / body / query / params (+ authenticatedTenantId); an
      // authUser-only principal is forwarded onto that same request object here, the way the auth middleware sets it.
      if (req.authUser === undefined) return harness.call(h.routes, 'POST', READ_PATH, req)
      const routes = {
        get(key) {
          const handler = h.routes.get(key)
          return handler && ((request, res) => { request.authUser = req.authUser; return handler(request, res) })
        },
      }
      return harness.call(routes, 'POST', READ_PATH, req)
    },
  }
}

/** Runs `fn` with the given env values set, restoring each one (deleting it if it was unset) afterwards. */
async function withEnv(env, fn) {
  const saved = new Map()
  for (const [key, value] of Object.entries(env || {})) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined)
    process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ── C-02 snapshot collection (the SAME function was run on main e0e4406bf, before the refactor) ────────

/** Every case: the route request, and what it answered and called. */
const SNAPSHOT_CASES = Object.freeze([
  ['success: single_record, raw plane', { user: READER, params: { id: 'rsc_single' }, query: { workspaceId: 'ws_q' }, body: { inputs: { key: 'M-001' } } }],
  ['success: single_record, record plane', { user: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' }, rowSource: 'adapter_records' } }],
  ['success: list_page, 12 source rows', { user: READER, params: { id: 'rsc_list' }, body: {} }],
  ['success: resolver_lookup', { user: READER, params: { id: 'rsc_resolver' }, body: { inputs: { key: 'MAT-7' } } }],
  ['read-level failure: adapter throws (200, evidence failure)', { user: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-THROW' } } }],
  ['no principal', { params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' } } }],
  ['no principal, extra body key', { params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' }, extra: 1 } }],
  ['no permission', { user: STRANGER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' } } }],
  ['no permission, extra body key', { user: STRANGER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' }, extra: 1 } }],
  ['array body', { user: READER, params: { id: 'rsc_single' }, body: [{ inputs: { key: 'M-001' } }] }],
  ['extra body key', { user: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' }, rowCap: 5000 } }],
  ['body smuggles a config', { user: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' }, config: { readPath: 'https://s1a.invalid' } } }],
  ['body carries workspaceId', { user: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' }, workspaceId: 'ws_body' } }],
  ['body carries configId', { user: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' }, configId: 'rsc_list' } }],
  ['bad rowSource', { user: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' }, rowSource: 'raw' } }],
  ['bad rowSource on a draft id', { user: READER, params: { id: 'rsc_draft' }, body: { inputs: { key: 'M-001' }, rowSource: 'raw' } }],
  ['not approved', { user: READER, params: { id: 'rsc_draft' }, body: { inputs: { key: 'M-001' } } }],
  ['invalid inputs on a draft id', { user: READER, params: { id: 'rsc_draft' }, body: { inputs: { nope: 1 } } }],
  ['config not found', { user: READER, params: { id: 'rsc_absent' }, body: { inputs: { key: 'M-001' } } }],
  ['invalid inputs: missing key', { user: READER, params: { id: 'rsc_single' }, body: { inputs: {} } }],
  ['invalid inputs: unknown input', { user: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001', nope: 1 } } }],
  ['invalid inputs: pageIndex out of range', { user: READER, params: { id: 'rsc_list' }, body: { inputs: { pageIndex: 99 } } }],
  ['kind mismatch', { user: READER, params: { id: 'rsc_wrong_kind' }, body: { inputs: { key: 'M-001' } } }],
  ['system missing', { user: READER, params: { id: 'rsc_no_system' }, body: { inputs: { key: 'M-001' } } }],
  ['record plane refused for resolver_lookup', { user: READER, params: { id: 'rsc_resolver' }, body: { inputs: { key: 'MAT-7' }, rowSource: 'adapter_records' } }],
  // Fix round 1 (captured on main e0e4406bf, appended; the 25 cases above are byte-identical): the two context
  // fields the cases above never carry — an authUser-only principal, and the verified tenant claim under the
  // claim flag (exact 'true'), present and absent.
  ['authUser-only principal', { authUser: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' } } }],
  ['claim flag on, verified claim present', { user: READER, authenticatedTenantId: TENANT, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' } } }, { [CLAIM_FLAG]: 'true' }],
  ['claim flag on, verified claim absent', { user: READER, params: { id: 'rsc_single' }, body: { inputs: { key: 'M-001' } } }, { [CLAIM_FLAG]: 'true' }],
])

async function collectConfiguredReadSnapshots() {
  const m = mountConfiguredRead()
  const cases = []
  try {
    for (const [name, req, env] of SNAPSHOT_CASES) {
      m.reset()
      const res = await withEnv(env, () => m.http(req))
      cases.push({ name, status: res.statusCode, body: JSON.stringify(res.body), calls: JSON.stringify(m.calls()) })
    }
    return { cases }
  } finally {
    m.h.restore()
  }
}

// ── shared helpers ────────────────────────────────────────────────────────────────────────────────

/** A principal context the way a request-free caller hands one in: the six plain fields, no request. */
function readerContext(extra = {}) {
  return { user: READER, authUser: undefined, authenticatedTenantId: undefined, query: {}, params: {}, body: {}, ...extra }
}

function entryOf(m) {
  const entry = m.handlers.governedEntries && m.handlers.governedEntries.runGovernedConfiguredRead
  assert.equal(typeof entry, 'function', 'governedEntries.runGovernedConfiguredRead exists')
  return entry
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected a rejection')
  return null
}

function assertGovernedRefusal(error, failureStage, errorClass) {
  assert.ok(error instanceof checkpointSeam.GovernedEntryAbortError, `a governed refusal, got ${error && error.stack}`)
  assert.equal(error.code, checkpointSeam.GOVERNED_ENTRY_ABORTED_CODE)
  assert.equal(error.failureStage, failureStage)
  assert.equal(error.errorClass, errorClass)
  assert.equal(Object.getOwnPropertyDescriptor(error, 'failureStage').enumerable, false)
  assert.equal(Object.getOwnPropertyDescriptor(error, 'errorClass').enumerable, false)
  assert.equal(error.details, undefined, 'nothing of the refusal is ever serialized')
  assert.equal(error.status, undefined)
}

/** The handler's own source, from its method line to the closing line of the method. */
function handlerSource() {
  const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  const start = source.indexOf('    async readSourceConfigsRead(req, res) {')
  assert.ok(start > 0, 'calibration: the handler is found')
  const end = source.indexOf('\n    },\n', start)
  assert.ok(end > start, 'calibration: the handler end is found')
  return source.slice(start, end)
}

/** The argument text of the handler's single call to the entry (balanced parentheses). */
function handlerEntryCallArguments() {
  const text = handlerSource()
  const marker = 'runGovernedConfiguredRead('
  const at = text.indexOf(marker)
  assert.ok(at >= 0, 'the handler calls runGovernedConfiguredRead')
  assert.equal(text.indexOf(marker, at + marker.length), -1, 'the handler calls the entry exactly once')
  let depth = 1
  let index = at + marker.length
  for (; index < text.length && depth > 0; index += 1) {
    if (text[index] === '(' || text[index] === '{' || text[index] === '[') depth += 1
    if (text[index] === ')' || text[index] === '}' || text[index] === ']') depth -= 1
  }
  return text.slice(at + marker.length, index - 1)
}

/** Splits an argument list on its top-level commas. */
function topLevelParts(argumentText) {
  const parts = []
  let depth = 0
  let current = ''
  for (const character of argumentText) {
    if (character === '(' || character === '{' || character === '[') depth += 1
    if (character === ')' || character === '}' || character === ']') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

const EXPECTED = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : null

// ── the suite ─────────────────────────────────────────────────────────────────────────────────────

const tests = [
  ['C-02 byte-identical HTTP: every case answers the status, body and calls captured before the refactor', async () => {
    assert.ok(EXPECTED, 'the pre-refactor fixture exists')
    const actual = await collectConfiguredReadSnapshots()
    assert.ok(EXPECTED.cases.length >= 25, 'calibration: the captured set is the full list')
    assert.deepEqual(actual.cases.map((entry) => entry.name), EXPECTED.cases.map((entry) => entry.name), 'same cases, same order')
    for (let index = 0; index < actual.cases.length; index += 1) {
      assert.deepEqual(actual.cases[index], EXPECTED.cases[index], `byte-identical: ${actual.cases[index].name}`)
    }
    // Calibration: the set is not all one answer, and the five named failure paths are in it.
    assert.ok(new Set(actual.cases.map((entry) => entry.status)).size >= 5, 'several distinct statuses are covered')
    const byName = new Map(actual.cases.map((entry) => [entry.name, entry]))
    assert.equal(byName.get('not approved').status, 409)
    assert.equal(byName.get('kind mismatch').status, 409)
    assert.equal(byName.get('extra body key').status, 400)
    assert.equal(byName.get('invalid inputs: missing key').status, 400)
    assert.equal(byName.get('no permission').status, 403)
    // Calibration for the appended context-field cases: each takes the branch it names.
    const authUserOnly = byName.get('authUser-only principal')
    assert.equal(authUserOnly.status, 200, 'the authUser-only principal is admitted (it reached the handler)')
    assert.equal(JSON.parse(authUserOnly.calls).systems[0].principal, READER.id, 'and the system is loaded as that principal')
    assert.equal(byName.get('claim flag on, verified claim present').status, 200)
    assert.equal(byName.get('claim flag on, verified claim absent').status, 403)
    assert.equal(JSON.parse(byName.get('claim flag on, verified claim absent').body).error.code, 'OPERATOR_SCOPE_TENANT_REQUIRED')
    assert.equal(process.env[CLAIM_FLAG], undefined, 'calibration: the claim flag is restored after collection')
    for (const entry of actual.cases) assert.ok(!entry.body.includes('synthetic-s1a-credential'), `${entry.name}: no credential in a body`)
  }],

  ['C-03 the context built from req is what the handler read: HTTP and the entry make the same calls and answer the same data', async () => {
    const m = mountConfiguredRead()
    try {
      const entry = entryOf(m)
      const { governedPrincipalContextFromRequest } = httpRoutes.__internals
      for (const req of [
        { user: READER, params: { id: 'rsc_single' }, query: { workspaceId: 'ws_q', tenantId: TENANT }, body: { inputs: { key: 'M-001' } } },
        { user: READER, params: { id: 'rsc_list' }, query: {}, body: { inputs: { pageIndex: 2 }, rowSource: 'raw_containers' } },
      ]) {
        m.reset()
        const res = await m.http(req)
        assert.equal(res.statusCode, 200, JSON.stringify(res.body))
        const httpCalls = m.calls()
        // The request object the harness hands the handler, rebuilt the same way.
        const request = { user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }
        const context = governedPrincipalContextFromRequest(request)
        m.reset()
        const viaContext = await entry(context, { configId: req.params.id, inputs: req.body.inputs, rowSource: req.body.rowSource })
        assert.deepEqual(m.calls(), httpCalls, 'the entry over governedPrincipalContextFromRequest(req) makes the calls the handler made')
        assert.equal(JSON.stringify({ evidence: viaContext.evidence, data: viaContext.data }), JSON.stringify(res.body.data), 'and answers the same evidence and data')
        // A plain six-field object (what a request-free caller builds) is the same principal.
        m.reset()
        await entry(readerContext({ query: request.query, params: request.params, body: request.body }), { configId: req.params.id, inputs: req.body.inputs, rowSource: req.body.rowSource })
        assert.deepEqual(m.calls(), httpCalls, 'a plain context with the same fields makes the same calls')
        assert.equal(httpCalls.systems[0].principal, READER.id, 'calibration: the system is loaded as the caller')
        assert.equal(httpCalls.systems[0].runAs, 'user', 'calibration: runAs user is stamped inside')
      }
      // runAs cannot be steered by the caller: a context carrying runAs anywhere still loads as `user`.
      m.reset()
      await entry(readerContext({ query: { runAs: 'system' }, body: { runAs: 'system' } }), { configId: 'rsc_single', inputs: { key: 'M-001' } })
      assert.equal(m.log.systems[0].runAs, 'user')
    } finally {
      m.h.restore()
    }
  }],

  ['C-04 no options: the entry answers what the route answers; the handler passes exactly two arguments, the second exactly { configId, inputs, rowSource }', async () => {
    const m = mountConfiguredRead()
    try {
      const entry = entryOf(m)
      const req = { user: READER, params: { id: 'rsc_single' }, query: { workspaceId: 'ws_q' }, body: { inputs: { key: 'M-001' } } }
      const expected = EXPECTED.cases.find((entryCase) => entryCase.name === 'success: single_record, raw plane')
      for (const options of [undefined, null]) {
        m.reset()
        const result = await entry(readerContext({ query: req.query, params: req.params, body: req.body }), { configId: 'rsc_single', inputs: { key: 'M-001' } }, options)
        assert.equal(JSON.stringify({ ok: true, data: { evidence: result.evidence, data: result.data } }), expected.body, `options ${options}: the snapshot body`)
        assert.equal(JSON.stringify(m.calls()), expected.calls, `options ${options}: the snapshot calls`)
      }
      // Static: the handler is a pure ungoverned caller.
      const parts = topLevelParts(handlerEntryCallArguments())
      assert.equal(parts.length, 2, 'the handler passes the entry exactly two arguments (no options)')
      assert.equal(parts[0], 'governedPrincipalContextFromRequest(req)', 'the first is the context built from req')
      const keys = parts[1].replace(/^\{|\}$/g, '').split(',').map((part) => part.trim().split(':')[0].trim()).filter(Boolean)
      assert.deepEqual(keys, ['configId', 'inputs', 'rowSource'], 'the second is exactly { configId, inputs, rowSource }')
    } finally {
      m.h.restore()
    }
  }],

  ['C-05 no options, no workspaceId: plan row cap 10, overlay maxListLimit 10, source limit 10, no new enumerable member (HTTP and entry)', async () => {
    const m = mountConfiguredRead()
    try {
      const entry = entryOf(m)
      // HTTP side.
      const res = await m.http({ user: READER, params: { id: 'rsc_list' }, body: {} })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.deepEqual(Object.keys(res.body.data), ['evidence', 'data'])
      assert.equal(res.body.data.evidence.recordCount, 10, 'the plan row cap is 10')
      assert.equal(res.body.data.evidence.capReached, true)
      assert.equal(res.body.data.data.containers.primary.records.length, 10)
      assert.equal(m.log.reads.length, 1)
      assert.equal(m.log.reads[0].limit, 10, 'the source is asked for 10')
      assert.equal(m.log.adapters[0].system.config.objects.material.maxListLimit, 10, 'the list overlay cap is 10')
      // Entry side, no options and no workspaceId.
      m.reset()
      const result = await entry(readerContext(), { configId: 'rsc_list', inputs: undefined })
      assert.deepEqual(Object.keys(result), ['evidence', 'data'], 'no new enumerable member on the returned object')
      assert.equal(result.evidence.recordCount, 10)
      assert.equal(result.data.containers.primary.records.length, 10)
      assert.equal(m.log.reads[0].limit, 10)
      assert.equal(m.log.adapters[0].system.config.objects.material.maxListLimit, 10)
      // The executor's internal continuation page stays exactly as it was: present, non-enumerable.
      const page = Object.getOwnPropertyDescriptor(result, 'page')
      assert.ok(page, 'calibration: the executor page rides along')
      assert.equal(page.enumerable, false)
      assert.deepEqual(Object.getOwnPropertyNames(result).sort(), ['data', 'evidence', 'page'], 'no other own member at all')
      // single_record carries NO limit (the trusted rowCap lane is not taken without options).
      m.reset()
      await entry(readerContext(), { configId: 'rsc_single', inputs: { key: 'M-001' } })
      assert.equal(Object.prototype.hasOwnProperty.call(m.log.reads[0], 'limit'), false, 'single_record: no limit is added')
    } finally {
      m.h.restore()
    }
  }],

  ['C-06 an already-aborted signal: no system load, no adapter, no read; GOVERNED_ENTRY_ABORTED at load', async () => {
    const m = mountConfiguredRead()
    try {
      const entry = entryOf(m)
      const controller = new AbortController()
      controller.abort()
      let checkpointCalls = 0
      const error = await rejection(entry(readerContext(), { configId: 'rsc_single', inputs: { key: 'M-001' } }, { signal: controller.signal, checkpoint: async () => { checkpointCalls += 1 } }))
      assertGovernedRefusal(error, 'load', checkpointSeam.GOVERNED_ERROR_CLASSES.ABORTED)
      assert.equal(checkpointCalls, 0, 'the signal is checked before the checkpoint is awaited')
      assert.equal(m.log.store.length, 1, 'calibration: the gates and the config row ran')
      assert.equal(m.log.systems.length, 0, 'no system (credential) load')
      assert.equal(m.log.adapters.length, 0, 'no adapter built')
      assert.equal(m.log.reads.length, 0, 'no outbound read')
    } finally {
      m.h.restore()
    }
  }],

  ['C-07 a refusing checkpoint: at load => zero system loads; at read => zero outbound reads; the positive control runs both, in order', async () => {
    const m = mountConfiguredRead()
    try {
      const entry = entryOf(m)
      const job = { configId: 'rsc_single', inputs: { key: 'M-001' } }
      // Positive control: both checkpoints, in order, then exactly one read.
      const stages = []
      const ok = await entry(readerContext(), job, { checkpoint: async ({ stage }) => { stages.push(stage) } })
      assert.deepEqual(stages, ['load', 'read'], 'one checkpoint before the credential load, one before the read')
      assert.equal(m.log.reads.length, 1, 'exactly one outbound read')
      assert.equal(ok.evidence.ok, true)
      // Refused at load.
      m.reset()
      const atLoad = await rejection(entry(readerContext(), job, { checkpoint: async ({ stage }) => { if (stage === 'load') throw new Error('fence lost S1A-VALUE') } }))
      assertGovernedRefusal(atLoad, 'load', checkpointSeam.GOVERNED_ERROR_CLASSES.CHECKPOINT_REFUSED)
      assert.equal(m.log.systems.length, 0, 'load refusal: zero system loads')
      assert.equal(m.log.adapters.length, 0)
      assert.equal(m.log.reads.length, 0)
      assert.ok(!atLoad.message.includes('S1A-VALUE'), 'the refusal message is values-free')
      // Refused at read.
      m.reset()
      const atRead = await rejection(entry(readerContext(), job, { checkpoint: async ({ stage }) => { if (stage === 'read') throw new Error('fence lost') } }))
      assertGovernedRefusal(atRead, 'read', checkpointSeam.GOVERNED_ERROR_CLASSES.CHECKPOINT_REFUSED)
      assert.equal(m.log.systems.length, 1, 'calibration: the system was loaded')
      assert.equal(m.log.reads.length, 0, 'read refusal: zero outbound reads')
      // The signal fires while the read checkpoint is pending: aborted at read, still zero reads.
      m.reset()
      const controller = new AbortController()
      const late = await rejection(entry(readerContext(), job, { signal: controller.signal, checkpoint: async ({ stage }) => { if (stage === 'read') controller.abort() } }))
      assertGovernedRefusal(late, 'read', checkpointSeam.GOVERNED_ERROR_CLASSES.ABORTED)
      assert.equal(m.log.reads.length, 0)
    } finally {
      m.h.restore()
    }
  }],

  ['C-08 the options key set is closed to { signal, checkpoint }: anything else is a TypeError before any store read; the positive controls run', async () => {
    const m = mountConfiguredRead()
    try {
      const entry = entryOf(m)
      const job = { configId: 'rsc_single', inputs: { key: 'M-001' } }
      const controller = new AbortController()
      for (const [label, options] of [
        ['transport', { transport: 'strict' }],
        ['readPurpose', { readPurpose: 'automation_connection_call' }],
        ['rowCap', { rowCap: 10 }],
        ['foo', { foo: 1 }],
        ['signal plus an extra key', { signal: controller.signal, rowCap: 100 }],
        ['an undefined-valued extra key', { transport: undefined }],
        ['array', [controller.signal]],
        ['string', 'strict'],
        ['number', 1],
        ['malformed signal', { signal: 'stop' }],
        ['malformed checkpoint', { checkpoint: 'later' }],
        // Fix round 1: keys Object.keys cannot see, and objects that are not plain.
        ['a symbol key', { [Symbol('s1a')]: 1 }],
        ['a non-enumerable rowCap', Object.defineProperty({}, 'rowCap', { value: 100 })],
        ['an inherited key', Object.create({ transport: 'strict' })],
        ['a class instance carrying checkpoint', new (class S1aOptions { constructor() { this.checkpoint = async () => {} } })()],
      ]) {
        m.reset()
        const error = await rejection(entry(readerContext(), job, options))
        assert.ok(error instanceof TypeError, `${label}: a TypeError, got ${error && error.stack}`)
        assert.equal(m.log.store.length, 0, `${label}: zero store reads`)
        assert.equal(m.log.systems.length, 0, `${label}: zero system loads`)
        assert.equal(m.log.reads.length, 0, `${label}: zero reads`)
      }
      // The message names no value.
      const named = await rejection(entry(readerContext(), job, { 'S1A-KEY-VALUE': 1 }))
      assert.ok(named instanceof TypeError)
      assert.ok(!named.message.includes('S1A-KEY-VALUE'), 'the TypeError does not echo the key')
      // Positive controls.
      for (const [label, options] of [
        ['signal', { signal: new AbortController().signal }],
        ['checkpoint', { checkpoint: async () => {} }],
        ['both', { signal: new AbortController().signal, checkpoint: async () => {} }],
        ['empty object', {}],
        ['undefined', undefined],
        ['null', null],
      ]) {
        m.reset()
        const result = await entry(readerContext(), job, options)
        assert.equal(result.evidence.ok, true, `${label}: runs`)
        assert.equal(m.log.reads.length, 1, `${label}: one read`)
      }
    } finally {
      m.h.restore()
    }
  }],

  ['C-09 the workspaceId hint reaches both lookups as one value; without it both use the request scope; the handler never passes it', async () => {
    const m = mountConfiguredRead()
    try {
      const entry = entryOf(m)
      await entry(readerContext({ query: { workspaceId: 'ws_query' } }), { configId: 'rsc_single', workspaceId: 'ws_hint', inputs: { key: 'M-001' } })
      assert.equal(m.log.store[0].workspaceId, 'ws_hint', 'the config row lookup uses the hint')
      assert.equal(m.log.systems[0].workspaceId, 'ws_hint', 'the external system lookup uses the same hint')
      m.reset()
      await entry(readerContext({ query: { workspaceId: 'ws_query' } }), { configId: 'rsc_single', inputs: { key: 'M-001' } })
      assert.equal(m.log.store[0].workspaceId, 'ws_query', 'no hint: the config row lookup uses the request scope')
      assert.equal(m.log.systems[0].workspaceId, 'ws_query', 'no hint: so does the external system lookup')
      // No hint, no scope: the store input carries no extra key (key order pinned against the HTTP shape).
      m.reset()
      await entry(readerContext(), { configId: 'rsc_single', inputs: { key: 'M-001' } })
      assert.deepEqual(Object.keys(m.log.store[0]), ['id', 'tenantId', 'workspaceId'])
      // Static: the handler never names workspaceId in its call to the entry.
      assert.ok(!/workspaceId/.test(handlerEntryCallArguments()), 'the HTTP handler does not pass a workspaceId')
    } finally {
      m.h.restore()
    }
  }],

  ['C-10 governedEntries: exactly three entries, frozen, non-enumerable; no entry is a handler key; every ROUTES handler resolves', () => {
    const m = mountConfiguredRead()
    try {
      const { governedEntries } = m.handlers
      assert.ok(governedEntries, 'governedEntries exists')
      assert.deepEqual(Object.keys(governedEntries).sort(), ['runGovernedConfiguredRead', 'runGovernedPipeline', 'runGovernedStockPrepPull'])
      assert.ok(Object.isFrozen(governedEntries), 'frozen')
      assert.equal(Object.getOwnPropertyDescriptor(m.handlers, 'governedEntries').enumerable, false, 'non-enumerable on the handler map')
      // This slice only (fix round 1): the handler table itself is not pinned, so an unrelated new handler
      // never turns this suite red. What S1-a could break is checked: no entry leaks into the enumerable
      // handler map, and every route still names a handler that exists.
      const handlerKeys = Object.keys(m.handlers)
      for (const name of Object.keys(governedEntries)) {
        assert.equal(handlerKeys.includes(name), false, `${name} is not an enumerable handler key`)
      }
      assert.ok(Array.isArray(httpRoutes.ROUTES) && httpRoutes.ROUTES.length > 0, 'calibration: ROUTES is exported')
      for (const [method, routePath, handlerName] of httpRoutes.ROUTES) {
        assert.equal(typeof m.handlers[handlerName], 'function', `${method} ${routePath}: handler ${handlerName} resolves`)
      }
      assert.ok(httpRoutes.ROUTES.some(([, routePath, handlerName]) => routePath === READ_PATH && handlerName === 'readSourceConfigsRead'), 'the configured-read route is in ROUTES')
      // The registered route list carries the same frozen object (index.cjs hands it to the run port).
      const registered = httpRoutes.registerIntegrationRoutes({
        context: { ...m.h.context, api: { ...m.h.context.api, http: { addRoute() {} } } },
        services: m.h.services,
        logger: silentLogger,
      })
      assert.equal(Object.keys(registered.governedEntries).length, 3)
      assert.equal(Object.keys(registered).includes('governedEntries'), false)
    } finally {
      m.h.restore()
    }
  }],

  ['C-11 the entry\'s own gates for a request-free caller: read tier first, then the closed request shape, before any store read', async () => {
    const m = mountConfiguredRead()
    try {
      const entry = entryOf(m)
      const anon = await rejection(entry(readerContext({ user: undefined }), { configId: 'rsc_single', inputs: { key: 'M-001' }, extra: 1 }))
      assert.equal(anon.status, 401, 'no principal is refused first, even with a bad request')
      const stranger = await rejection(entry(readerContext({ user: STRANGER }), { configId: 'rsc_single', inputs: { key: 'M-001' } }))
      assert.equal(stranger.status, 403)
      assert.equal(stranger.code, 'FORBIDDEN')
      for (const [label, job, reason] of [
        ['extra key', { configId: 'rsc_single', inputs: { key: 'M-001' }, rowCap: 100 }, 'unexpected_field'],
        ['transport', { configId: 'rsc_single', inputs: { key: 'M-001' }, transport: 'strict' }, 'unexpected_field'],
        ['readPurpose', { configId: 'rsc_single', inputs: { key: 'M-001' }, readPurpose: 'automation_connection_call' }, 'unexpected_field'],
        ['an arbitrary key', { configId: 'rsc_single', inputs: { key: 'M-001' }, s1aArbitrary: 1 }, 'unexpected_field'],
        ['array', [{ configId: 'rsc_single' }], 'not_object'],
        ['bad rowSource', { configId: 'rsc_single', inputs: { key: 'M-001' }, rowSource: 'raw' }, 'execution_row_source_invalid'],
      ]) {
        const error = await rejection(entry(readerContext(), job))
        assert.equal(error.status, 400, `${label}: 400`)
        assert.equal(error.code, 'READ_SOURCE_READ_CONTRACT_INVALID', `${label}: the route's code`)
        assert.deepEqual(error.details, { reason }, `${label}: the route's values-free reason`)
      }
      assert.equal(m.log.store.length, 0, 'none of these read the store')
      // The other failure paths are the route's own errors, unchanged.
      const draft = await rejection(entry(readerContext(), { configId: 'rsc_draft', inputs: { key: 'M-001' } }))
      assert.equal(draft.status, 409)
      assert.equal(draft.code, 'READ_SOURCE_CONFIG_NOT_APPROVED')
      const kind = await rejection(entry(readerContext(), { configId: 'rsc_wrong_kind', inputs: { key: 'M-001' } }))
      assert.equal(kind.status, 409)
      assert.equal(kind.code, 'READ_SOURCE_READ_KIND_MISMATCH')
    } finally {
      m.h.restore()
    }
  }],

  ['C-12 no options (undefined / null / {}) => zero checkpoint-seam calls; given a checkpoint => exactly two, load then read', async () => {
    // http-routes.cjs destructures passGovernedCheckpoint at require time, so the stub must be in the require
    // cache BEFORE a fresh copy of http-routes.cjs loads. Both cache entries are restored afterwards.
    const seamPath = require.resolve(path.join(LIB, 'governed-entry-checkpoint.cjs'))
    const routesPath = require.resolve(path.join(LIB, 'http-routes.cjs'))
    const savedSeam = require.cache[seamPath]
    const savedRoutes = require.cache[routesPath]
    const seamCalls = []
    const stub = new Module(seamPath)
    stub.filename = seamPath
    stub.loaded = true
    stub.exports = {
      ...checkpointSeam,
      async passGovernedCheckpoint(governance, failureStage) {
        seamCalls.push(failureStage)
        return checkpointSeam.passGovernedCheckpoint(governance, failureStage)
      },
    }
    let m = null
    try {
      require.cache[seamPath] = stub
      delete require.cache[routesPath]
      const freshRoutes = require(routesPath)
      assert.notEqual(freshRoutes, httpRoutes, 'calibration: a fresh http-routes copy over the stubbed seam')
      m = mountConfiguredRead(freshRoutes)
      const entry = entryOf(m)
      const job = { configId: 'rsc_single', inputs: { key: 'M-001' } }
      for (const [label, options] of [['undefined', undefined], ['null', null], ['empty object', {}]]) {
        seamCalls.length = 0
        m.reset()
        const result = await entry(readerContext(), job, options)
        assert.equal(result.evidence.ok, true, `${label}: runs`)
        assert.equal(m.log.reads.length, 1, `${label}: one read`)
        assert.deepEqual(seamCalls, [], `${label}: the checkpoint seam is never called`)
      }
      // Positive control: the stub does sit on the entry's path.
      seamCalls.length = 0
      await entry(readerContext(), job, { checkpoint: async () => {} })
      assert.deepEqual(seamCalls, ['load', 'read'], 'given a checkpoint: exactly two seam calls, in order')
    } finally {
      if (m) m.h.restore()
      if (savedSeam) require.cache[seamPath] = savedSeam
      else delete require.cache[seamPath]
      if (savedRoutes) require.cache[routesPath] = savedRoutes
      else delete require.cache[routesPath]
    }
  }],
]

if (require.main === module) {
  runFailClosedSuite('governed-configured-read-entry.test.cjs', tests, { passLine: 'governed-configured-read-entry.test.cjs OK' })
}

module.exports = { collectConfiguredReadSnapshots }
