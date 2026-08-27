'use strict'

// THE B2a REGISTRATION CONTRACT — normalization at load, and the guard decision at check.
//
// This suite pins what the registry DECIDES. b2a-trial-registry-wiring.test.cjs pins the only thing
// that makes any of it matter: that the four inventoried read entry points reach it, and that a
// refusal happens before a single source row is read.
//
// Case ids follow the acceptance matrix (R-01 … R-04) so the verification record maps 1:1. R-05
// (SQL Server timeout / stable paging / row+page caps), R-06 (schema contract and drift) and R-08
// (expiry disposition of value-bearing artifacts) are NOT covered here and are NOT claimed — see the
// gap list in the change description.
//
// Hermetic: no DB, no network, no filesystem, no wall clock (every check is handed an explicit
// `now`, and the claim store is an in-memory Map). Values-free: the only literals are synthetic ids,
// frozen reason tokens and ISO timestamps this file authors itself.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  B2A_REGISTRY_CONFIG_KEY,
  B2A_PURPOSES,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
  B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
  B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN,
  B2A_PURPOSE_PIPELINE_RUNNER_READ,
  B2A_PURPOSE_SEALED_SNAPSHOT_SQLSERVER,
  B2A_ERROR_CODES,
  B2A_REGISTRATION_REQUIRED,
  B2A_AUTHORIZATION_INVALID,
  B2A_SCOPE_MISMATCH,
  B2A_SOURCE_TIMEOUT,
  B2A_PAGE_LIMIT_EXCEEDED,
  B2A_SCHEMA_DRIFT,
  C6_SAFE_LIFECYCLE_REQUIRED,
  B2A_REGISTRY_INVALID,
  B2A_EXPIRY_HANDLINGS,
  MAX_B2A_REGISTRATION_WINDOW_MS,
  B2aReadAuthorizationError,
  assertB2aReadAuthorization,
  createB2aRegistry,
  readPlanSourceObjects,
  resolveB2aRegistryConfig,
} = require(path.join(LIB, 'b2a-trial-registry.cjs'))

const {
  PROD_CANONICAL_OBJECT_ID,
  normalizeStockPrepApplyProductionPolicy,
} = require(path.join(LIB, 'stock-preparation-production-policy.cjs'))

const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
} = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))

// The literal the HOST writes onto server config (packages/core-backend/src/plugin-runtime-config.ts).
// Stated as a literal rather than imported and compared to itself: a self-referential assertion
// passes just as happily when the constant is mistyped and the gate is permanently dormant.
assert.equal(B2A_REGISTRY_CONFIG_KEY, 'b2aTrialRegistry')

// The FROZEN error vocabulary, restated for the same reason.
assert.deepEqual([...B2A_ERROR_CODES], [
  'B2A_REGISTRATION_REQUIRED',
  'B2A_AUTHORIZATION_INVALID',
  'B2A_SCOPE_MISMATCH',
  'B2A_SOURCE_TIMEOUT',
  'B2A_PAGE_LIMIT_EXCEEDED',
  'B2A_SCHEMA_DRIFT',
  'C6_SAFE_LIFECYCLE_REQUIRED',
])
assert.equal(B2A_REGISTRATION_REQUIRED, 'B2A_REGISTRATION_REQUIRED')
assert.equal(B2A_AUTHORIZATION_INVALID, 'B2A_AUTHORIZATION_INVALID')
assert.equal(B2A_SCOPE_MISMATCH, 'B2A_SCOPE_MISMATCH')
assert.equal(B2A_SOURCE_TIMEOUT, 'B2A_SOURCE_TIMEOUT')
assert.equal(B2A_PAGE_LIMIT_EXCEEDED, 'B2A_PAGE_LIMIT_EXCEEDED')
assert.equal(B2A_SCHEMA_DRIFT, 'B2A_SCHEMA_DRIFT')
assert.equal(C6_SAFE_LIFECYCLE_REQUIRED, 'C6_SAFE_LIFECYCLE_REQUIRED')

const TENANT = 'tenant_1'
const OTHER_TENANT = 'tenant_2'
const PLM_SYSTEM = 'plm_sql_source'
const K3_SYSTEM = 'k3_sql_source'
const SYSTEM_TYPE = 'data-source:sql-readonly'
const OTHER_SYSTEM_TYPE = 'bridge:legacy-sql-readonly'
const IN_SCOPE_PROJECT = 'P-001'
const OUT_OF_SCOPE_PROJECT = 'P-999'
const OBJECT_A = 'DN_PDM_PathExAttrInfo'
const OBJECT_B = 'DN_PDM_PartLibraryInfo'
const UNLISTED_OBJECT = 'DN_PDM_SecretTable'

