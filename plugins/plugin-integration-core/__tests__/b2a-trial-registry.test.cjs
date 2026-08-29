'use strict'

// THE B2a REGISTRATION CONTRACT — normalization at load, and the guard decision at check.
//
// This suite pins what the registry DECIDES. b2a-trial-registry-wiring.test.cjs pins the only thing
// that makes any of it matter: that the four inventoried read entry points reach it, and that a
// refusal happens before a single source row is read.
//
// Case ids follow the acceptance matrix (R-01 … R-06, plus the unit halves of E3-02 and E3-05) so
// the verification record maps 1:1. R-08 (expiry disposition of value-bearing artifacts) is NOT
// covered here and is NOT claimed — see the gap list in the change description.
//
// Hermetic: no DB, no network, no wall clock (every check is handed an explicit `now`, the kv
// projection is an in-memory Map, and the DB-enforced operation claim of migration 078 runs against
// a fake of the SCOPED SQL helper whose insertOne enforces the PRIMARY KEY the way Postgres does).
// The one filesystem read is M78, which asserts the migration text itself. Values-free: the only
// literals are synthetic ids, frozen reason tokens and ISO timestamps this file authors itself.
//
// Additional cases landed with migration 078:
//   R-03b two CONCURRENT claimers of one operation -> exactly one wins, the loser gets the fixed
//         refusal code and never reaches a source read; same-Run repagination still continues
//   M78   migration 078 defines the DB-level claim uniqueness the module leans on

const assert = require('node:assert/strict')
const fs = require('node:fs')
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
  C6_FULL_BATCH_INCOMPLETE,
  B2A_REGISTRY_INVALID,
  B2A_SOURCE_TIMEOUT_DISABLED_REJECTED,
  DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CAUSE_CODE,
  isDataSourceRequestTimeoutDisabledError,
  refuseB2aArmedSqlServerRequestTimeoutDisabled,
  B2A_EXPIRY_HANDLINGS,
  MAX_B2A_REGISTRATION_WINDOW_MS,
  B2A_TIMEOUT_CAUSE_CLASSES,
  B2A_PAGE_LIMIT_CAUSE_CLASSES,
  B2A_INCOMPLETE_BATCH_CAUSE_CLASSES,
  B2A_SCHEMA_CONTRACT_VERSION,
  SCHEMA_CONTRACT_KEY_PREFIX,
  B2aReadAuthorizationError,
  assertB2aReadAuthorization,
  assertB2aFullBatchComplete,
  assertB2aSchemaContract,
  assertB2aSourceUnchangedAfterRead,
  b2aSourceReadCauseClass,
  classifyB2aSourceReadCause,
  mapB2aSourceReadError,
  runB2aGuardedSourceRead,
  createB2aRegistry,
  createB2aOperationClaim,
  B2A_OPERATION_CLAIM_TABLE,
  readPlanSourceObjects,
  resolveB2aRegistryConfig,
} = require(path.join(LIB, 'b2a-trial-registry.cjs'))

const MODULE_PATH = path.join(LIB, 'b2a-trial-registry.cjs')
const MIGRATION_078_PATH = path.join(
  __dirname, '..', '..', '..', 'packages', 'core-backend', 'migrations',
  '078_create_integration_b2a_operation_claim.sql',
)

// The literal core-backend's read-only facade exports as `DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE`
// (packages/core-backend/src/data-adapters/data-source-plugin-facade.ts). Restated as a literal
// rather than imported — this is a plain node .cjs test and that module is TypeScript — matching this
// file's own `parseStrictIsoTimestamp`/production-policy cross-check precedent: the two are pinned
// against each other BY VALUE so neither can drift silently apart, without a cross-package TS import.
const DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE = 'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED'

const {
  PROD_CANONICAL_OBJECT_ID,
  normalizeStockPrepApplyProductionPolicy,
} = require(path.join(LIB, 'stock-preparation-production-policy.cjs'))

const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  INCOMPLETE_READ_ERROR_TYPES,
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
  'C6_FULL_BATCH_INCOMPLETE',
  'B2A_SOURCE_TIMEOUT_DISABLED_REJECTED',
])
assert.equal(B2A_REGISTRATION_REQUIRED, 'B2A_REGISTRATION_REQUIRED')
assert.equal(B2A_AUTHORIZATION_INVALID, 'B2A_AUTHORIZATION_INVALID')
assert.equal(B2A_SCOPE_MISMATCH, 'B2A_SCOPE_MISMATCH')
assert.equal(B2A_SOURCE_TIMEOUT, 'B2A_SOURCE_TIMEOUT')
assert.equal(B2A_PAGE_LIMIT_EXCEEDED, 'B2A_PAGE_LIMIT_EXCEEDED')
assert.equal(B2A_SCHEMA_DRIFT, 'B2A_SCHEMA_DRIFT')
assert.equal(C6_SAFE_LIFECYCLE_REQUIRED, 'C6_SAFE_LIFECYCLE_REQUIRED')
assert.equal(C6_FULL_BATCH_INCOMPLETE, 'C6_FULL_BATCH_INCOMPLETE')
assert.equal(B2A_SOURCE_TIMEOUT_DISABLED_REJECTED, 'B2A_SOURCE_TIMEOUT_DISABLED_REJECTED')
assert.equal(DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CAUSE_CODE, DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE)

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

