'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const util = require('node:util')
const {
  ConnectionResolutionError,
  createConnectionResolver,
  FACADE_REFUSAL_REASONS,
  RESOLVER_REFUSAL_REASONS,
  CONNECTION_REFUSAL_LOG_MESSAGE,
  CONNECTION_REFUSAL_UNLISTED_CODE,
  __refusalLogInternals,
} = require('../lib/connection-resolver.cjs')
const {
  deriveStockPreparationSqlServerSourceAnchors,
  resolveStockPreparationSqlServerSource,
} = require('../lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs')

function binding(overrides = {}) {
  return {
    id: 'binding_1',
    kind: 'data-source:sql-readonly',
    tenantId: 'tenant_1',
    workspaceId: null,
    connectionId: 'connection_1',
    createdAt: '2026-09-01T00:00:00.000Z',
    legacyConnectionFallbackEligible: false,
    config: { schema: 'dbo' },
    ...overrides,
  }
}

function registration(overrides = {}) {
  return {
    id: 'connection_1',
    tenantId: 'tenant_1',
    type: 'sqlserver',
    scopeKind: 'private',
    ...overrides,
  }
}

function context(overrides = {}) {
  return {
    tenantId: 'tenant_1',
    workspaceId: null,
    principal: 'owner_1',
    runAs: 'user',
    ...overrides,
  }
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ConnectionResolutionError)
    assert.equal(error.code, code)
    assert.ok(error.details && typeof error.details.phase === 'string')
    assert.doesNotMatch(JSON.stringify(error.details), /connection_1|tenant_1|owner_1|secret/i)
    return true
  })
}