const T0 = Date.parse('2026-08-01T00:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = T0 + 10 * DAY_MS
const RUN = 'run-a'

// Whole seconds render without a fractional part; sub-second offsets KEEP theirs, because the
// window-cap boundary cases below are one millisecond wide and a lossy formatter would quietly turn
// "one ms past the cap" into "exactly at the cap" and pass vacuously.
function iso(ms) {
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z')
}

function registration(overrides = {}) {
  return {
    registrationId: 'b2a-factory-a-plm',
    tenantScope: TENANT,
    sourceSystemType: SYSTEM_TYPE,
    sourceBindingRef: PLM_SYSTEM,
    projectDataScope: { dataScopeRefs: [IN_SCOPE_PROJECT, 'P-002'] },
    objectScope: { sourceObjects: [OBJECT_A, OBJECT_B] },
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    ownerPrincipalRef: 'owner-ref-a',
    authorizationRef: 'auth-ref-a',
    operationRef: 'op-ref-a',
    effectiveAt: iso(T0),
    expiresAt: iso(T0 + 60 * DAY_MS),
    forbidReuse: true,
    sourceReadOperationLimit: 1,
    artifactReplayLimit: 0,
    consumptionState: 'unconsumed',
    consumedAt: null,
    b2bMigrationCondition: 'migrate onto the generalized binding before expiry',
    expiryHandling: 'deny_replay',
    status: 'active',
    registrationVersion: 1,
    ...overrides,
  }
}

function registryConfig(registrations, overrides = {}) {
  return { registryId: 'b2a-2026-q3', registryVersion: 1, registrations, ...overrides }
}

function build(registrations, overrides) {
  return createB2aRegistry({ config: { [B2A_REGISTRY_CONFIG_KEY]: registryConfig(registrations, overrides) } })
}

function store() {
  return new Map()
}

function check(registry, overrides = {}) {
  return assertB2aReadAuthorization({
    registry,
    store: overrides.store || store(),
    tenantScope: TENANT,
    sourceSystemType: SYSTEM_TYPE,
    sourceBindingRef: PLM_SYSTEM,
    dataScopeRef: IN_SCOPE_PROJECT,
    sourceObjects: [OBJECT_A],
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    runId: RUN,
    now: NOW,
    ...overrides,
  })
}

function captured(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

async function capturedAsync(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

function assertConfigThrow(registrations, label, overrides) {
  const error = captured(() => build(registrations, overrides))
  assert.ok(error, `${label}: load must throw`)
  assert.ok(error instanceof B2aReadAuthorizationError, `${label}: wrong error class (${error && error.name})`)
  assert.equal(error.code, B2A_REGISTRY_INVALID, label)
  assert.equal(error.status, 500, `${label}: a broken deployment is a 500, not a refused caller`)
  return error
}

const FORBIDDEN_IN_EVIDENCE = Object.freeze([
  IN_SCOPE_PROJECT, OUT_OF_SCOPE_PROJECT, TENANT, OTHER_TENANT,
  PLM_SYSTEM, K3_SYSTEM, OBJECT_A, OBJECT_B, UNLISTED_OBJECT,
  'owner-ref-a', 'auth-ref-a', 'op-ref-a',
  'migrate onto the generalized binding before expiry', '2026-08', '2026-09',
])

async function assertRefusal(registry, overrides, code, reason, label) {
  const error = await capturedAsync(check(registry, overrides))
  assert.ok(error, `${label}: the guard must refuse`)
  assert.ok(error instanceof B2aReadAuthorizationError, `${label}: wrong error class (${error && error.name})`)
  assert.equal(error.code, code, `${label}: wrong FIXED code`)
  assert.equal(error.status, 403, label)
  assert.equal(error.details.reason, reason, `${label}: wrong reason token`)
  // VALUES-FREE. A refusal may name registration ids, registry ids, fixed codes, reason tokens,
  // booleans and counts. It must never carry a tenant, a binding ref, a data-scope ref, a source
  // object name, an owner/authorization/operation ref, a migration condition or a date.
  const text = JSON.stringify({ message: error.message, details: error.details })
  for (const forbidden of FORBIDDEN_IN_EVIDENCE) {
    assert.equal(text.includes(forbidden), false, `${label}: refusal leaked ${JSON.stringify(forbidden)}`)
  }
  return error
}

// ── DORMANCY: no key, no gate ────────────────────────────────────────────────

async function dormantWhenTheKeyIsAbsent() {
  assert.equal(createB2aRegistry({ config: {} }), null, 'absent key is dormant')
  assert.equal(createB2aRegistry({}), null, 'absent config is dormant')
  assert.equal(createB2aRegistry(), null, 'no argument at all is dormant')
  assert.equal(createB2aRegistry({ config: { [B2A_REGISTRY_CONFIG_KEY]: undefined } }), null)
  assert.equal(createB2aRegistry({ config: { [B2A_REGISTRY_CONFIG_KEY]: null } }), null)
  assert.equal(resolveB2aRegistryConfig({}), undefined)

  // The guard, handed a dormant registry, returns null rather than a stanza — which is what lets
  // every caller add NOTHING to its evidence and stay byte-identical.
  assert.equal(await assertB2aReadAuthorization({ registry: null }), null)
  assert.equal(await assertB2aReadAuthorization({ registry: undefined }), null)
  assert.equal(await assertB2aReadAuthorization({}), null)
  // Dormant short-circuits BEFORE every other validation: a call with no tenant, no binding, no
  // scope, no purpose, no store and no clock is still simply not gated.
  assert.equal(await assertB2aReadAuthorization({ registry: null, tenantScope: null, now: NaN, store: null }), null)
}

// `false` is FATAL here where the ext-field mapping treats it as "switched off". That module needs a
// kill switch an operator can reach without taking the plugin down; the whole point of this one is
// that it cannot be switched off from inside the file it governs.
function switchingItOffFromInsideTheFileIsRefused() {
  for (const raw of [false, true, 0, 1, 'off', [], [registration()]]) {
    const error = captured(() => createB2aRegistry({ config: { [B2A_REGISTRY_CONFIG_KEY]: raw } }))
    assert.ok(error, `${JSON.stringify(raw)} must not be accepted as a registry`)
    assert.equal(error.code, B2A_REGISTRY_INVALID)
    assert.equal(error.status, 500)
    assert.ok(error.message.includes('INTEGRATION_CORE_B2A_REGISTRY_PATH'), 'the message names the env var')
  }
}

// ── LOAD-TIME VALIDATION ─────────────────────────────────────────────────────

async function registryEnvelopeIsValidated() {
  assertConfigThrow([], 'a registry must name itself', { registryId: undefined })
  assertConfigThrow([], 'registryVersion must be a positive integer', { registryVersion: 0 })
  assertConfigThrow([], 'registryVersion must be an integer', { registryVersion: 1.5 })
  assertConfigThrow([], 'an unknown envelope key is refused', { note: 'hello' })

  const missing = captured(() => createB2aRegistry({
    config: { [B2A_REGISTRY_CONFIG_KEY]: { registryId: 'r', registryVersion: 1 } },
  }))
  assert.ok(missing, 'registrations is required')
  assert.equal(missing.code, B2A_REGISTRY_INVALID)

  // AN ARMED, EMPTY REGISTRY IS LEGAL and refuses everything. This is the correct state for a
  // deployment that has armed the gate and has no approved exception yet; rejecting it would push
  // operators toward leaving the env var unset instead, which is strictly worse.
  const empty = build([])
  assert.notEqual(empty, null, 'an empty registry is ARMED, not dormant')
  assert.equal(empty.registrationCount, 0)
  await assertRefusal(empty, {}, B2A_REGISTRATION_REQUIRED, 'no_registration', 'an armed empty registry refuses everything')
}

function everyRegisteredFieldIsRequired() {
  // The contract asks each registration to state applicable tenant / system type / binding / data
  // scope / object scope / purpose / owner / authorization / operation / window / migration
  // condition / expiry handling / status / version. Each is refused when absent, AT LOAD.
  const requiredStrings = [
    'registrationId', 'tenantScope', 'sourceSystemType', 'sourceBindingRef', 'purpose',
    'ownerPrincipalRef', 'authorizationRef', 'operationRef', 'effectiveAt', 'expiresAt',
    'b2bMigrationCondition', 'expiryHandling', 'status', 'consumptionState',
  ]
  for (const field of requiredStrings) {
    assertConfigThrow([registration({ [field]: undefined })], `${field} is required`)
    assertConfigThrow([registration({ [field]: '   ' })], `${field} may not be blank`)
  }
  assertConfigThrow([registration({ projectDataScope: undefined })], 'projectDataScope is required')
  assertConfigThrow([registration({ objectScope: undefined })], 'objectScope is required')
  assertConfigThrow([registration({ registrationVersion: undefined })], 'registrationVersion is required')
  assertConfigThrow([registration({ registrationVersion: 0 })], 'registrationVersion must be positive')

  // Closed key sets at all three levels.
  assertConfigThrow([registration({ notAKey: 1 })], 'an unknown registration key is refused')
  assertConfigThrow([registration({ objectScope: { sourceObjects: [OBJECT_A], all: true } })], 'an unknown object-scope key is refused')
  assertConfigThrow([registration({ projectDataScope: { dataScopeRefs: [IN_SCOPE_PROJECT], all: true } })], 'an unknown data-scope key is refused')
  assertConfigThrow(['not-an-object'], 'a non-object registration is refused')

  // Closed vocabularies.
  assert.deepEqual([...B2A_EXPIRY_HANDLINGS], ['deny_replay', 'purge'])
  assertConfigThrow([registration({ expiryHandling: 'notify the owner' })], 'expiryHandling must be a known token')
  assertConfigThrow([registration({ status: 'paused' })], 'status must be a known token')
  assertConfigThrow([registration({ consumptionState: 'maybe' })], 'consumptionState must be a known token')
}

// A registration references a MANAGED BINDING. It never carries a host, an IP, a username, a
// password, a token or a connection string — and the refusal names that rule rather than the generic
// "unsupported key", which a deployer would read as an invitation to find the supported spelling.
function connectionDetailIsRefusedByName() {
  for (const key of ['host', 'port', 'username', 'password', 'token', 'connectionString', 'dsn', 'database']) {
    const error = assertConfigThrow([registration({ [key]: 'x' })], `${key} is refused`)
    assert.equal(error.details.reason, 'connection_detail_forbidden', `${key}: the refusal must name the rule`)
    assert.ok(error.message.includes('managed binding'), `${key}: the message states why`)
  }
}

// §6.1 fixes these three. They are spelled out in the file rather than defaulted, so a reviewer
// reading a registration sees the constraint it operates under instead of having to know it.
function theFixedFieldsAreFixed() {
  assertConfigThrow([registration({ forbidReuse: false })], 'a B2a registration may not be written reusable')
  assertConfigThrow([registration({ forbidReuse: undefined })], 'forbidReuse must be stated')
  assertConfigThrow([registration({ forbidReuse: 'true' })], 'forbidReuse must be a real boolean')
  assertConfigThrow([registration({ sourceReadOperationLimit: 2 })], 'sourceReadOperationLimit must be 1')
  assertConfigThrow([registration({ sourceReadOperationLimit: undefined })], 'sourceReadOperationLimit must be stated')

  // artifactReplayLimit defaults to 0, and in THIS cut may only be 0: a non-zero replay count needs
  // an O4 authorization reference the codebase cannot record or verify, and a number the code cannot
  // check is a field that reads like a control and is not one.
  assert.equal(build([registration({ artifactReplayLimit: undefined })]).registrations[0].artifactReplayLimit, 0)
  const replay = assertConfigThrow([registration({ artifactReplayLimit: 1 })], 'a non-zero replay limit is refused')
  assert.equal(replay.details.reason, 'artifact_replay_not_authorized')
  assertConfigThrow([registration({ artifactReplayLimit: -1 })], 'a negative replay limit is refused')
  assertConfigThrow([registration({ artifactReplayLimit: 1.5 })], 'a fractional replay limit is refused')
}

// A one-time authorization cannot afford ambiguity about whether it has been spent.
function consumptionStateAndTimestampMustAgree() {
  assertConfigThrow([registration({ consumptionState: 'consumed' })], 'consumed requires a timestamp')
  assertConfigThrow(
    [registration({ consumptionState: 'unconsumed', consumedAt: iso(T0) })],
    'unconsumed must not carry a timestamp',
  )
  assertConfigThrow(
    [registration({ consumptionState: 'consumed', consumedAt: '2026' })],
    'consumedAt must be strict ISO',
  )
  assert.ok(build([registration({ consumptionState: 'consumed', consumedAt: iso(T0 + DAY_MS) })]))
}

// THE KEY. tenant+project alone was ruled INSUFFICIENT; the binding is what tells two of a
// customer's systems apart, and neither half may be omitted.
function theSourceBindingIsMandatory() {
  assertConfigThrow([registration({ sourceBindingRef: undefined })], 'a registration must name its binding')
  assertConfigThrow([registration({ sourceSystemType: undefined })], 'a registration must name its system type')
}

// "允许读写的数据范围" with no enumeration is not a scope. There is deliberately no wildcard.
function theScopesMustEnumerate() {
  for (const [field, key] of [['projectDataScope', 'dataScopeRefs'], ['objectScope', 'sourceObjects']]) {
    assertConfigThrow([registration({ [field]: {} })], `${field} must enumerate`)
    assertConfigThrow([registration({ [field]: { [key]: [] } })], `an empty ${field} is refused`)
    assertConfigThrow([registration({ [field]: { [key]: '*' } })], `a wildcard string is not a ${field}`)
    assertConfigThrow([registration({ [field]: { [key]: ['a', ''] } })], `a blank ${field} entry is refused`)
    assertConfigThrow([registration({ [field]: { [key]: ['a', 'a'] } })], `a repeated ${field} entry is refused`)
  }
}

// ── BOUNDED TIME ─────────────────────────────────────────────────────────────

const ISO_VECTORS = Object.freeze([
  ['2026-09-01T00:00:00Z', true],
  ['2026-09-01T00:00:00.500Z', true],
  ['2026-09-01T00:00:00+08:00', true],
  ['2026-09-01T00:00:00-05:30', true],
  ['2999', false],
  ['2026-09-01', false],
  ['2026-09-01T00:00:00', false],
  ['2026-13-01T00:00:00Z', false],
  ['2026-02-30T00:00:00Z', false],
  ['2026-09-01T24:00:00Z', false],
  ['2026-09-01T00:60:00Z', false],
  ['September 1, 2026', false],
  ['', false],
])

// Strict ISO-8601 with time AND zone. `Date.parse` alone accepts "2999" and turns a bounded window
// into a millennium. The vector table is shared with the production-policy module's parser so the
// deliberate duplication of `parseStrictIsoTimestamp` cannot drift silently.
function timestampsAreStrictIsoAndAgreeWithTheProductionPolicyParser() {
  for (const [value, accepted] of ISO_VECTORS) {
    const b2a = captured(() => build([registration({ effectiveAt: '2026-08-30T00:00:00Z', expiresAt: value })]))
    assert.equal(b2a === null, accepted, `B2a expiresAt ${JSON.stringify(value)} acceptance`)

    const policy = captured(() => normalizeStockPrepApplyProductionPolicy({
      enabled: true,
      authorizedTargetObjectId: PROD_CANONICAL_OBJECT_ID,
      authorizationId: 'auth-1',
      allowedActionId: PLM_STOCK_PREPARATION_ACTION_ID,
      allowedRoute: 'small',
      maxCleanRows: 1,
      expiresAt: value,
      requireFreshDryRun: true,
    }))
    assert.equal(policy === null, accepted, `production-policy expiresAt ${JSON.stringify(value)} acceptance`)
  }
  assertConfigThrow([registration({ effectiveAt: '2026' })], 'effectiveAt must be strict ISO')
}

function theWindowIsBounded() {
  assert.equal(MAX_B2A_REGISTRATION_WINDOW_MS, 180 * DAY_MS)
  assert.notEqual(build([registration({ effectiveAt: iso(T0), expiresAt: iso(T0 + MAX_B2A_REGISTRATION_WINDOW_MS) })]), null)
  assertConfigThrow(
    [registration({ effectiveAt: iso(T0), expiresAt: iso(T0 + MAX_B2A_REGISTRATION_WINDOW_MS + 1) })],
    'a window longer than the bounded exception window is refused',
  )
  assertConfigThrow([registration({ effectiveAt: iso(T0), expiresAt: '2999-01-01T00:00:00Z' })], 'a millennium is not a window')
  assertConfigThrow([registration({ effectiveAt: iso(T0), expiresAt: iso(T0) })], 'expiresAt must be after effectiveAt')
  assertConfigThrow([registration({ effectiveAt: iso(T0 + DAY_MS), expiresAt: iso(T0) })], 'a reversed window is refused')
}

// ── R-01: missing / not-yet-effective / expired / revoked / consumed ─────────

async function R01_registrationLifecycleRefusals() {
  // MISSING — armed, and nothing in it covers this tenant.
  await assertRefusal(build([registration({ tenantScope: OTHER_TENANT })]), {},
    B2A_REGISTRATION_REQUIRED, 'no_registration', 'R-01 unregistered tenant')

  // The module holds no clock: wall-clock expiry is a CHECK-time decision, deliberately (an
  // activation that depended on the time of day would take the whole plugin down at midnight).
  // An already-expired registration LOADS and then refuses every single call.
  const expired = build([registration({ effectiveAt: iso(T0), expiresAt: iso(T0 + DAY_MS) })])
  assert.notEqual(expired, null, 'a well-formed but expired registration LOADS')
  const expiredError = await assertRefusal(expired, {}, B2A_REGISTRATION_REQUIRED, 'expired', 'R-01 expired')
  assert.equal(expiredError.details.notExpired, false)
  assert.equal(expiredError.details.expiryHandling, 'deny_replay', 'the refusal states the disposition rule')

  // Boundaries: exclusive at the top, inclusive at the bottom.
  await assertRefusal(build([registration({ effectiveAt: iso(T0), expiresAt: iso(NOW) })]), {},
    B2A_REGISTRATION_REQUIRED, 'expired', 'R-01 expiry is exclusive at the top')
  assert.ok(await check(build([registration({ effectiveAt: iso(T0), expiresAt: iso(NOW + 1) })])), 'one ms before expiry passes')
  assert.ok(await check(build([registration({ effectiveAt: iso(NOW), expiresAt: iso(NOW + DAY_MS) })])), 'effectiveAt is inclusive')

  const early = await assertRefusal(
    build([registration({ effectiveAt: iso(NOW + 1), expiresAt: iso(NOW + DAY_MS) })]), {},
    B2A_REGISTRATION_REQUIRED, 'not_yet_effective', 'R-01 not yet effective')
  assert.equal(early.details.effective, false)

  // REVOKED.
  await assertRefusal(build([registration({ status: 'revoked' })]), {},
    B2A_REGISTRATION_REQUIRED, 'revoked', 'R-01 revoked')

  // CONSUMED, as recorded in the file.
  await assertRefusal(build([registration({ consumptionState: 'consumed', consumedAt: iso(T0 + DAY_MS) })]), {},
    B2A_AUTHORIZATION_INVALID, 'already_consumed', 'R-01 already consumed')

  // No clock, no decision. Fail-closed rather than defaulting to "now".
  for (const bad of [undefined, NaN, '1754000000000']) {
    await assertRefusal(build([registration()]), { now: bad },
      B2A_AUTHORIZATION_INVALID, 'missing_now', `R-01 clock ${String(bad)} refuses`)
  }
  // No Run identity, no one-operation limit.
  await assertRefusal(build([registration()]), { runId: undefined },
    B2A_AUTHORIZATION_INVALID, 'missing_run_id', 'R-01 missing run id')
  // No durable store, no one-time authorization. Fail-closed rather than an unlimited read.
  for (const bad of [undefined, null, {}, { get() {} }]) {
    await assertRefusal(build([registration()]), { store: bad },
      B2A_AUTHORIZATION_INVALID, 'claim_store_unavailable', 'R-01 no claim store')
  }
}

// ── R-02: source / data-scope / object / purpose out of bounds ───────────────

async function R02_scopeRefusals() {
  const registry = build([registration()])

  // THE R-09 DIMENSION: the SAME customer's OTHER system. Tenant matches, data scope matches, and
  // the registration names a different binding.
  await assertRefusal(registry, { sourceBindingRef: K3_SYSTEM },
    B2A_REGISTRATION_REQUIRED, 'no_registration', 'R-02 the customer\'s OTHER system')
  await assertRefusal(registry, { sourceSystemType: OTHER_SYSTEM_TYPE },
    B2A_REGISTRATION_REQUIRED, 'no_registration', 'R-02 a repointed adapter kind')
  await assertRefusal(registry, { tenantScope: OTHER_TENANT },
    B2A_REGISTRATION_REQUIRED, 'no_registration', 'R-02 another tenant')

  await assertRefusal(registry, { dataScopeRef: OUT_OF_SCOPE_PROJECT },
    B2A_SCOPE_MISMATCH, 'data_scope_mismatch', 'R-02 data scope out of bounds')

  // THE WIDENED QUERY. The read reaches one table the registration did not enumerate.
  const widened = await assertRefusal(registry, { sourceObjects: [OBJECT_A, UNLISTED_OBJECT] },
    B2A_SCOPE_MISMATCH, 'object_out_of_scope', 'R-02 widened object set')
  assert.equal(widened.details.unauthorizedObjectCount, 1, 'the COUNT is reported, never the name')
  assert.equal(widened.details.objectInScope, false)
  // A subset of the enumerated objects is fine; the scope is a ceiling, not an exact match.
  assert.ok(await check(registry, { sourceObjects: [OBJECT_A, OBJECT_B] }))

  await assertRefusal(registry, { purpose: B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST },
    B2A_SCOPE_MISMATCH, 'purpose_not_permitted', 'R-02 another consumer')

  // An under-specified call refuses, per dimension, with booleans only.
  for (const [field, flag] of [
    ['tenantScope', 'tenantResolved'],
    ['sourceSystemType', 'sourceSystemTypeResolved'],
    ['sourceBindingRef', 'sourceBindingResolved'],
    ['dataScopeRef', 'dataScopeResolved'],
  ]) {
    const error = await assertRefusal(registry, { [field]: undefined },
      B2A_SCOPE_MISMATCH, 'missing_scope', `R-02 missing ${field}`)
    assert.equal(error.details[flag], false, `${flag} is reported as unresolved`)
    await assertRefusal(registry, { [field]: '   ' }, B2A_SCOPE_MISMATCH, 'missing_scope', `R-02 blank ${field}`)
  }
  const noObjects = await assertRefusal(registry, { sourceObjects: [] },
    B2A_SCOPE_MISMATCH, 'missing_scope', 'R-02 no source objects')
  assert.equal(noObjects.details.objectCount, 0)

  // A tenant with TWO registered systems gets a registration per system, and neither authorizes the
  // other — the case that motivated the key.
  const two = build([
    registration({ registrationId: 'b2a-plm', operationRef: 'op-plm', sourceBindingRef: PLM_SYSTEM }),
    registration({
      registrationId: 'b2a-k3',
      operationRef: 'op-k3',
      sourceBindingRef: K3_SYSTEM,
      projectDataScope: { dataScopeRefs: ['P-777'] },
    }),
  ])
  assert.equal((await check(two)).registrationId, 'b2a-plm')
  assert.equal((await check(two, { sourceBindingRef: K3_SYSTEM, dataScopeRef: 'P-777' })).registrationId, 'b2a-k3')
  await assertRefusal(two, { sourceBindingRef: K3_SYSTEM },
    B2A_SCOPE_MISMATCH, 'data_scope_mismatch', 'R-02 scope does not cross bindings')

  // `no_registration` cannot name a registration it did not find.
  const notFound = await capturedAsync(check(registry, { tenantScope: OTHER_TENANT }))
  assert.equal('registrationIds' in notFound.details, false)
}

// UNKNOWN ENTRY POINTS DEFAULT-REFUSE. Unreachable from a request (purposes are module constants at
// every call site); it fires when a NEW read path is added without being inventoried.
async function unknownEntryPointsDefaultRefuse() {
  assert.deepEqual([...B2A_PURPOSES], [
    B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
    B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
    B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN,
    B2A_PURPOSE_PIPELINE_RUNNER_READ,
    B2A_PURPOSE_SEALED_SNAPSHOT_SQLSERVER,
  ])
  const registry = build([registration()])
  for (const bad of ['some.new.read.path', undefined, '', 'STOCK-PREPARATION.TABLE-ACTION']) {
    await assertRefusal(registry, { purpose: bad },
      B2A_REGISTRATION_REQUIRED, 'unknown_entry_point', `an undeclared call site (${String(bad)}) is refused`)
  }
  // …and a registration cannot name one either, so the vocabulary has exactly one authority.
  assertConfigThrow([registration({ purpose: 'some.new.read.path' })], 'an unrecognized purpose is refused at load')
}

// ── R-03: the operation claim ────────────────────────────────────────────────

async function R03_oneRegistrationIsOneSourceReadOperation() {
  const shared = store()
  const registry = build([registration()])

  const first = await check(registry, { store: shared })
  assert.equal(first.operationClaimed, true, 'the first guarded read CLAIMS the operation')
  assert.equal(first.operationContinued, false)
  assert.equal(first.pageReads, 1)
  assert.equal(first.sourceReadOperationLimit, 1)

  // SAME RUN -> allowed. Bounded paging inside one operation, and a path that legitimately re-enters
  // the guard for the same Run (the large-BOM job, whose runId is its job id) continues on its claim.
  const continued = await check(registry, { store: shared })
  assert.equal(continued.operationClaimed, false)
  assert.equal(continued.operationContinued, true, 'the same Run continues on the claim it holds')
  assert.equal(continued.pageReads, 2, 're-entries are counted so evidence can show the read stayed bounded')

  // ANOTHER RUN -> refused. A new source-read Run needs a new operation.
  const reused = await assertRefusal(registry, { store: shared, runId: 'run-b' },
    B2A_AUTHORIZATION_INVALID, 'operation_already_consumed', 'R-03 a second Run is refused')
  assert.equal(reused.details.sourceReadOperationLimit, 1)

  // A SECOND registration with its own operation authorizes the second Run — which is the shape a
  // deployment must write, and a visible edit to a reviewed file.
  const twoOps = build([
    registration({ registrationId: 'b2a-op-1', operationRef: 'op-1' }),
    registration({ registrationId: 'b2a-op-2', operationRef: 'op-2' }),
  ])
  const fresh = store()
  assert.equal((await check(twoOps, { store: fresh, runId: 'run-x' })).operationClaimed, true)
  const second = await check(twoOps, { store: fresh, runId: 'run-y' })
  assert.equal(second.operationClaimed, true, 'the sibling operation is still available')
  // …and a THIRD run finds both spent.
  await assertRefusal(twoOps, { store: fresh, runId: 'run-z' },
    B2A_AUTHORIZATION_INVALID, 'operation_already_consumed', 'R-03 both operations spent')
}

// ── R-04: concurrent duplicates, version downgrade, cross-app reuse ──────────

async function R04_uniquenessVersionAndReuse() {
  // DUPLICATE REGISTRATION, load-time half: two ACTIVE registrations for the same tenant, binding,
  // scope, purpose and operation.
  const dupId = assertConfigThrow([registration(), registration({ operationRef: 'op-other' })],
    'a duplicate registrationId is refused')
  assert.equal(dupId.details.reason, 'duplicate_registration_id')
  const dupKey = assertConfigThrow([registration(), registration({ registrationId: 'b2a-second' })],
    'two active registrations for the same key are refused')
  assert.equal(dupKey.details.reason, 'duplicate_active_registration')
  // Superseding by REVOKING and writing a replacement stays possible — a revoked record is history.
  assert.ok(build([
    registration({ registrationId: 'b2a-old', status: 'revoked' }),
    registration({ registrationId: 'b2a-new' }),
  ]), 'a revoked predecessor does not collide with its replacement')

  // VERSION DOWNGRADE. Rewinding `registrationVersion` is how a spent or narrowed authorization
  // would be resurrected by editing the file back to an older, wider revision; the file alone cannot
  // detect it, because each load sees only what it was given.
  const shared = store()
  const v2 = build([registration({ registrationVersion: 2 })])
  assert.equal((await check(v2, { store: shared })).registrationVersion, 2)
  const v1 = build([registration({ registrationVersion: 1 })])
  await assertRefusal(v1, { store: shared, runId: 'run-later' },
    B2A_AUTHORIZATION_INVALID, 'registration_version_downgrade', 'R-04 version downgrade')
  // The SAME version is NOT a downgrade. Presenting it again still refuses — but for the OPERATION
  // reason, not the version one, which is the distinction being pinned: the version guard fires on a
  // rewind, not on ordinary re-presentation of the revision in force.
  await assertRefusal(build([registration({ registrationVersion: 2 })]), { store: shared, runId: 'run-same-v' },
    B2A_AUTHORIZATION_INVALID, 'operation_already_consumed', 'R-04 equal version is not a downgrade')

  // CROSS-APPLICATION REUSE. `purpose` is the identity of a CALL SITE, so a different read path
  // reaching for the same binding is refused although tenant, binding and scope all match.
  const locked = build([registration()])
  for (const other of B2A_PURPOSES.filter((p) => p !== B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION)) {
    const error = await assertRefusal(locked, { purpose: other },
      B2A_SCOPE_MISMATCH, 'purpose_not_permitted', `R-04 reuse by ${other}`)
    assert.equal(error.details.forbidReuse, true, 'the refusal says WHY it refused')
  }

  // The explicit, reviewable opposite: a per-consumer registration set. This module cannot and does
  // not claim to stop a human writing that second registration — the file is a review control — only
  // to make it a visible edit.
  const perPurpose = build([
    registration({ registrationId: 'b2a-refresh', operationRef: 'op-refresh' }),
    registration({
      registrationId: 'b2a-large-bom',
      operationRef: 'op-large-bom',
      purpose: B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
    }),
  ])
  const fresh = store()
  assert.equal((await check(perPurpose, { store: fresh })).registrationId, 'b2a-refresh')
  assert.equal(
    (await check(perPurpose, { store: fresh, purpose: B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM, runId: 'run-lb' })).registrationId,
    'b2a-large-bom',
  )
  await assertRefusal(perPurpose, { store: fresh, purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ },
    B2A_SCOPE_MISMATCH, 'purpose_not_permitted', 'R-04 the third consumer is still refused')
}

// ── THE PASS STANZA ──────────────────────────────────────────────────────────

async function aMatchingRegistrationPasses() {
  const stanza = await check(build([registration()]))
  assert.deepEqual(stanza, {
    armed: true,
    registryId: 'b2a-2026-q3',
    registryVersion: 1,
    registrationId: 'b2a-factory-a-plm',
    registrationVersion: 1,
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    sourceBindingMatched: true,
    dataScopeInScope: true,
    objectInScope: true,
    objectCount: 1,
    effective: true,
    notExpired: true,
    forbidReuse: true,
    sourceReadOperationLimit: 1,
    artifactReplayLimit: 0,
    expiryHandling: 'deny_replay',
    operationClaimed: true,
    operationContinued: false,
    pageReads: 1,
  })
  assert.ok(Object.isFrozen(stanza), 'the stanza is frozen')
  // VALUES-FREE on the PASS path too.
  const text = JSON.stringify(stanza)
  for (const forbidden of FORBIDDEN_IN_EVIDENCE) {
    assert.equal(text.includes(forbidden), false, `pass stanza leaked ${JSON.stringify(forbidden)}`)
  }
}

// When several live registrations authorize the same call, evidence must name the NARROWEST
// authorization in force — deterministically, so the stanza is reproducible.
async function theSoonestExpiringLiveRegistrationWins() {
  const make = (id, op, expiresAt) => registration({ registrationId: id, operationRef: op, expiresAt })
  const registry = build([
    make('b2a-long', 'op-long', iso(T0 + 90 * DAY_MS)),
    make('b2a-short', 'op-short', iso(T0 + 30 * DAY_MS)),
  ])
  assert.equal((await check(registry)).registrationId, 'b2a-short')
  const reversed = build([
    make('b2a-short', 'op-short', iso(T0 + 30 * DAY_MS)),
    make('b2a-long', 'op-long', iso(T0 + 90 * DAY_MS)),
  ])
  assert.equal((await check(reversed)).registrationId, 'b2a-short', 'stable under input order')

  // An EXPIRED sibling does not poison the live one.
  const mixed = build([
    make('b2a-stale', 'op-stale', iso(T0 + DAY_MS)),
    make('b2a-live', 'op-live', iso(T0 + 60 * DAY_MS)),
  ])
  assert.equal((await check(mixed)).registrationId, 'b2a-live')
}

// A caller reaching the guard with something that is not a built registry must never fall through to
// "allow". It is not a refusable caller either — it is a wiring bug.
async function aMalformedRegistryAtCheckTimeIsFailClosed() {
  for (const bogus of [{}, { registryId: 'r' }, { registrations: [] }, 'registry', 7, true, []]) {
    const error = await capturedAsync(assertB2aReadAuthorization({
      registry: bogus, store: store(), tenantScope: TENANT, dataScopeRef: IN_SCOPE_PROJECT, now: NOW,
    }))
    assert.ok(error, `${JSON.stringify(bogus)} must not be accepted as a registry`)
    assert.equal(error.code, B2A_REGISTRY_INVALID)
    assert.equal(error.status, 500)
  }
}

async function theBuiltRegistryIsImmutable() {
  const registry = build([registration()])
  assert.ok(Object.isFrozen(registry))
  assert.ok(Object.isFrozen(registry.registrations))
  assert.ok(Object.isFrozen(registry.registrations[0]))
  assert.ok(Object.isFrozen(registry.registrations[0].projectDataScope.dataScopeRefs))
  assert.ok(Object.isFrozen(registry.registrations[0].objectScope.sourceObjects))
  try { registry.registrations[0].objectScope.sourceObjects.push(UNLISTED_OBJECT) } catch { /* frozen */ }
  await assertRefusal(registry, { sourceObjects: [UNLISTED_OBJECT] },
    B2A_SCOPE_MISMATCH, 'object_out_of_scope', 'a frozen scope cannot be widened in place')

  // The registry does not alias the caller's config object: mutating the source after the build must
  // not change what the guard enforces.
  const config = { [B2A_REGISTRY_CONFIG_KEY]: registryConfig([registration()]) }
  const built = createB2aRegistry({ config })
  config[B2A_REGISTRY_CONFIG_KEY].registrations[0].projectDataScope.dataScopeRefs.push(OUT_OF_SCOPE_PROJECT)
  await assertRefusal(built, { dataScopeRef: OUT_OF_SCOPE_PROJECT },
    B2A_SCOPE_MISMATCH, 'data_scope_mismatch', 'a post-build config mutation does not reach the guard')
}

// The object list handed to the guard comes from the READ PLAN ITSELF, which is what makes
// `objectScope` an enforceable ceiling rather than a label.
function theReadPlanNamesItsOwnObjects() {
  const objects = readPlanSourceObjects(PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  // Read off the shipped plan rather than restated, so a plan that grows a section shows up here.
  const expected = [
    'DN_PDM_BomDetailsInfo', 'DN_PDM_BomHeadInfo', 'DN_PDM_OrderDetailInfo', 'DN_PDM_OrderHeadInfo',
    'DN_PDM_PartLibraryInfo', 'DN_PDM_PathExAttrInfo', 'DN_PDM_PathInfo',
  ]
  assert.deepEqual([...objects], expected, 'every object the expansion queries is enumerated')
  assert.ok(Object.isFrozen(objects))
  // Sorted and de-duplicated, so the list does not depend on key order.
  assert.deepEqual(readPlanSourceObjects({ b: { object: 'B' }, a: { object: 'A' }, c: { object: 'A' } }), ['A', 'B'])
  // Degenerate inputs yield an EMPTY list, which the guard treats as `missing_scope` — a refusal,
  // never a pass.
  for (const bad of [undefined, null, 'plan', 42, {}, []]) {
    assert.deepEqual(readPlanSourceObjects(bad), [], `${JSON.stringify(bad)} yields no objects`)
  }
  // Nested and array-shaped plans are walked.
  assert.deepEqual(readPlanSourceObjects({ steps: [{ object: 'X' }, { nested: { object: 'Y' } }] }), ['X', 'Y'])
}

const TESTS = [
  dormantWhenTheKeyIsAbsent,
  switchingItOffFromInsideTheFileIsRefused,
  registryEnvelopeIsValidated,
  everyRegisteredFieldIsRequired,
  connectionDetailIsRefusedByName,
  theFixedFieldsAreFixed,
  consumptionStateAndTimestampMustAgree,
  theSourceBindingIsMandatory,
  theScopesMustEnumerate,
  timestampsAreStrictIsoAndAgreeWithTheProductionPolicyParser,
  theWindowIsBounded,
  R01_registrationLifecycleRefusals,
  R02_scopeRefusals,
  unknownEntryPointsDefaultRefuse,
  R03_oneRegistrationIsOneSourceReadOperation,
  R04_uniquenessVersionAndReuse,
  aMatchingRegistrationPasses,
  theSoonestExpiringLiveRegistrationWins,
  aMalformedRegistryAtCheckTimeIsFailClosed,
  theBuiltRegistryIsImmutable,
  theReadPlanNamesItsOwnObjects,
]

async function main() {
  for (const test of TESTS) {
    await test()
    process.stdout.write(`  ${test.name} OK\n`)
  }
  process.stdout.write('b2a-trial-registry.test.cjs OK\n')
}

main().catch((error) => {
  process.exitCode = 1
  throw error
})