// A fake of the SCOPED SQL helper with genuine single-statement atomicity, lifted from the A-04
// harness in stock-preparation-confirmation-decisions.test.cjs: each method is synchronous inside
// (no awaits — exactly like one SQL statement), and insertOne enforces the PRIMARY KEY on claim_key
// the way Postgres does. This is the "database" concurrent claimers race at.
function makeFakeClaimDb() {
  const rows = new Map()
  function assertClaimTable(table) {
    assert.equal(table, B2A_OPERATION_CLAIM_TABLE, `the claim must only touch ${B2A_OPERATION_CLAIM_TABLE}, saw ${table}`)
  }
  return {
    rows,
    async insertOne(table, row) {
      assertClaimTable(table)
      if (rows.has(row.claim_key)) {
        const error = new Error(`duplicate key value violates unique constraint "${table}_pkey"`)
        error.code = '23505'
        throw error
      }
      rows.set(row.claim_key, { ...row })
      return [{ ...row }]
    },
    async selectOne(table, where) {
      assertClaimTable(table)
      const row = rows.get(where.claim_key)
      return row ? { ...row } : null
    },
  }
}

// The claim table's lifetime tracks the kv store's, so every existing case that shares one `store()`
// across calls keeps sharing ONE claim database too — the substrate split in two, not the test
// semantics. A caller may still pass its own `operationClaim` to drive a race explicitly.
const CLAIM_BY_STORE = new WeakMap()
function claimFor(kvStore) {
  if (!CLAIM_BY_STORE.has(kvStore)) {
    CLAIM_BY_STORE.set(kvStore, createB2aOperationClaim({ db: makeFakeClaimDb() }))
  }
  return CLAIM_BY_STORE.get(kvStore)
}