async function main() {
  const calls = []
  const facade = {
    async resolveConnectionRegistration(id, input) {
      calls.push({ id, input })
      return registration({ id })
    },
  }
  const resolver = createConnectionResolver({ facade })

  // Non-SQL kinds are cloned, unchanged, and do not query the host connection surface.
  const http = binding({ kind: 'http', connectionId: 'ignored', config: { baseUrl: 'https://example.test' } })
  const httpResolved = await resolver.resolve(http, context())
  assert.deepEqual(httpResolved, http)
  assert.notEqual(httpResolved, http)
  assert.notEqual(httpResolved.config, http.config)
  assert.equal(calls.length, 0)

  // Canonical reference is authoritative and only materializes the host registration id in memory.
  const canonical = await resolver.resolve(binding(), context())
  assert.equal(canonical.config.dataSourceId, 'connection_1')
  assert.equal(canonical.config.schema, 'dbo')
  assert.equal(canonical.credentials, undefined)
  assert.deepEqual(calls[0], {
    id: 'connection_1',
    input: { tenantId: 'tenant_1', workspaceId: null, principal: 'owner_1', runAs: 'user' },
  })

  // The sealed projection resolves the ordinary canonical Binding first, then
  // obtains physical SQL Server material only from its dedicated facade.
  const sealedCalls = []
  const sealedResolver = createConnectionResolver({
    facade,
    sealedSnapshotFacade: {
      async resolveSqlServerConnection(id, input) {
        sealedCalls.push({ id, input })
        return {
          connection: { database: 'sealed_db' },
          credentials: { password: 'sealed-secret', user: 'readonly' },
        }
      },
    },
  })
  const sealed = await sealedResolver.resolveSealedSqlServer(binding(), context())
  assert.equal(sealed.config.dataSourceId, 'connection_1')
  assert.deepEqual(sealed.config.sealedSnapshotSqlServer, { database: 'sealed_db' })
  assert.deepEqual(sealed.credentials, {
    sealedSnapshotSqlServer: { password: 'sealed-secret', user: 'readonly' },
  })
  assert.deepEqual(sealedCalls, [{
    id: 'connection_1',
    input: { tenantId: 'tenant_1', workspaceId: null, principal: 'owner_1', runAs: 'user' },
  }])

  await rejectsCode(
    () => sealedResolver.resolveSealedSqlServer(binding(), context({ runAs: 'service' })),
    'CONNECTION_SEALED_SNAPSHOT_USER_REQUIRED',
  )
  assert.equal(sealedCalls.length, 1, 'service runs never reach the secret-bearing facade')

  const uppercaseTypeSealed = await createConnectionResolver({
    facade: { async resolveConnectionRegistration(id) { return registration({ id, type: 'SQLSERVER' }) } },
    sealedSnapshotFacade: {
      async resolveSqlServerConnection() {
        return { connection: { database: 'sealed_db' }, credentials: { user: 'u', password: 'p' } }
      },
    },
  }).resolveSealedSqlServer(binding(), context())
  assert.equal(uppercaseTypeSealed.config.dataSourceId, 'connection_1')

  // Full in-memory handoff: Connection Resolver -> sealed source authority -> driver config.
  // Login/password are opaque connection material, so meaningful edge spaces must survive.
  const edgeSpaceUser = '  readonly login  '
  const edgeSpacePassword = '  sealed password bytes  '
  const endToEndResolver = createConnectionResolver({
    facade,
    sealedSnapshotFacade: {
      async resolveSqlServerConnection() {
        return {
          connection: {
            database: 'sealed_db',
            encrypt: true,
            instanceName: null,
            port: 1433,
            server: 'sql.example.test',
            trustServerCertificate: false,
          },
          credentials: { password: edgeSpacePassword, user: edgeSpaceUser },
        }
      },
    },
  })
  const resolvedSystem = await endToEndResolver.resolveSealedSqlServer(binding({
    capabilities: {},
    role: 'source',
    status: 'active',
  }), context())
  const identityKey = crypto.createHash('sha256').update('resolver-source-authority-e2e').digest()
  const authorityDraft = {
    approvedConfigVersionId: 'config-v1',
    bindingVersion: 'binding-v1',
    canonicalObjectVersion: 'stock-preparation-bom.v1',
    externalSystemId: 'binding_1',
    objectKey: 'stock-preparation-bom',
    relationId: 'sqlserver.relation.rowid_payload.v1',
    tableRef: 'dbo.stock_prep_sealed_rows',
    tenantId: 'tenant_1',
    workspaceId: null,
  }
  const derivedAuthority = deriveStockPreparationSqlServerSourceAnchors({
    binding: authorityDraft,
    externalSystem: resolvedSystem,
    identityKey,
  })
  const resolvedSource = resolveStockPreparationSqlServerSource({
    binding: {
      ...authorityDraft,
      ...derivedAuthority.anchors,
      bindingId: 'sealed-binding-row',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    externalSystem: resolvedSystem,
    identityKey,
  })
  assert.equal(resolvedSource.connectionConfig.user, edgeSpaceUser)
  assert.equal(resolvedSource.connectionConfig.password, edgeSpacePassword)

  // A dedicated-facade refusal remains terminal; it cannot reopen legacy fallback.
  await rejectsCode(
    () => createConnectionResolver({
      facade,
      sealedSnapshotFacade: { async resolveSqlServerConnection() { throw new Error('not exposed') } },
    }).resolveSealedSqlServer(binding({
      legacyConnectionFallbackEligible: true,
      config: { dataSourceId: 'connection_1' },
    }), context()),
    'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
  )

  // A retained old pointer is allowed only when it names the same Connection.
  await resolver.resolve(binding({ config: { dataSourceId: 'connection_1' } }), context())
  await rejectsCode(
    () => resolver.resolve(binding({ config: { dataSourceId: 'other_connection' } }), context()),
    'CONNECTION_BINDING_MISMATCH',
  )

  // Canonical failures cannot reach legacy, even if every legacy marker is otherwise true.
  let canonicalCalls = 0
  const failingCanonical = createConnectionResolver({
    facade: {
      async resolveConnectionRegistration() {
        canonicalCalls += 1
        throw new Error('not exposed')
      },
    },
  })
  await rejectsCode(
    () => failingCanonical.resolve(binding({
      legacyConnectionFallbackEligible: true,
      config: { dataSourceId: 'connection_1' },
    }), context()),
    'CONNECTION_CANONICAL_UNAVAILABLE',
  )
  assert.equal(canonicalCalls, 1)

  await rejectsCode(
    () => resolver.resolve(binding({ connectionId: 'connection_1' }), context({ tenantId: 'tenant_2' })),
    'CONNECTION_TENANT_MISMATCH',
  )
  await rejectsCode(
    () => createConnectionResolver({ facade: { async resolveConnectionRegistration() { return registration({ id: 'wrong' }) } } })
      .resolve(binding(), context()),
    'CONNECTION_ID_MISMATCH',
  )
  await rejectsCode(
    () => createConnectionResolver({ facade: { async resolveConnectionRegistration() { return registration({ type: 'http' }) } } })
      .resolve(binding(), context()),
    'CONNECTION_TYPE_UNSUPPORTED',
  )
  await rejectsCode(
    () => createConnectionResolver({
      facade: { async resolveConnectionRegistration() { return registration({ tenantId: 'tenant_2' }) } },
    }).resolve(binding(), context()),
    'CONNECTION_TENANT_MISMATCH',
  )

  // Legacy is explicit, old, owner-user only, tenant-bound, and must use a legacy-private registration.
  const legacyCalls = []
  const legacyResolver = createConnectionResolver({
    facade: {
      async resolveConnectionRegistration(id, input) {
        legacyCalls.push({ id, input })
        return registration({ id, scopeKind: 'legacy_private' })
      },
    },
  })
  const legacy = await legacyResolver.resolve(binding({
    connectionId: null,
    legacyConnectionFallbackEligible: true,
    createdAt: '2026-08-31T23:59:59.000Z',
    config: { dataSourceId: 'connection_1', schema: 'dbo' },
  }), context())
  assert.equal(legacy.config.dataSourceId, 'connection_1')
  assert.deepEqual(legacyCalls, [{
    id: 'connection_1',
    input: { tenantId: 'tenant_1', workspaceId: null, principal: 'owner_1', runAs: 'user' },
  }])

  const legacyBase = {
    connectionId: null,
    legacyConnectionFallbackEligible: true,
    createdAt: '2026-08-31T23:59:59.000Z',
    config: { dataSourceId: 'connection_1' },
  }
  await rejectsCode(() => legacyResolver.resolve(binding({ ...legacyBase, legacyConnectionFallbackEligible: false }), context()), 'CONNECTION_LEGACY_FALLBACK_DENIED')
  await rejectsCode(() => resolver.resolve(binding({ ...legacyBase, createdAt: 'not-a-date' }), context()), 'CONNECTION_LEGACY_FALLBACK_DENIED')
  const workspaceLegacy = await legacyResolver.resolve(
    binding({ ...legacyBase, workspaceId: 'workspace_1' }),
    context({ workspaceId: 'workspace_1' }),
  )
  assert.equal(workspaceLegacy.config.dataSourceId, 'connection_1',
    'workspace context does not widen the owner-only facade decision')
  await rejectsCode(() => legacyResolver.resolve(binding(legacyBase), context({ runAs: 'service' })), 'CONNECTION_LEGACY_FALLBACK_DENIED')
  await rejectsCode(() => resolver.resolve(binding(legacyBase), context({ principal: null })), 'CONNECTION_LEGACY_FALLBACK_DENIED')
  await rejectsCode(() => resolver.resolve(binding({ ...legacyBase, tenantId: null }), context()), 'CONNECTION_TENANT_MISMATCH')
  await rejectsCode(() => resolver.resolve(binding({ ...legacyBase, config: {} }), context()), 'CONNECTION_LEGACY_POINTER_REQUIRED')
  const unconfirmedLegacyTenant = await createConnectionResolver({
    facade: { async resolveConnectionRegistration(id) { return registration({ id, tenantId: null, scopeKind: 'legacy_private' }) } },
  }).resolve(binding(legacyBase), context())
  assert.equal(unconfirmedLegacyTenant.config.dataSourceId, 'connection_1',
    'a pre-cutover tenant-null registration remains owner-user only')
  await rejectsCode(
    () => createConnectionResolver({
      facade: {
        async resolveConnectionRegistration(id) {
          return registration({ id, tenantId: 'tenant_2', scopeKind: 'legacy_private' })
        },
      },
    }).resolve(binding(legacyBase), context()),
    'CONNECTION_TENANT_MISMATCH',
  )
  await rejectsCode(
    () => createConnectionResolver({ facade: { async resolveConnectionRegistration(id) { return registration({ id, scopeKind: 'workspace' }) } } })
      .resolve(binding(legacyBase), context()),
    'CONNECTION_LEGACY_FALLBACK_DENIED',
  )

  // Undefined is a post-cutover/new-shape orphan, never an implicit legacy read.
  await rejectsCode(
    () => resolver.resolve(binding({ connectionId: undefined, legacyConnectionFallbackEligible: true, config: { dataSourceId: 'connection_1' } }), context()),
    'CONNECTION_ID_REQUIRED',
  )

  await refusalReasonLogTests()

  console.log('✓ connection-resolver policy tests passed')
}

// ---------------------------------------------------------------------------
// Refusal reasons: WHY a connection was refused, one values-free line in the server log
// (docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §5 R1).
//
// Pins, for each of the three catch blocks that turn a facade refusal into a connection error
// (canonical, legacy, sealed snapshot):
//   1. exactly one line, with the phase, the connection error code and the reason the refusal carries;
//   2. a refusal without a reason — or with a word outside the closed list, however close — is
//      written as `unclassified`, never as the word or the message it came with;
//   3. what is THROWN is what was thrown before the line existed: same class, code, message and
//      details, no new own property, no symbol, no cause — with a logger, without one, and with a
//      logger that throws;
//   4. "no facade injected" is `facade_unavailable`, decided by where the try block failed and by
//      nothing the error carries — a facade cannot pass for it, whatever it throws;
//   5. nothing is awaited between the refusal and the throw, and the line costs no microtask;
//   6. no id, owner, tenant, configuration or error text reaches the line.
// ---------------------------------------------------------------------------
const REASON_KEY = Symbol.for('metasheet.dataSource.refusalReason')
// Every value a case plants carries this marker, so "nothing reached the log" is one substring check.
const MARK = 'zq9mark'

// Look-alikes of a listed word, built from code points so that no invisible character sits in this
// file: the full-width form of every letter, and the word followed by a zero-width space.
const FULL_WIDTH_OWNER_MISMATCH = Array.from('owner_mismatch', (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join('')
const ZERO_WIDTH_OWNER_MISMATCH = `owner_mismatch${String.fromCharCode(0x200b)}`

// What each catch block threw before the refusal line existed, verbatim.
const REFUSAL_OF_PHASE = {
  canonical: {
    code: 'CONNECTION_CANONICAL_UNAVAILABLE',
    message: 'canonical connection is unavailable',
    details: { phase: 'canonical' },
  },
  legacy: {
    code: 'CONNECTION_LEGACY_UNAVAILABLE',
    message: 'legacy connection is unavailable',
    details: { phase: 'legacy' },
  },
  sealed_snapshot: {
    code: 'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
    message: 'sealed snapshot connection is unavailable',
    details: { phase: 'sealed_snapshot' },
  },
}
const PHASES = Object.keys(REFUSAL_OF_PHASE)

// Microtask ticks a refusal takes to settle, per phase, measured on the code as it stood before the
// line existed. An added `await` (or any scheduled step) on the refusal path changes the number.
const REFUSAL_TICKS_BEFORE = { canonical: 4, legacy: 4, sealed_snapshot: 5 }

function markedRefusal(reason, { enumerable = false } = {}) {
  const error = new Error(`Data source with id 'ds_${MARK}' not found (owner ${MARK})`)
  error.name = 'DataSourceUnavailableError'
  error.code = 'DATA_SOURCE_NOT_FOUND'
  error.status = 422
  Object.defineProperty(error, REASON_KEY, { value: reason, enumerable, writable: false, configurable: false })
  return error
}

function captureLogger() {
  const calls = []
  return {
    calls,
    logger: {
      info(...args) { calls.push(['info', args]) },
      error(...args) { calls.push(['error', args]) },
      warn(...args) { calls.push(['warn', args]) },
    },
  }
}

function markedBinding(overrides = {}) {
  return binding({
    id: `binding_${MARK}`,
    connectionId: `ds_${MARK}`,
    config: { schema: `schema_${MARK}` },
    ...overrides,
  })
}

function markedContext() {
  return context({ principal: `owner_${MARK}`, workspaceId: `workspace_${MARK}` })
}

// Drive one phase to its refusal. `thrower` is what the host facade does when it refuses.
function refuseIn(phase, thrower, options = {}) {
  const refusing = { async resolveConnectionRegistration() { return thrower() } }
  const passing = { async resolveConnectionRegistration(id) { return registration({ id }) } }
  if (phase === 'canonical') {
    const resolver = createConnectionResolver({ facade: refusing, ...options })
    return () => resolver.resolve(markedBinding(), markedContext())
  }
  if (phase === 'legacy') {
    const resolver = createConnectionResolver({ facade: refusing, ...options })
    return () => resolver.resolve(markedBinding({
      connectionId: null,
      legacyConnectionFallbackEligible: true,
      createdAt: '2026-08-31T23:59:59.000Z',
      config: { dataSourceId: `ds_${MARK}`, schema: `schema_${MARK}` },
    }), markedContext())
  }
  const resolver = createConnectionResolver({
    facade: passing,
    sealedSnapshotFacade: { async resolveSqlServerConnection() { return thrower() } },
    ...options,
  })
  return () => resolver.resolveSealedSqlServer(markedBinding(), markedContext())
}

async function thrownBy(action) {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error('expected a refusal, the call resolved')
}

// Everything about an error that anything downstream could read, hidden parts included.
function visible(error) {
  return {
    isResolverError: error instanceof ConnectionResolutionError,
    constructorName: error && error.constructor && error.constructor.name,
    name: error.name,
    code: error.code,
    message: error.message,
    details: error.details,
    ownNames: Object.getOwnPropertyNames(error).sort(),
    ownSymbols: Object.getOwnPropertySymbols(error).map(String),
    enumerable: Object.keys(error).sort(),
    hasCause: 'cause' in error,
    hasReason: 'reason' in error,
    json: JSON.stringify(error),
  }
}

// Count microtask ticks until the call settles. Deterministic for a given await structure.
async function settleCounted(invoke) {
  let settled = false
  const run = (async () => {
    try {
      await invoke()
    } catch {
      // the refusal is the expected outcome
    }
    settled = true
  })()
  let ticks = 0
  while (!settled) {
    ticks += 1
    if (ticks > 100000) throw new Error('the resolution never settled on microtasks alone')
    await null
  }
  await run
  return ticks
}

function assertOneLine(calls, expected, label) {
  assert.equal(calls.length, 1, `${label}: exactly one line`)
  assert.deepEqual(calls[0], ['warn', [CONNECTION_REFUSAL_LOG_MESSAGE, expected]], `${label}: the line`)
  const [, [message, meta]] = calls[0]
  assert.equal(typeof message, 'string')
  assert.deepEqual(Object.keys(meta).sort(), ['code', 'phase', 'reason'], `${label}: three words and nothing else`)
  assertValuesFree(calls, label)
}

function assertValuesFree(calls, label) {
  const shown = `${JSON.stringify(calls)} ${util.inspect(calls, { depth: null, showHidden: true })}`
  assert.ok(!shown.includes(MARK), `${label}: no planted value may reach the log`)
  const written = JSON.stringify(calls)
  for (const text of ['not found', 'Data source with id', 'stack', '    at ', 'Error']) {
    assert.ok(!written.includes(text), `${label}: no error text in the log (${text})`)
  }
}

function stripLineComments(source) {
  return source.split('\n').map((line) => {
    const at = line.indexOf('//')
    return at < 0 ? line : line.slice(0, at)
  }).join('\n')
}

function catchBlocksOf(source) {
  const blocks = []
  let from = 0
  for (;;) {
    const at = source.indexOf('} catch', from)
    if (at < 0) break
    const open = source.indexOf('{', at + 1)
    let depth = 0
    let end = -1
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      if (source[index] === '}') {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    assert.ok(open > at && end > open, 'a catch block must open and close')
    blocks.push(source.slice(open, end + 1))
    from = end + 1
  }
  return blocks
}

// Anything that would put a step between the refusal and the throw, or read something.
const NOT_IN_A_REFUSAL_PATH = [
  'await', 'async', '.then(', 'Promise', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask',
  'nextTick', 'require(', 'readFile', 'process.', '.query(', '.execute(',
]

async function refusalReasonLogTests() {
  // --- the two lists -------------------------------------------------------------------------
  assert.ok(Object.isFrozen(FACADE_REFUSAL_REASONS), 'the admitted list is frozen')
  assert.ok(Object.isFrozen(RESOLVER_REFUSAL_REASONS), 'the resolver words are frozen')
  // Pinned verbatim: widening the list is a reviewed change to this array, never a side effect.
  assert.deepEqual([...FACADE_REFUSAL_REASONS], [
    'principal_missing',
    'tenant_missing',
    'run_as_invalid',
    'owner_mismatch',
    'not_loaded_credentials_unreadable',
    'not_loaded_unsupported_type',
    'not_loaded_load_failed',
    'not_loaded_absent',
    'load_state_unknown',
    'scope_missing',
    'tenant_mismatch',
    'tenantless_scope',
    'tenantless_service',
    'sealed_run_as_not_user',
    'sealed_type_unsupported',
    'sealed_adapter_unavailable',
    'sealed_not_read_only',
    'sealed_config_unreadable',
    'sealed_connection_not_representable',
  ])
  assert.deepEqual([...RESOLVER_REFUSAL_REASONS], ['facade_unavailable', 'unclassified'])
  assert.equal(new Set(FACADE_REFUSAL_REASONS).size, FACADE_REFUSAL_REASONS.length, 'no duplicates')
  for (const word of RESOLVER_REFUSAL_REASONS) {
    assert.ok(!FACADE_REFUSAL_REASONS.includes(word), `${word} is written by the resolver only, never admitted from a refusal`)
  }
  assert.equal(CONNECTION_REFUSAL_LOG_MESSAGE, '[plugin-integration-core] connection refused')
  assert.equal(CONNECTION_REFUSAL_UNLISTED_CODE, 'UNLISTED')

  // --- 1 + 3: every listed reason, in every phase ---------------------------------------------
  for (const phase of PHASES) {
    const before = REFUSAL_OF_PHASE[phase]
    const built = visible(new ConnectionResolutionError(before.code, before.message, before.details))
    const quiet = visible(await thrownBy(refuseIn(phase, () => { throw markedRefusal('owner_mismatch') })))
    assert.deepEqual(quiet, built, `${phase}: without a logger the refusal is the one built before`)
    for (const reason of FACADE_REFUSAL_REASONS) {
      const label = `${phase} / ${reason}`
      const { calls, logger } = captureLogger()
      const error = await thrownBy(refuseIn(phase, () => { throw markedRefusal(reason) }, { logger }))
      assertOneLine(calls, { phase, code: before.code, reason }, label)
      assert.deepEqual(visible(error), built, `${label}: the thrown error is unchanged`)
      assert.deepEqual(
        { code: error.code, message: error.message, details: error.details, name: error.name },
        { ...before, name: 'ConnectionResolutionError' },
        `${label}: code, message and details as before`,
      )
      assert.ok(!util.inspect(error, { showHidden: true, depth: null }).includes(MARK), `${label}: nothing of the facade refusal rides on the thrown error`)
    }
  }
  console.log(`  ✓ ${PHASES.length} phases x ${FACADE_REFUSAL_REASONS.length} reasons: one line each, thrown error unchanged`)

  // --- 2: no reason, or a word that is not in the list ----------------------------------------
  const stringKeyed = () => {
    const error = new Error(`${MARK} refused`)
    error.reason = 'owner_mismatch'
    error.refusalReason = 'owner_mismatch'
    error.details = { reason: 'owner_mismatch' }
    return error
  }
  const throwingGetter = () => {
    const error = new Error(`${MARK} refused`)
    Object.defineProperty(error, REASON_KEY, { get() { throw new RangeError(`${MARK} getter`) } })
    return error
  }
  const notAdmitted = [
    ['a plain error', () => new Error(`${MARK} refused`)],
    ['a string-keyed reason', stringKeyed],
    ['a local symbol of the same description', () => Object.assign(new Error(`${MARK}`), { [Symbol('metasheet.dataSource.refusalReason')]: 'owner_mismatch' })],
    ['a throwing getter', throwingGetter],
    ['a proxy whose traps throw', () => new Proxy(new Error(`${MARK}`), { get() { throw new Error(`${MARK} trap`) } })],
    // words the resolver writes itself are not admitted from a refusal
    ...RESOLVER_REFUSAL_REASONS.map((word) => [`the resolver word ${word}`, () => markedRefusal(word)]),
    // near misses and value-carrying look-alikes of listed words
    ...[
      'OWNER_MISMATCH', 'Owner_mismatch', ' owner_mismatch', 'owner_mismatch ', 'owner_mismatch\n',
      `owner_mismatch:${MARK}`, `owner_mismatch ${MARK}`, `not_loaded_${MARK}`, 'not_loaded', 'not_loaded_',
      'owner_mismatchs', 'owner', '', 'constructor', '__proto__', 'hasOwnProperty', 'toString',
      FULL_WIDTH_OWNER_MISMATCH, ZERO_WIDTH_OWNER_MISMATCH,
    ].map((word) => [`the word ${JSON.stringify(word)}`, () => markedRefusal(word)]),
    // values that are not strings
    ['a String object of a listed word', () => markedRefusal(new String('owner_mismatch'))], // eslint-disable-line no-new-wrappers
    ['an array holding a listed word', () => markedRefusal(['owner_mismatch'])],
    ['an object whose toString is a listed word', () => markedRefusal({ toString() { return 'owner_mismatch' } })],
    ['a number', () => markedRefusal(7)],
    ['a symbol', () => markedRefusal(Symbol('owner_mismatch'))],
  ]
  for (const phase of PHASES) {
    const before = REFUSAL_OF_PHASE[phase]
    const built = visible(new ConnectionResolutionError(before.code, before.message, before.details))
    for (const [what, make] of notAdmitted) {
      const label = `${phase} / ${what}`
      const { calls, logger } = captureLogger()
      const error = await thrownBy(refuseIn(phase, () => { throw make() }, { logger }))
      assertOneLine(calls, { phase, code: before.code, reason: 'unclassified' }, label)
      assert.deepEqual(visible(error), built, `${label}: the thrown error is unchanged`)
    }
    // Thrown values that are not objects at all.
    for (const value of [`owner_mismatch ${MARK}`, 'owner_mismatch', 7, true, null, undefined, Symbol(MARK)]) {
      const label = `${phase} / thrown ${typeof value}`
      const { calls, logger } = captureLogger()
      const error = await thrownBy(refuseIn(phase, () => { throw value }, { logger }))
      assertOneLine(calls, { phase, code: before.code, reason: 'unclassified' }, label)
      assert.deepEqual(visible(error), built, `${label}: the thrown error is unchanged`)
    }
  }
  // An ENUMERABLE mark is still read (the word is closed either way); it is the host's job to hide it.
  {
    const { calls, logger } = captureLogger()
    await thrownBy(refuseIn('canonical', () => { throw markedRefusal('tenant_mismatch', { enumerable: true }) }, { logger }))
    assertOneLine(calls, { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', reason: 'tenant_mismatch' }, 'enumerable mark')
  }
  console.log(`  ✓ ${notAdmitted.length + 7} reasonless / unlisted / hostile refusals per phase written as unclassified`)

  // --- 4: no facade injected -------------------------------------------------------------------
  for (const phase of ['canonical', 'legacy']) {
    const before = REFUSAL_OF_PHASE[phase]
    for (const facade of [undefined, null, {}, { resolveConnectionRegistration: 'not a function' }]) {
      const { calls, logger } = captureLogger()
      const resolver = createConnectionResolver({ facade, logger })
      const input = phase === 'canonical'
        ? markedBinding()
        : markedBinding({
          connectionId: null,
          legacyConnectionFallbackEligible: true,
          createdAt: '2026-08-31T23:59:59.000Z',
          config: { dataSourceId: `ds_${MARK}` },
        })
      const error = await thrownBy(() => resolver.resolve(input, markedContext()))
      assertOneLine(calls, { phase, code: before.code, reason: 'facade_unavailable' }, `${phase} / no facade`)
      assert.deepEqual(
        visible(error),
        visible(new ConnectionResolutionError(before.code, before.message, before.details)),
        `${phase} / no facade: the thrown error is unchanged`,
      )
    }
  }
  {
    // Sealed: the error of requireSealedSnapshotFacade is rethrown as it is, after one line.
    const passing = { async resolveConnectionRegistration(id) { return registration({ id }) } }
    const sealedS1 = new ConnectionResolutionError(
      'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
      'sealed snapshot connection resolution is unavailable',
      { phase: 'sealed_snapshot' },
    )
    for (const sealedSnapshotFacade of [undefined, null, {}]) {
      const { calls, logger } = captureLogger()
      const error = await thrownBy(() => createConnectionResolver({ facade: passing, sealedSnapshotFacade, logger })
        .resolveSealedSqlServer(markedBinding(), markedContext()))
      assertOneLine(calls, {
        phase: 'sealed_snapshot',
        code: 'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
        reason: 'facade_unavailable',
      }, 'sealed / no sealed facade')
      assert.deepEqual(visible(error), visible(sealedS1), 'sealed / no sealed facade: rethrown unchanged')
      const quiet = await thrownBy(() => createConnectionResolver({ facade: passing, sealedSnapshotFacade })
        .resolveSealedSqlServer(markedBinding(), markedContext()))
      assert.deepEqual(visible(quiet), visible(sealedS1), 'sealed / no sealed facade, no logger: the same error')
    }
  }
  {
    // A facade cannot pass for "no facade": the same class, code and message, built elsewhere.
    const forged = () => new ConnectionResolutionError(
      'CONNECTION_RESOLUTION_UNAVAILABLE',
      'connection resolution is unavailable',
      { phase: 'facade' },
    )
    for (const phase of ['canonical', 'legacy']) {
      const { calls, logger } = captureLogger()
      await thrownBy(refuseIn(phase, () => { throw forged() }, { logger }))
      assertOneLine(calls, { phase, code: REFUSAL_OF_PHASE[phase].code, reason: 'unclassified' }, `${phase} / forged no-facade`)
    }
    // A facade that is there and throws before it returns a promise was reached: its reason is read.
    {
      const { calls, logger } = captureLogger()
      await thrownBy(() => createConnectionResolver({
        facade: { resolveConnectionRegistration() { throw markedRefusal('tenant_mismatch') } },
        logger,
      }).resolve(markedBinding(), markedContext()))
      assertOneLine(calls, { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', reason: 'tenant_mismatch' }, 'canonical / synchronous throw')
    }
    // Sealed rethrows an error of the resolver's own class unchanged — and writes a closed code for it.
    const foreign = new ConnectionResolutionError(`CONNECTION_${MARK.toUpperCase()}`, `${MARK} refused`, { phase: MARK })
    const { calls, logger } = captureLogger()
    const error = await thrownBy(refuseIn('sealed_snapshot', () => { throw foreign }, { logger }))
    assert.equal(error, foreign, 'sealed: an error of the resolver class is rethrown as the same object')
    assertOneLine(calls, {
      phase: 'sealed_snapshot',
      code: CONNECTION_REFUSAL_UNLISTED_CODE,
      reason: 'unclassified',
    }, 'sealed / foreign resolver error')
    // ... and carrying a listed reason does not change its code in the line.
    const foreignMarked = new ConnectionResolutionError('CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE', `${MARK}`, {})
    Object.defineProperty(foreignMarked, REASON_KEY, { value: 'owner_mismatch' })
    const second = captureLogger()
    await thrownBy(refuseIn('sealed_snapshot', () => { throw foreignMarked }, { logger: second.logger }))
    assertOneLine(second.calls, {
      phase: 'sealed_snapshot',
      code: CONNECTION_REFUSAL_UNLISTED_CODE,
      reason: 'owner_mismatch',
    }, 'sealed / foreign resolver error with a reason')
  }
  console.log('  ✓ no facade injected: facade_unavailable in all three phases, and nothing a facade throws passes for it')

  // --- a sealed resolution refused at its canonical stage writes the canonical line, once ------
  {
    const { calls, logger } = captureLogger()
    let sealedCalls = 0
    const error = await thrownBy(() => createConnectionResolver({
      facade: { async resolveConnectionRegistration() { throw markedRefusal('not_loaded_credentials_unreadable') } },
      sealedSnapshotFacade: { async resolveSqlServerConnection() { sealedCalls += 1; throw markedRefusal('owner_mismatch') } },
      logger,
    }).resolveSealedSqlServer(markedBinding(), markedContext()))
    assert.equal(sealedCalls, 0, 'the sealed facade is never reached')
    assert.equal(error.code, 'CONNECTION_CANONICAL_UNAVAILABLE')
    assertOneLine(calls, {
      phase: 'canonical',
      code: 'CONNECTION_CANONICAL_UNAVAILABLE',
      reason: 'not_loaded_credentials_unreadable',
    }, 'sealed resolution refused at the canonical stage')
  }

  // --- refusals the resolver decides itself write no line, and a resolution that passes writes none
  {
    const { calls, logger } = captureLogger()
    const passing = { async resolveConnectionRegistration(id) { return registration({ id }) } }
    const resolver = createConnectionResolver({ facade: passing, logger })
    await resolver.resolve(binding(), context())
    await rejectsCode(() => resolver.resolve(binding(), context({ tenantId: 'tenant_2' })), 'CONNECTION_TENANT_MISMATCH')
    await rejectsCode(() => resolver.resolve(binding({ connectionId: '  ' }), context()), 'CONNECTION_ID_REQUIRED')
    await rejectsCode(
      () => createConnectionResolver({
        facade: { async resolveConnectionRegistration() { return registration({ type: 'http' }) } },
        logger,
      }).resolve(binding(), context()),
      'CONNECTION_TYPE_UNSUPPORTED',
    )
    assert.deepEqual(calls, [], 'only a facade refusal writes the line')
  }

  // --- 3: a logger that throws, or is not a logger, changes nothing ----------------------------
  for (const phase of PHASES) {
    const before = REFUSAL_OF_PHASE[phase]
    const built = visible(new ConnectionResolutionError(before.code, before.message, before.details))
    let attempts = 0
    const throwing = { warn() { attempts += 1; throw new Error(`${MARK} logger failed`) } }
    const error = await thrownBy(refuseIn(phase, () => { throw markedRefusal('owner_mismatch') }, { logger: throwing }))
    assert.equal(attempts, 1, `${phase}: the line is attempted once`)
    assert.deepEqual(visible(error), built, `${phase}: a throwing logger does not change the refusal`)
    for (const logger of [null, undefined, {}, { warn: 'not a function' }, { info() { throw new Error('wrong level') } }]) {
      const quiet = await thrownBy(refuseIn(phase, () => { throw markedRefusal('owner_mismatch') }, { logger }))
      assert.deepEqual(visible(quiet), built, `${phase}: no usable logger, the same refusal`)
    }
  }
  console.log('  ✓ a throwing or missing logger leaves the refusal unchanged')

  // --- 5: structure — nothing between the refusal and the throw --------------------------------
  {
    const source = stripLineComments(createConnectionResolver.toString())
    const blocks = catchBlocksOf(source)
    assert.equal(blocks.length, 3, 'canonical, legacy and sealed snapshot: three catch blocks')
    for (const [index, block] of blocks.entries()) {
      const phase = PHASES[index]
      assert.ok(block.includes(`'${phase}'`), `catch block ${index} is the ${phase} one`)
      assert.ok(block.includes('writeRefusalLine(refusalLogger,'), `${phase}: the catch writes the line`)
      assert.ok(block.includes('throw '), `${phase}: the catch throws`)
      assert.ok(
        block.indexOf('writeRefusalLine(') < block.indexOf('throw '),
        `${phase}: the line is written before the throw`,
      )
      for (const token of NOT_IN_A_REFUSAL_PATH) {
        assert.ok(!block.includes(token), `${phase}: the catch block must not contain ${token}`)
      }
    }
    // Every `catch` of the resolver binds the error: a bare `catch {` would drop the reason again.
    assert.ok(!source.includes('catch {'), 'no catch block drops the refusal')
    // One line per throw: the sealed block has two exits, the other two have one.
    const count = (text, needle) => text.split(needle).length - 1
    assert.deepEqual(
      blocks.map((block) => [count(block, 'writeRefusalLine('), count(block, 'throw ')]),
      [[1, 1], [1, 1], [2, 2]],
      'as many lines as exits, in every catch block',
    )
    for (const [name, fn] of Object.entries(__refusalLogInternals)) {
      const text = stripLineComments(fn.toString())
      assert.ok(text.startsWith(`function ${name}(`), `${name} is a plain function, not an async one`)
      for (const token of NOT_IN_A_REFUSAL_PATH) {
        assert.ok(!text.includes(token), `${name} must not contain ${token}`)
      }
    }
    const { calls, logger } = captureLogger()
    assert.equal(
      __refusalLogInternals.writeRefusalLine(logger, 'canonical', 'CONNECTION_CANONICAL_UNAVAILABLE', markedRefusal('owner_mismatch'), true),
      undefined,
      'the line is written by a call that returns nothing to wait for',
    )
    assert.equal(calls.length, 1, 'and it is written by the time the call returns')
    // The reason of a refusal is read only once the facade was reached; short of exactly `true`
    // the word is facade_unavailable, so a catch block that forgets the flag cannot pass unnoticed.
    const { refusalReasonOf } = __refusalLogInternals
    assert.equal(refusalReasonOf(markedRefusal('owner_mismatch'), true), 'owner_mismatch')
    for (const notReached of [false, undefined, null, 0, 1, 'true', {}]) {
      assert.equal(refusalReasonOf(markedRefusal('owner_mismatch'), notReached), 'facade_unavailable')
    }
  }
  // ... and behaviour: the line costs no microtask, whatever the reason, and none was there before.
  for (const phase of PHASES) {
    const counts = new Map()
    const measure = async (label, thrower, options) => {
      counts.set(label, await settleCounted(refuseIn(phase, thrower, options)))
    }
    await measure('no logger', () => { throw markedRefusal('owner_mismatch') })
    await measure('no logger, no reason', () => { throw new Error(`${MARK}`) })
    for (const reason of FACADE_REFUSAL_REASONS) {
      await measure(reason, () => { throw markedRefusal(reason) }, { logger: captureLogger().logger })
    }
    await measure('unclassified', () => { throw new Error(`${MARK}`) }, { logger: captureLogger().logger })
    await measure('throwing logger', () => { throw markedRefusal('owner_mismatch') }, {
      logger: { warn() { throw new Error(`${MARK}`) } },
    })
    assert.deepEqual(
      [...new Set(counts.values())],
      [REFUSAL_TICKS_BEFORE[phase]],
      `${phase}: every refusal settles in the number of ticks it took before the line existed`,
    )
  }
  // ... and the line is written IN the turn that catches the refusal, not one scheduled from it. The
  // facade hands back a promise that is already rejected, with this test's own reaction attached
  // first: that reaction runs, then the resolver's catch block, then the microtask the reaction
  // queued. A line written from any scheduled step — a microtask, a timer, a floating promise —
  // lands after that marker, whatever the source text of the resolver looks like.
  for (const phase of PHASES) {
    for (const thrower of [() => markedRefusal('owner_mismatch'), () => new Error(`${MARK} refused`)]) {
      const events = []
      const logger = { warn() { events.push('line written') } }
      // Built when the facade is called, so that this reaction is the one queued right before the
      // resolver's own.
      const raise = () => {
        const refusal = Promise.reject(thrower())
        refusal.catch(() => {
          events.push('refusal raised')
          queueMicrotask(() => events.push('one microtask after the catch'))
        })
        return refusal
      }
      const refusing = { resolveConnectionRegistration() { return raise() } }
      const passing = { async resolveConnectionRegistration(id) { return registration({ id }) } }
      let action
      if (phase === 'sealed_snapshot') {
        const resolver = createConnectionResolver({
          facade: passing,
          sealedSnapshotFacade: { resolveSqlServerConnection() { return raise() } },
          logger,
        })
        action = () => resolver.resolveSealedSqlServer(markedBinding(), markedContext())
      } else {
        const resolver = createConnectionResolver({ facade: refusing, logger })
        action = () => resolver.resolve(phase === 'canonical'
          ? markedBinding()
          : markedBinding({
            connectionId: null,
            legacyConnectionFallbackEligible: true,
            createdAt: '2026-08-31T23:59:59.000Z',
            config: { dataSourceId: `ds_${MARK}` },
          }), markedContext())
      }
      await thrownBy(action)
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(
        events,
        ['refusal raised', 'line written', 'one microtask after the catch'],
        `${phase}: the line is written in the turn that catches the refusal`,
      )
    }
  }
  console.log('  ✓ structure: three catch blocks, nothing awaited, same microtask count as before, line written in the catching turn')

  // --- 6: values-free, across everything written above ----------------------------------------
  {
    const { calls, logger } = captureLogger()
    for (const phase of PHASES) {
      for (const reason of [...FACADE_REFUSAL_REASONS, `${MARK}`, `owner_mismatch ${MARK}`]) {
        const loud = markedRefusal(reason)
        loud.stack = `${MARK} stack\n    at ${MARK} (${MARK}.cjs:1:1)`
        loud.details = { dataSourceId: `ds_${MARK}`, ownerId: `owner_${MARK}`, tenantId: `tenant_${MARK}` }
        loud.cause = new Error(`${MARK} cause`)
        loud.config = { connection: { server: `${MARK}.example.test` }, credentials: { password: MARK } }
        await thrownBy(refuseIn(phase, () => { throw loud }, { logger }))
      }
    }
    assert.equal(calls.length, PHASES.length * (FACADE_REFUSAL_REASONS.length + 2))
    assertValuesFree(calls, 'values-free sweep')
    const admitted = new Set([...FACADE_REFUSAL_REASONS, ...RESOLVER_REFUSAL_REASONS])
    const codes = new Set(PHASES.map((phase) => REFUSAL_OF_PHASE[phase].code))
    for (const [level, args] of calls) {
      assert.equal(level, 'warn')
      assert.equal(args.length, 2, 'a message and one object, nothing appended')
      assert.equal(args[0], CONNECTION_REFUSAL_LOG_MESSAGE)
      assert.deepEqual(Object.keys(args[1]).sort(), ['code', 'phase', 'reason'])
      assert.ok(PHASES.includes(args[1].phase))
      assert.ok(codes.has(args[1].code))
      assert.ok(admitted.has(args[1].reason))
    }
  }
  console.log('  ✓ values-free: no id, owner, tenant, configuration, error text or stack in any line')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