function check(registry, overrides = {}) {
  const kvStore = overrides.store || store()
  return assertB2aReadAuthorization({
    registry,
    store: kvStore,
    operationClaim: claimFor(kvStore),
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
  // Migration 078. ARMED + no DB-enforced claim -> REFUSE. There is deliberately no fallback to the
  // kv-only read-then-write path: an unreachable database is not a reason to widen a one-time
  // authorization, and a silent degrade is exactly what this migration removed.
  for (const bad of [undefined, null, {}, { claim: 'not-a-function' }]) {
    await assertRefusal(build([registration()]), { operationClaim: bad },
      B2A_AUTHORIZATION_INVALID, 'operation_claim_unavailable', 'R-01 no DB-enforced operation claim')
  }
  // …and the factory itself refuses a db that cannot do the two statements the protocol needs, at
  // BUILD time, so a miswired activation fails loudly instead of at the first armed read.
  for (const bad of [undefined, null, {}, { insertOne() {} }, { selectOne() {} }]) {
    assert.throws(() => createB2aOperationClaim({ db: bad }), /scoped db helper/,
      `R-01 createB2aOperationClaim refuses db ${JSON.stringify(bad) || String(bad)}`)
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

// ── R-03b: TWO CONCURRENT CLAIMERS -> exactly ONE wins (migration 078) ───────
//
// The case R-03 above could not make: not "a second Run afterwards", but two Runs racing for the
// SAME operation with no ordering between them. Before migration 078 the claim was get -> set ->
// read back over a kv `set` that is an unconditional upsert, so two writers interleaving between the
// read-back and the set could both conclude they won — the module's own header said so. The decision
// is now a plain INSERT whose claim_key is a PRIMARY KEY, and the database picks the winner.

function loadIsolatedRegistryModule() {
  const resolved = require.resolve(MODULE_PATH)
  const cached = require.cache[resolved]
  delete require.cache[resolved]
  // eslint-disable-next-line global-require
  const fresh = require(MODULE_PATH)
  delete require.cache[resolved]
  if (cached) require.cache[resolved] = cached
  return fresh
}

async function R03b_twoConcurrentClaimersYieldExactlyOneWinner() {
  // ONE shared substrate: one claim database and one kv projection, exactly as two processes of the
  // same deployment would see. The INSERT parks on a gate so both claimers are genuinely in flight
  // at the same moment; everything after the gate is synchronous, which is what makes each INSERT
  // one statement.
  const sharedDb = makeFakeClaimDb()
  const rawInsert = sharedDb.insertOne
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  let gatedInserts = 0
  sharedDb.insertOne = async function gatedInsertOne(table, row) {
    gatedInserts += 1
    if (gatedInserts <= 2) await gate
    return rawInsert.call(sharedDb, table, row)
  }
  const sharedStore = store()

  // Two INDEPENDENT module instances (fresh require, no shared JS state — the in-model equivalent of
  // two processes) presenting the SAME registration for two DIFFERENT Runs.
  const moduleA = loadIsolatedRegistryModule()
  const moduleB = loadIsolatedRegistryModule()
  assert.notEqual(moduleA, moduleB, 'the two claimers share no module state')

  const guardInput = (mod, runId) => ({
    registry: mod.createB2aRegistry({ config: { [B2A_REGISTRY_CONFIG_KEY]: registryConfig([registration()]) } }),
    store: sharedStore,
    operationClaim: mod.createB2aOperationClaim({ db: sharedDb }),
    tenantScope: TENANT,
    sourceSystemType: SYSTEM_TYPE,
    sourceBindingRef: PLM_SYSTEM,
    dataScopeRef: IN_SCOPE_PROJECT,
    sourceObjects: [OBJECT_A],
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    runId,
    now: NOW,
  })

  const attemptA = moduleA.assertB2aReadAuthorization(guardInput(moduleA, 'run-race-a'))
  const attemptB = moduleB.assertB2aReadAuthorization(guardInput(moduleB, 'run-race-b'))
  // Attach the settle handlers FIRST (the loser rejecting while the gate is shut must not surface as
  // an unhandled rejection), let both attempts reach the INSERT, then open the gate.
  const settledPromise = Promise.allSettled([attemptA, attemptB])
  await new Promise((resolve) => setTimeout(resolve, 25))
  releaseGate()
  const settled = await settledPromise

  // THE acceptance criterion first: whatever the two attempts reported, the database holds exactly
  // one claim on this operation.
  assert.equal(sharedDb.rows.size, 1, 'R-03b: the claim table ends with exactly ONE row')

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled')
  const rejected = settled.filter((entry) => entry.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'R-03b: exactly one claimer wins')
  assert.equal(rejected.length, 1, 'R-03b: exactly one claimer loses')
  assert.equal(fulfilled[0].value.operationClaimed, true, 'the winner CLAIMED the operation')
  assert.equal(fulfilled[0].value.operationContinued, false)
  assert.equal(fulfilled[0].value.pageReads, 1)
  assert.equal(rejected[0].reason.code, B2A_AUTHORIZATION_INVALID, 'R-03b: the loser gets the fixed code')
  assert.equal(rejected[0].reason.status, 403)
  assert.equal(rejected[0].reason.details.reason, 'operation_already_consumed', 'R-03b: the loser gets the fixed reason')
  assert.equal(rejected[0].reason.details.sourceReadOperationLimit, 1)

  // The winner's OWN Run may keep paging: same-Run re-entry continues on the claim it holds, which
  // is the property the one-shot limit must not break.
  const [winnerRow] = [...sharedDb.rows.values()]
  const winnerRunId = winnerRow.run_id
  assert.ok(['run-race-a', 'run-race-b'].includes(winnerRunId), 'the stored holder is one of the two racers')
  const winnerModule = winnerRunId === 'run-race-a' ? moduleA : moduleB
  const continued = await winnerModule.assertB2aReadAuthorization(guardInput(winnerModule, winnerRunId))
  assert.equal(continued.operationClaimed, false)
  assert.equal(continued.operationContinued, true, 'R-03b: the holder continues on its own claim')
  assert.equal(continued.pageReads, 2, 're-entries are still counted for evidence')
  assert.equal(sharedDb.rows.size, 1, 'a continuation writes no second claim row')

  // NEGATIVE CONTROL: the single winner is produced by the DB-enforced claim, not by the harness. A
  // claim that always says "held" lets BOTH concurrent Runs through — which is precisely the state
  // this migration removed, restated as a test rather than as prose.
  const permissive = { async claim() { return { held: true, claimed: true, holderRunId: null } } }
  const both = await Promise.allSettled([
    moduleA.assertB2aReadAuthorization({ ...guardInput(moduleA, 'run-permissive-a'), store: store(), operationClaim: permissive }),
    moduleB.assertB2aReadAuthorization({ ...guardInput(moduleB, 'run-permissive-b'), store: store(), operationClaim: permissive }),
  ])
  assert.deepEqual(both.map((entry) => entry.status), ['fulfilled', 'fulfilled'],
    'R-03b control: without the DB-enforced claim both concurrent Runs are authorized')
}

// ── M78: the DB-level claim the module leans on is real ─────────────────────

async function M78_migration078DefinesTheDbLevelOperationClaim() {
  const sql = fs.readFileSync(MIGRATION_078_PATH, 'utf8')
  assert.ok(
    sql.includes(`CREATE TABLE IF NOT EXISTS ${B2A_OPERATION_CLAIM_TABLE}`),
    'migration 078 must create the claim table the module names',
  )
  const block = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${B2A_OPERATION_CLAIM_TABLE} \\(([\\s\\S]*?)\\n\\);`, 'm'))
  assert.ok(block, 'claim table block must parse')
  // THE one-shot guarantee: claim_key is the PRIMARY KEY (DB-level unique). Everything else is
  // evidence, and must be NOT NULL so a claim can never be half-written.
  assert.match(block[1], /claim_key TEXT PRIMARY KEY/, 'claim_key must be the PRIMARY KEY — this IS the DB-level uniqueness')
  assert.match(block[1], /registration_id TEXT NOT NULL/, 'registration_id must exist')
  assert.match(block[1], /registration_version INTEGER NOT NULL/, 'registration_version must exist')
  assert.match(block[1], /operation_digest TEXT NOT NULL/, 'operation_digest (the hashed operation identity) must exist')
  assert.match(block[1], /run_id TEXT NOT NULL/, 'run_id (the holder identity the same-run check reads) must exist')
  assert.match(block[1], /claimed_at TIMESTAMPTZ NOT NULL/, 'claimed_at must exist')
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')
  // A CLAIM IS PERMANENT — the whole difference from the 077 lease. No TTL column, and nothing here
  // hands the runtime a way to expire or steal one.
  assert.doesNotMatch(block[1], /expires_at/i, 'an operation claim must not carry an expiry — a renewable one-shot is not a one-shot')

  // …and the module never UPDATEs, DELETEs or UPSERTs a claim either: the two statements the
  // protocol uses are exactly insertOne + selectOne, which is why the factory demands only those
  // two. An upsert here would be the original defect wearing a new name.
  const moduleSource = fs.readFileSync(MODULE_PATH, 'utf8')
  for (const forbidden of ['updateRow', 'deleteRows', 'upsertOne']) {
    assert.ok(
      !moduleSource.includes(`db.${forbidden}(`),
      `the claim protocol must not ${forbidden} — claims are permanent`,
    )
  }
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

// ── R-05: THE CAUSE-CLASS ROSTERS ARE THE WHOLE CONTRACT ─────────────────────

// Each roster restated as a literal. Importing the constant and comparing it to itself passes just
// as happily when a token is misspelled and the class it was meant to catch falls through unmapped.
async function R05_theCauseClassRostersAreClosedAndRestated() {
  assert.deepEqual([...B2A_TIMEOUT_CAUSE_CLASSES], [
    'read_time_limit_exceeded', 'ETIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
    'TimeoutError', 'AbortError', 'TIMEOUT', 'BRIDGE_AGENT_TIMEOUT',
  ])
  assert.deepEqual([...B2A_PAGE_LIMIT_CAUSE_CLASSES], [
    'read_page_limit_exceeded', 'max_rows_exceeded', 'read_count_exceeded', 'SOURCE_RUN_RESULT_TOO_LARGE',
  ])
  assert.deepEqual([...B2A_INCOMPLETE_BATCH_CAUSE_CLASSES], ['read_cursor_broken'])
  // Every expander bound the stock-preparation path can produce is on exactly one roster. A bound
  // that fell off every roster would surface as an unclassified failure, which is the defect this
  // machinery exists to remove.
  for (const type of INCOMPLETE_READ_ERROR_TYPES) {
    assert.ok(classifyB2aSourceReadCause(type), `${type} is on no roster`)
  }
}

// The class is read STRUCTURALLY: `details.code`, then `code`, then `name`. Never the message —
// which is where a driver puts the host, the query and sometimes a value.
async function R05_theCauseClassIsStructuralNeverTheMessage() {
  assert.equal(b2aSourceReadCauseClass({ details: { code: 'read_count_exceeded' }, code: 'X', name: 'Y' }), 'read_count_exceeded')
  assert.equal(b2aSourceReadCauseClass({ code: 'ETIMEOUT', name: 'RequestError' }), 'ETIMEOUT')
  assert.equal(b2aSourceReadCauseClass({ name: 'TimeoutError' }), 'TimeoutError')
  assert.equal(b2aSourceReadCauseClass({ message: 'Timeout: Request failed to complete in 30000ms' }), null)
  assert.equal(b2aSourceReadCauseClass(null), null)
}

// AN UNRECOGNIZED FAILURE IS NOT MAPPED. A fixed code that means "something went wrong" is not
// evidence, and claiming a classification the code cannot make is worse than leaving the original
// error alone. This is also the E4-06 discipline restated for the read side: a read-only failure
// must never come back wearing a code that belongs to a different property.
async function R05_anUnrecognizedCauseIsLeftAlone() {
  const authorization = { registryId: 'r', registryVersion: 1, registrationId: 'reg', purpose: 'p' }
  assert.equal(mapB2aSourceReadError(new Error('Row limit 20000 exceeds the maximum 10000'), authorization), null,
    'the host row ceiling throws a bare Error with no code; matching its MESSAGE would be brittle and values-bearing')
  assert.equal(mapB2aSourceReadError({ code: 'ECONNREFUSED' }, authorization), null)

  const original = Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
  const passedThrough = await runB2aGuardedSourceRead(authorization, () => { throw original }).catch((error) => error)
  assert.equal(passedThrough, original, 'an unmapped failure propagates as the very same object')
}

// The mapped error carries the fixed code AND keeps the original cause class and cause object.
async function R05_aMappedFailureKeepsItsOriginalCauseClass() {
  const authorization = { registryId: 'r', registryVersion: 1, registrationId: 'reg', purpose: 'p' }
  const original = Object.assign(new Error('Timeout: Request failed to complete in 30000ms'), {
    name: 'RequestError', code: 'ETIMEOUT',
  })
  const mapped = await runB2aGuardedSourceRead(authorization, () => { throw original }).catch((error) => error)
  assert.ok(mapped instanceof B2aReadAuthorizationError)
  assert.equal(mapped.code, B2A_SOURCE_TIMEOUT)
  assert.equal(mapped.status, 504)
  assert.equal(mapped.details.reason, 'source_read_timeout')
  assert.equal(mapped.details.causeClass, 'ETIMEOUT', 'the read-only original cause class is kept, not swallowed')
  assert.equal(mapped.cause, original)
  // VALUES-FREE: the driver's message never reaches the surfaced error.
  assert.equal(JSON.stringify(mapped.details).includes('30000ms'), false)

  const capExceeded = await runB2aGuardedSourceRead(authorization, () => {
    throw Object.assign(new Error('x'), { name: 'StockPreparationBomExpansionError', details: { code: 'max_rows_exceeded' } })
  }).catch((error) => error)
  assert.equal(capExceeded.code, B2A_PAGE_LIMIT_EXCEEDED)
  assert.equal(capExceeded.status, 409)

  // DORMANT: no wrapping at all, so a dormant deployment's error objects are the ones it had.
  const dormant = await runB2aGuardedSourceRead(null, () => { throw original }).catch((error) => error)
  assert.equal(dormant, original)
}

// E3-02, unit half: the expander CATCHES its bounds and returns them as data, so the result side has
// to classify too. `read_failed` carries the preserved cause class, which is how a swallowed driver
// timeout still surfaces as a timeout rather than as a generic incompleteness.
async function E3_02_theResultSideClassifiesTheExpandersOwnBounds() {
  const authorization = { registryId: 'r', registryVersion: 1, registrationId: 'reg', purpose: 'p' }
  const refusal = (errors) => captured(() => assertB2aFullBatchComplete(authorization, errors))

  assert.equal(refusal([]), null, 'a complete batch is not refused')
  assert.equal(refusal(undefined), null)
  assert.equal(assertB2aFullBatchComplete(null, [{ type: 'max_rows_exceeded' }]), undefined, 'dormant refuses nothing')

  const cap = refusal([{ type: 'max_rows_exceeded', maxRows: 10 }])
  assert.equal(cap.code, B2A_PAGE_LIMIT_EXCEEDED)
  assert.equal(cap.details.fullBatch, false)
  assert.equal(cap.details.errorEntryCount, 1)

  const elapsed = refusal([{ type: 'read_time_limit_exceeded' }])
  assert.equal(elapsed.code, B2A_SOURCE_TIMEOUT)

  const swallowedTimeout = refusal([{ type: 'read_failed', causeClass: 'ETIMEOUT', message: 'Timeout after 30000ms' }])
  assert.equal(swallowedTimeout.code, B2A_SOURCE_TIMEOUT, 'the class survived the expander catching the throw')
  assert.equal(swallowedTimeout.details.causeClass, 'ETIMEOUT')
  assert.equal(JSON.stringify(swallowedTimeout.details).includes('30000ms'), false)

  const brokenCursor = refusal([{ type: 'read_cursor_broken', page: 2 }])
  assert.equal(brokenCursor.code, C6_FULL_BATCH_INCOMPLETE)
  assert.equal(brokenCursor.details.reason, 'source_read_cursor_broken')

  // An UNCLASSIFIABLE failure still refuses — any global error means the batch is not the full
  // batch — but it names the property rather than inventing a cause, and echoes no class at all.
  const unclassified = refusal([{ type: 'read_failed', causeClass: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }])
  assert.equal(unclassified.code, C6_FULL_BATCH_INCOMPLETE)
  assert.equal(unclassified.details.reason, 'source_read_incomplete')
  assert.equal('causeClass' in unclassified.details, false, 'an unrostered class is never echoed into evidence')

  // A timeout beats a bound beats bare incompleteness, so evidence names the FIRST cause, not the
  // last error the expander happened to append.
  assert.equal(refusal([
    { type: 'read_failed', causeClass: 'ECONNREFUSED' },
    { type: 'max_rows_exceeded' },
    { type: 'read_time_limit_exceeded' },
  ]).code, B2A_SOURCE_TIMEOUT)
}

// ── W-5: TWO FAIL-CLOSED FLOORS FOR ARMED B2a READS OVER SQL SERVER ──────────
//
// Floor 1 gets its OWN fixed code (unlike floor 2, which reuses #5243's existing error verbatim and
// mints nothing here — see MSSQLAdapter.ts / data-source-plugin-facade.ts). This suite pins: the
// classifier that recognizes the core-backend facade's generic pre-connect refusal, the refusal
// helper's shape (403, fixed code, values-free evidence), and that it is a strict no-op when dormant.
async function W5_isDataSourceRequestTimeoutDisabledErrorRecognizesOnlyTheOneCode() {
  assert.equal(isDataSourceRequestTimeoutDisabledError({ code: DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE }), true)
  // Structural, not by message — a driver/adapter error that merely MENTIONS the words is not this.
  assert.equal(isDataSourceRequestTimeoutDisabledError(new Error('data source has requestTimeoutMs=0')), false)
  assert.equal(isDataSourceRequestTimeoutDisabledError({ code: 'DATA_SOURCE_NOT_READ_ONLY' }), false)
  assert.equal(isDataSourceRequestTimeoutDisabledError({ code: 'ETIMEOUT' }), false)
  assert.equal(isDataSourceRequestTimeoutDisabledError(null), false)
  assert.equal(isDataSourceRequestTimeoutDisabledError(undefined), false)
  assert.equal(isDataSourceRequestTimeoutDisabledError('DATA_SOURCE_REQUEST_TIMEOUT_DISABLED'), false, 'a bare string is not an error object')
}

async function W5_refuseB2aArmedSqlServerRequestTimeoutDisabledIsFixedCodeAndValuesFree() {
  const authorization = {
    registryId: 'reg-1', registryVersion: 1, registrationId: 'trial-1', purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  }
  const refusal = captured(() => refuseB2aArmedSqlServerRequestTimeoutDisabled(authorization))
  assert.ok(refusal instanceof B2aReadAuthorizationError)
  assert.equal(refusal.status, 403)
  assert.equal(refusal.code, B2A_SOURCE_TIMEOUT_DISABLED_REJECTED)
  assert.equal(refusal.details.reason, 'sqlserver_request_timeout_disabled')
  // Evidence carries only the registry/registration identity and purpose the header discipline
  // allows — no data-source id, no host, no connection setting, no message about "0".
  assert.deepEqual(refusal.details, {
    reason: 'sqlserver_request_timeout_disabled',
    registryId: 'reg-1',
    registryVersion: 1,
    registrationId: 'trial-1',
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  })
  // DORMANT: no authorization, no refusal — this floor never fires on an unarmed deployment.
  assert.equal(refuseB2aArmedSqlServerRequestTimeoutDisabled(null), undefined)
  assert.equal(refuseB2aArmedSqlServerRequestTimeoutDisabled(undefined), undefined)
}

// ── R-06: THE SCHEMA CONTRACT ────────────────────────────────────────────────

function schemaAdapter(schema, { onGetSchema } = {}) {
  const calls = []
  return {
    calls,
    adapter: {
      async getSchema(input = {}) {
        calls.push(input.object)
        if (onGetSchema) {
          const injected = onGetSchema(input)
          if (injected !== undefined) return injected
        }
        return { object: input.object, fields: (schema[input.object] || []).map((f) => ({ ...f })) }
      },
      async read() { throw new Error('the contract check must never read a row') },
    },
  }
}

const SQL_SCHEMA = Object.freeze({
  [OBJECT_A]: [{ name: 'FileCode', type: 'nvarchar', nullable: false }, { name: 'Parent_OBJ_ID', type: 'nvarchar', nullable: true }],
  [OBJECT_B]: [{ name: 'OBJ_ID', type: 'nvarchar', nullable: false }, { name: 'IdentityNo', type: 'nvarchar', nullable: false }],
})

async function contractFor(schema, { store: claimStore = store(), extFieldMapping, adapterOptions } = {}) {
  const source = schemaAdapter(schema, adapterOptions)
  const authorization = { registryId: 'b2a-2026-q3', registryVersion: 1, registrationId: 'b2a-factory-a-plm', registrationVersion: 1, purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION }
  const result = await assertB2aSchemaContract({
    store: claimStore,
    authorization,
    sourceAdapter: source.adapter,
    sourceObjects: [OBJECT_A, OBJECT_B],
    extFieldMapping,
    now: NOW,
  })
  return { result, source, store: claimStore, authorization }
}

// FIRST READ PINS; AN IDENTICAL SCHEMA PASSES. The record lands in the SAME durable store the
// operation claim uses, under its own prefix — the registry file is a read-only deploy artifact.
async function R06_theFirstArmedReadPinsAndAnIdenticalSchemaPasses() {
  const claimStore = store()
  const first = await contractFor(SQL_SCHEMA, { store: claimStore })
  assert.equal(first.result.schemaContractPinned, true)
  assert.equal(first.result.objectCount, 2)
  assert.equal(first.result.fieldCount, 4)
  assert.deepEqual(first.source.calls, [OBJECT_A, OBJECT_B].slice().sort(),
    'exactly one getSchema per plan object, in a SORTED order so the digest cannot depend on call order')

  const keys = [...claimStore.keys()]
  assert.deepEqual(keys, [`${SCHEMA_CONTRACT_KEY_PREFIX}b2a-factory-a-plm`], 'keyed to the registration id, not its version')
  const stored = claimStore.get(keys[0])
  assert.equal(stored.schemaContractVersion, B2A_SCHEMA_CONTRACT_VERSION)
  // VALUES-FREE AT REST: no column name, no object name, no type token in the clear.
  const text = JSON.stringify(stored)
  for (const identifier of ['FileCode', 'IdentityNo', 'nvarchar', OBJECT_A, OBJECT_B]) {
    assert.equal(text.includes(identifier), false, `the stored contract leaked ${identifier}`)
  }
  for (const [key, value] of Object.entries(stored.fields)) {
    assert.match(key, /^[0-9a-f]{32}$/)
    assert.match(value, /^[0-9a-f]{32}$/)
  }

  const second = await contractFor(SQL_SCHEMA, { store: claimStore })
  assert.equal(second.result.schemaContractPinned, false, 'the second read COMPARES')
  assert.equal(second.result.schemaDrift, false)
  assert.equal(second.result.schemaDigest, first.result.schemaDigest)

  // DORMANT: no authorization, no probe, no record.
  const dormantStore = store()
  const dormantAdapter = schemaAdapter(SQL_SCHEMA)
  assert.equal(await assertB2aSchemaContract({
    store: dormantStore, authorization: null, sourceAdapter: dormantAdapter.adapter, sourceObjects: [OBJECT_A], now: NOW,
  }), null)
  assert.deepEqual(dormantAdapter.calls, [], 'a dormant deployment does not probe the source schema')
  assert.equal(dormantStore.size, 0)
}

// EVERY DRIFT KIND REFUSES, AND THE REFUSAL COUNTS THEM WITHOUT NAMING THEM.
async function R06_driftRefusesWithCountsAndNoNames() {
  const cases = [
    ['field missing', { ...SQL_SCHEMA, [OBJECT_B]: SQL_SCHEMA[OBJECT_B].slice(1) }, { missingFieldCount: 1, changedFieldCount: 0, addedFieldCount: 0 }],
    ['type change', { ...SQL_SCHEMA, [OBJECT_B]: SQL_SCHEMA[OBJECT_B].map((f, i) => (i === 0 ? { ...f, type: 'int' } : f)) }, { missingFieldCount: 0, changedFieldCount: 1, addedFieldCount: 0 }],
    ['nullability change', { ...SQL_SCHEMA, [OBJECT_B]: SQL_SCHEMA[OBJECT_B].map((f, i) => (i === 0 ? { ...f, nullable: true } : f)) }, { missingFieldCount: 0, changedFieldCount: 1, addedFieldCount: 0 }],
    // A WIDENED source is still a CHANGED source. §13 names three kinds and this is not literally
    // one of them, but the contract is a digest and "identical schema passes" is the pass condition;
    // re-pinning is meant to be a deliberate act, not something a DDL does on the deployment's behalf.
    ['field added', { ...SQL_SCHEMA, [OBJECT_B]: [...SQL_SCHEMA[OBJECT_B], { name: 'Extra', type: 'nvarchar', nullable: true }] }, { missingFieldCount: 0, changedFieldCount: 0, addedFieldCount: 1 }],
  ]
  for (const [label, drifted, counts] of cases) {
    const claimStore = store()
    await contractFor(SQL_SCHEMA, { store: claimStore })
    const error = await contractFor(drifted, { store: claimStore }).then(() => null, (e) => e)
    assert.ok(error instanceof B2aReadAuthorizationError, label)
    assert.equal(error.code, B2A_SCHEMA_DRIFT, label)
    assert.equal(error.status, 409, label)
    assert.equal(error.details.reason, 'schema_contract_drift', label)
    assert.equal(error.details.missingFieldCount, counts.missingFieldCount, label)
    assert.equal(error.details.changedFieldCount, counts.changedFieldCount, label)
    assert.equal(error.details.addedFieldCount, counts.addedFieldCount, label)
    const text = JSON.stringify(error.details)
    for (const identifier of ['FileCode', 'IdentityNo', 'Extra', 'nvarchar', OBJECT_A, OBJECT_B]) {
      assert.equal(text.includes(identifier), false, `${label}: refusal leaked ${identifier}`)
    }
  }
}

// MAPPING DRIFT (§13's 映射漂移) is not a source property. The `ext_` mapping's IDENTITY is folded
// into the digest, so swapping it — or configuring one where there was none — is drift even when the
// source never moved.
async function R06_mappingIdentityDriftIsDriftEvenWhenTheSourceDidNotMove() {
  const mapping = (mappingId, mappingVersion) => ({ mappingId, mappingVersion, targets: [] })
  const claimStore = store()
  await contractFor(SQL_SCHEMA, { store: claimStore, extFieldMapping: mapping('pack-a', 1) })

  const versionBump = await contractFor(SQL_SCHEMA, { store: claimStore, extFieldMapping: mapping('pack-a', 2) }).then(() => null, (e) => e)
  assert.equal(versionBump.code, B2A_SCHEMA_DRIFT)
  assert.equal(versionBump.details.mappingChanged, true)
  assert.equal(versionBump.details.missingFieldCount, 0, 'the SOURCE did not move; only the mapping did')

  const removed = await contractFor(SQL_SCHEMA, { store: claimStore }).then(() => null, (e) => e)
  assert.equal(removed.code, B2A_SCHEMA_DRIFT, 'removing a configured mapping is drift too')

  const unchanged = await contractFor(SQL_SCHEMA, { store: claimStore, extFieldMapping: mapping('pack-a', 1) })
  assert.equal(unchanged.result.schemaDrift, false)
}

// THE TWO ADAPTERS SPELL NULLABILITY DIFFERENTLY, AND ONE OF THEM INVERTS IT.
//
//   data-source:sql-readonly   -> { name, type, nullable }
//   bridge:legacy-sql-readonly -> { name, label, type, required }     (required = NOT nullable)
//
// A contract that read `nullable` alone would record `undefined` for every bridge column and then
// pass a source whose nullability changed — a control that looks total and matches on a constant.
async function R06_bridgeRequiredIsReadAsInvertedNullability() {
  const bridgeNotNull = { [OBJECT_A]: [{ name: 'FileCode', label: 'FileCode', type: 'nvarchar', required: true }] }
  const bridgeNullable = { [OBJECT_A]: [{ name: 'FileCode', label: 'FileCode', type: 'nvarchar', required: false }] }
  const sqlNotNull = { [OBJECT_A]: [{ name: 'FileCode', type: 'nvarchar', nullable: false }] }

  const one = await assertB2aSchemaContract({
    store: store(),
    authorization: { registryId: 'r', registryVersion: 1, registrationId: 'reg-bridge', registrationVersion: 1, purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION },
    sourceAdapter: schemaAdapter(bridgeNotNull).adapter,
    sourceObjects: [OBJECT_A],
    now: NOW,
  })
  const two = await assertB2aSchemaContract({
    store: store(),
    authorization: { registryId: 'r', registryVersion: 1, registrationId: 'reg-sql', registrationVersion: 1, purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION },
    sourceAdapter: schemaAdapter(sqlNotNull).adapter,
    sourceObjects: [OBJECT_A],
    now: NOW,
  })
  assert.equal(one.schemaDigest, two.schemaDigest, '`required: true` and `nullable: false` are the same declared shape')

  // And flipping the bridge's `required` MOVES the digest, which is the assertion that fails when
  // the inverted spelling is dropped.
  const claimStore = store()
  await contractFor(bridgeNotNull, { store: claimStore })
  const flipped = await contractFor(bridgeNullable, { store: claimStore }).then(() => null, (e) => e)
  assert.equal(flipped.code, B2A_SCHEMA_DRIFT)
  assert.equal(flipped.details.changedFieldCount, 1)
}

// FAIL-CLOSED WHERE THE CONTRACT CANNOT BE ESTABLISHED. "No contract" must never read as "no drift".
// Every REAL adapter has `getSchema` — `contracts.cjs` lists it in `REQUIRED_ADAPTER_METHODS`, so an
// adapter without one cannot be registered — which is why refusing here costs a deployment nothing
// and closes the one hole that would otherwise turn the whole check off.
async function R06_anAdapterThatCannotDescribeItselfFailsClosed() {
  const authorization = { registryId: 'r', registryVersion: 1, registrationId: 'reg', registrationVersion: 1, purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION }
  const refuse = (options) => assertB2aSchemaContract({ store: store(), authorization, now: NOW, ...options })
    .then(() => null, (error) => error)

  const noFacade = await refuse({ sourceAdapter: { async read() { return {} } }, sourceObjects: [OBJECT_A] })
  assert.equal(noFacade.code, B2A_SCHEMA_DRIFT)
  assert.equal(noFacade.details.reason, 'schema_facade_unavailable')

  const noObjects = await refuse({ sourceAdapter: schemaAdapter(SQL_SCHEMA).adapter, sourceObjects: [] })
  assert.equal(noObjects.details.reason, 'schema_scope_empty')

  const unreadable = await refuse({
    sourceAdapter: schemaAdapter(SQL_SCHEMA, { onGetSchema: () => ({ object: OBJECT_A }) }).adapter,
    sourceObjects: [OBJECT_A],
  })
  assert.equal(unreadable.details.reason, 'schema_unreadable')

  // A contract pinned in a format this runtime cannot compare is treated as drift, not as absence.
  const staleStore = store()
  staleStore.set(`${SCHEMA_CONTRACT_KEY_PREFIX}reg`, { schemaContractVersion: 0, schemaDigest: 'x', fields: {} })
  const stale = await refuse({ store: staleStore, sourceAdapter: schemaAdapter(SQL_SCHEMA).adapter, sourceObjects: [OBJECT_A] })
  assert.equal(stale.details.reason, 'schema_contract_version_mismatch')

  // R-05 REACHES THE SCHEMA PROBE TOO: it is a source read and is hardened as one, so a `getSchema`
  // that times out surfaces the timeout code rather than an unclassified 500.
  const timedOut = await refuse({
    sourceAdapter: schemaAdapter(SQL_SCHEMA, {
      onGetSchema: () => { throw Object.assign(new Error('t'), { name: 'RequestError', code: 'ETIMEOUT' }) },
    }).adapter,
    sourceObjects: [OBJECT_A],
  })
  assert.equal(timedOut.code, B2A_SOURCE_TIMEOUT)
  assert.equal(timedOut.details.causeClass, 'ETIMEOUT')

  // The store itself is required, for the same reason the operation claim requires it: without
  // durable state a first-read pin cannot be a pin.
  const noStore = await assertB2aSchemaContract({
    store: null, authorization, sourceAdapter: schemaAdapter(SQL_SCHEMA).adapter, sourceObjects: [OBJECT_A], now: NOW,
  }).then(() => null, (error) => error)
  assert.equal(noStore.details.reason, 'claim_store_unavailable')
}

// E3-05, unit half: the post-read comparison, and the one thing it is honest about not covering.
async function E3_05_theMidReadComparisonUsesThePreReadDigest() {
  const authorization = { registryId: 'r', registryVersion: 1, registrationId: 'reg', registrationVersion: 1, purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION }
  const claimStore = store()
  const { result: contract } = await contractFor(SQL_SCHEMA, { store: claimStore })

  const unchanged = await assertB2aSourceUnchangedAfterRead({
    authorization, contract, sourceAdapter: schemaAdapter(SQL_SCHEMA).adapter, sourceObjects: [OBJECT_A, OBJECT_B],
  })
  assert.deepEqual(unchanged, { sourceUnchangedAcrossRead: true })

  const moved = { ...SQL_SCHEMA, [OBJECT_B]: SQL_SCHEMA[OBJECT_B].slice(1) }
  const error = await assertB2aSourceUnchangedAfterRead({
    authorization, contract, sourceAdapter: schemaAdapter(moved).adapter, sourceObjects: [OBJECT_A, OBJECT_B],
  }).then(() => null, (e) => e)
  assert.equal(error.code, C6_FULL_BATCH_INCOMPLETE)
  assert.equal(error.details.reason, 'source_changed_mid_read')
  assert.equal(error.details.missingFieldCount, 1)
  assert.equal(error.details.fullBatch, false)

  // DORMANT, and no-contract: both are no-ops rather than refusals, so an unarmed read is untouched.
  assert.equal(await assertB2aSourceUnchangedAfterRead({ authorization: null, contract }), null)
  assert.equal(await assertB2aSourceUnchangedAfterRead({ authorization, contract: null }), null)
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
  R03b_twoConcurrentClaimersYieldExactlyOneWinner,
  M78_migration078DefinesTheDbLevelOperationClaim,
  R04_uniquenessVersionAndReuse,
  aMatchingRegistrationPasses,
  theSoonestExpiringLiveRegistrationWins,
  aMalformedRegistryAtCheckTimeIsFailClosed,
  theBuiltRegistryIsImmutable,
  theReadPlanNamesItsOwnObjects,
  R05_theCauseClassRostersAreClosedAndRestated,
  R05_theCauseClassIsStructuralNeverTheMessage,
  R05_anUnrecognizedCauseIsLeftAlone,
  R05_aMappedFailureKeepsItsOriginalCauseClass,
  E3_02_theResultSideClassifiesTheExpandersOwnBounds,
  W5_isDataSourceRequestTimeoutDisabledErrorRecognizesOnlyTheOneCode,
  W5_refuseB2aArmedSqlServerRequestTimeoutDisabledIsFixedCodeAndValuesFree,
  R06_theFirstArmedReadPinsAndAnIdenticalSchemaPasses,
  R06_driftRefusesWithCountsAndNoNames,
  R06_mappingIdentityDriftIsDriftEvenWhenTheSourceDidNotMove,
  R06_bridgeRequiredIsReadAsInvertedNullability,
  R06_anAdapterThatCannotDescribeItselfFailsClosed,
  E3_05_theMidReadComparisonUsesThePreReadDigest,
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
