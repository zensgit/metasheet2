'use strict'

// THE B2a REGISTRY CONTRACT — normalization at load, and the gate decision at check.
//
// This suite pins what the module DOES. b2a-trial-registry-wiring.test.cjs pins the only thing that
// makes any of it matter: that the real HTTP routes reach it, and that a refusal happens before a
// single source row is read.
//
// Hermetic: no DB, no network, no filesystem, no wall clock (every check is handed an explicit
// `now`). Values-free: the only literals are synthetic ids, frozen reason tokens and ISO timestamps
// this file authors itself.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  B2A_TRIAL_REGISTRY_CONFIG_KEY,
  B2A_PURPOSES,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
  B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
  B2A_EXPIRY_HANDLINGS,
  MAX_B2A_REGISTRATION_WINDOW_MS,
  B2aTrialRegistryError,
  assertB2aTrialAuthorized,
  createB2aTrialRegistry,
  resolveB2aTrialRegistryConfig,
} = require(path.join(LIB, 'b2a-trial-registry.cjs'))

const {
  PROD_CANONICAL_OBJECT_ID,
  normalizeStockPrepApplyProductionPolicy,
} = require(path.join(LIB, 'stock-preparation-production-policy.cjs'))

const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

// The literal the HOST writes onto server config (packages/core-backend/src/plugin-runtime-config.ts).
// Stated as a literal rather than imported and compared to itself: a self-referential assertion
// passes just as happily when the constant is mistyped and the gate is permanently dormant.
assert.equal(B2A_TRIAL_REGISTRY_CONFIG_KEY, 'b2aTrialRegistry')

const TENANT = 'tenant_1'
const OTHER_TENANT = 'tenant_2'
const PLM_SYSTEM = 'plm_sql_source'
const K3_SYSTEM = 'k3_sql_source'
const SYSTEM_KIND = 'data-source:sql-readonly'
const IN_SCOPE_PROJECT = 'P-001'
const OUT_OF_SCOPE_PROJECT = 'P-999'

const T0 = Date.parse('2026-08-01T00:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = T0 + 10 * DAY_MS

// Whole seconds render without a fractional part; sub-second offsets KEEP theirs, because the
// window-cap boundary cases below are one millisecond wide and a lossy formatter would quietly turn
// "one ms past the cap" into "exactly at the cap" and pass vacuously.
function iso(ms) {
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z')
}

function entry(overrides = {}) {
  return {
    entryId: 'b2a-factory-a-plm',
    tenantId: TENANT,
    sourceBinding: { externalSystemId: PLM_SYSTEM },
    projectScope: { projectNos: [IN_SCOPE_PROJECT, 'P-002'] },
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    owner: 'owner-a',
    effectiveAt: iso(T0),
    expiresAt: iso(T0 + 60 * DAY_MS),
    forbidReuse: true,
    b2bCondition: 'migrate onto the generalized binding before expiry',
    expiryHandling: 'refuse',
    ...overrides,
  }
}

function registryConfig(entries, overrides = {}) {
  return {
    registryId: 'b2a-2026-q3',
    registryVersion: 1,
    entries,
    ...overrides,
  }
}

function build(entries, overrides) {
  return createB2aTrialRegistry({ config: { [B2A_TRIAL_REGISTRY_CONFIG_KEY]: registryConfig(entries, overrides) } })
}

function check(registry, overrides = {}) {
  return assertB2aTrialAuthorized({
    registry,
    tenantId: TENANT,
    externalSystemId: PLM_SYSTEM,
    systemKind: SYSTEM_KIND,
    projectNo: IN_SCOPE_PROJECT,
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
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

function assertConfigThrow(entries, label, overrides) {
  const error = captured(() => build(entries, overrides))
  assert.ok(error, `${label}: load must throw`)
  assert.ok(error instanceof B2aTrialRegistryError, `${label}: wrong error class (${error && error.name})`)
  assert.equal(error.code, 'B2A_TRIAL_REGISTRY_INVALID', label)
  assert.equal(error.status, 500, `${label}: a broken deployment is a 500, not a refused caller`)
}

function assertRefusal(registry, overrides, reason, label) {
  const error = captured(() => check(registry, overrides))
  assert.ok(error, `${label}: the gate must refuse`)
  assert.ok(error instanceof B2aTrialRegistryError, `${label}: wrong error class (${error && error.name})`)
  assert.equal(error.code, 'B2A_TRIAL_REGISTRATION_REQUIRED', label)
  assert.equal(error.status, 403, label)
  assert.equal(error.details.reason, reason, `${label}: wrong reason token`)
  // VALUES-FREE. A refusal may name entry ids, the source system id (already public in this
  // plugin's TABLE_ACTION_SOURCE_INVALID detail) and booleans. It must never carry a project
  // number, a tenant id, an owner, a migration condition or a date.
  const text = JSON.stringify({ message: error.message, details: error.details })
  for (const forbidden of [
    IN_SCOPE_PROJECT,
    OUT_OF_SCOPE_PROJECT,
    TENANT,
    OTHER_TENANT,
    'owner-a',
    'migrate onto the generalized binding before expiry',
    '2026-08',
  ]) {
    assert.equal(text.includes(forbidden), false, `${label}: refusal leaked ${JSON.stringify(forbidden)}`)
  }
  return error
}

// ── 1. DORMANCY: no key, no gate ──────────────────────────────────────────────

function dormantWhenTheKeyIsAbsent() {
  // The three shapes the host can hand over when INTEGRATION_CORE_B2A_REGISTRY_PATH is unset.
  assert.equal(createB2aTrialRegistry({ config: {} }), null, 'absent key is dormant')
  assert.equal(createB2aTrialRegistry({}), null, 'absent config is dormant')
  assert.equal(createB2aTrialRegistry(), null, 'no argument at all is dormant')
  assert.equal(createB2aTrialRegistry({ config: { [B2A_TRIAL_REGISTRY_CONFIG_KEY]: undefined } }), null)
  assert.equal(createB2aTrialRegistry({ config: { [B2A_TRIAL_REGISTRY_CONFIG_KEY]: null } }), null)
  assert.equal(resolveB2aTrialRegistryConfig({}), undefined)

  // And the gate, handed a dormant registry, returns null rather than a stanza — which is what lets
  // every caller add NOTHING to its evidence and stay byte-identical.
  assert.equal(assertB2aTrialAuthorized({ registry: null }), null)
  assert.equal(assertB2aTrialAuthorized({ registry: undefined }), null)
  assert.equal(assertB2aTrialAuthorized({}), null)
  // Dormant short-circuits BEFORE every other validation: a call with no tenant, no system, no
  // project, no purpose and no clock is still simply not gated.
  assert.equal(assertB2aTrialAuthorized({ registry: null, tenantId: null, projectNo: null, now: NaN }), null)
}

// `false` is FATAL here where the ext-field mapping treats it as "switched off". That module needs a
// kill switch an operator can reach without taking the plugin down; the whole point of this one is
// that it cannot be switched off from inside the file it governs.
function switchingItOffFromInsideTheFileIsRefused() {
  for (const raw of [false, true, 0, 1, 'off', [], [entry()]]) {
    const error = captured(() => createB2aTrialRegistry({ config: { [B2A_TRIAL_REGISTRY_CONFIG_KEY]: raw } }))
    assert.ok(error, `${JSON.stringify(raw)} must not be accepted as a registry`)
    assert.equal(error.code, 'B2A_TRIAL_REGISTRY_INVALID')
    assert.equal(error.status, 500)
    // The message points at the ONE supported way to be dormant, which is a deployment act.
    assert.ok(error.message.includes('INTEGRATION_CORE_B2A_REGISTRY_PATH'), 'the message names the env var')
  }
}

// ── 2. LOAD-TIME VALIDATION: closed key sets, required fields ─────────────────

function registryEnvelopeIsValidated() {
  assertConfigThrow([], 'a registry must name itself', { registryId: undefined })
  assertConfigThrow([], 'registryVersion must be a positive integer', { registryVersion: 0 })
  assertConfigThrow([], 'registryVersion must be an integer', { registryVersion: 1.5 })
  assertConfigThrow([], 'registryVersion must be present', { registryVersion: undefined })
  assertConfigThrow([], 'an unknown envelope key is refused', { note: 'hello' })

  const missingEntries = captured(() => createB2aTrialRegistry({
    config: { [B2A_TRIAL_REGISTRY_CONFIG_KEY]: { registryId: 'r', registryVersion: 1 } },
  }))
  assert.ok(missingEntries, 'entries is required')
  assert.equal(missingEntries.code, 'B2A_TRIAL_REGISTRY_INVALID')

  // AN ARMED, EMPTY REGISTRY IS LEGAL and refuses everything. This is the correct state for a
  // deployment that has armed the gate and has no approved exception yet; rejecting it would push
  // operators toward leaving the env var unset instead, which is strictly worse.
  const empty = build([])
  assert.notEqual(empty, null, 'an empty registry is ARMED, not dormant')
  assert.equal(empty.entryCount, 0)
  assertRefusal(empty, {}, 'no_entry', 'an armed empty registry refuses everything')
}

function everyRegisteredFieldIsRequired() {
  // The freeze asks the registration to state applicable customer / system / data scope / no-reuse /
  // owner / expiry / B2b condition / overrun handling. Each one is refused when absent, at load.
  for (const field of ['entryId', 'tenantId', 'owner', 'b2bCondition', 'expiryHandling', 'effectiveAt', 'expiresAt']) {
    assertConfigThrow([entry({ [field]: undefined })], `${field} is required`)
    assertConfigThrow([entry({ [field]: '   ' })], `${field} may not be blank`)
  }
  assertConfigThrow([entry({ sourceBinding: undefined })], 'sourceBinding is required')
  assertConfigThrow([entry({ projectScope: undefined })], 'projectScope is required')
  assertConfigThrow([entry({ forbidReuse: undefined })], 'forbidReuse is required')
  assertConfigThrow([entry({ forbidReuse: 'true' })], 'forbidReuse must be a real boolean')

  // Closed key sets at all three levels.
  assertConfigThrow([entry({ notAKey: 1 })], 'an unknown entry key is refused')
  assertConfigThrow([entry({ sourceBinding: { externalSystemId: PLM_SYSTEM, host: 'x' } })], 'an unknown binding key is refused')
  assertConfigThrow([entry({ projectScope: { projectNos: [IN_SCOPE_PROJECT], all: true } })], 'an unknown scope key is refused')
  assertConfigThrow([{ ...entry(), entryId: 1 }], 'a non-string entryId is refused')
  assertConfigThrow(['not-an-object'], 'a non-object entry is refused')

  // expiryHandling is a CLOSED token, not prose: a field that reads like a control and is not one is
  // worse than no field.
  assert.deepEqual([...B2A_EXPIRY_HANDLINGS], ['refuse'])
  assertConfigThrow([entry({ expiryHandling: 'notify the owner' })], 'expiryHandling must be a known token')

  // Duplicate entry ids would make an evidence stanza ambiguous about WHICH registration authorized
  // a read, which is the one thing the stanza exists to say.
  assertConfigThrow([entry(), entry({ tenantId: OTHER_TENANT })], 'a duplicate entryId is refused')
}

// THE KEY. tenant+project alone was ruled INSUFFICIENT because one customer can connect several
// PLM/ERP systems; the external-system id is what tells them apart, so an entry may not omit it.
function theSourceBindingIsMandatory() {
  assertConfigThrow([entry({ sourceBinding: {} })], 'a binding must name its external system')
  assertConfigThrow([entry({ sourceBinding: { externalSystemId: '  ' } })], 'a blank external system id is refused')
  assertConfigThrow([entry({ sourceBinding: { systemKind: SYSTEM_KIND } })], 'systemKind alone is not a binding')
  assertConfigThrow([entry({ sourceBinding: { externalSystemId: PLM_SYSTEM, systemKind: '' } })], 'a blank systemKind is refused')
}

// "允许读写的数据范围" with no enumeration is not a scope. There is deliberately no wildcard.
function theProjectScopeMustEnumerate() {
  assertConfigThrow([entry({ projectScope: {} })], 'a scope must enumerate projects')
  assertConfigThrow([entry({ projectScope: { projectNos: [] } })], 'an empty scope is refused')
  assertConfigThrow([entry({ projectScope: { projectNos: '*' } })], 'a wildcard string is not a scope')
  assertConfigThrow([entry({ projectScope: { projectNos: [IN_SCOPE_PROJECT, ''] } })], 'a blank project number is refused')
  assertConfigThrow([entry({ projectScope: { projectNos: [IN_SCOPE_PROJECT, IN_SCOPE_PROJECT] } })], 'a repeated project number is refused')
}

// ── 3. BOUNDED TIME ───────────────────────────────────────────────────────────

// Strict ISO-8601 with time AND zone. `Date.parse` alone accepts "2999" and turns a bounded window
// into a millennium. The vector table is shared with the production-policy module's parser so the
// deliberate duplication of `parseStrictIsoTimestamp` cannot drift silently.
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

function timestampsAreStrictIsoAndAgreeWithTheProductionPolicyParser() {
  for (const [value, accepted] of ISO_VECTORS) {
    // B2a side: vary `expiresAt` with an effectiveAt far enough back to stay inside the window cap.
    const b2a = captured(() => build([entry({ effectiveAt: '2026-08-30T00:00:00Z', expiresAt: value })]))
    assert.equal(b2a === null, accepted, `B2a expiresAt ${JSON.stringify(value)} acceptance`)

    // Production-policy side: the SAME vector through the module this parser was lifted from.
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

  // effectiveAt is held to the same standard.
  assertConfigThrow([entry({ effectiveAt: '2026' })], 'effectiveAt must be strict ISO')
}

function theWindowIsBounded() {
  assert.equal(MAX_B2A_REGISTRATION_WINDOW_MS, 180 * DAY_MS)
  // At the cap: accepted. One millisecond past it: refused, at LOAD, without any clock.
  assert.notEqual(build([entry({ effectiveAt: iso(T0), expiresAt: iso(T0 + MAX_B2A_REGISTRATION_WINDOW_MS) })]), null)
  assertConfigThrow(
    [entry({ effectiveAt: iso(T0), expiresAt: iso(T0 + MAX_B2A_REGISTRATION_WINDOW_MS + 1) })],
    'a window longer than the bounded exception window is refused',
  )
  // A "限时" exception that never ends, spelled as two individually well-formed timestamps.
  assertConfigThrow([entry({ effectiveAt: iso(T0), expiresAt: '2999-01-01T00:00:00Z' })], 'a millennium is not a window')
  assertConfigThrow([entry({ effectiveAt: iso(T0), expiresAt: iso(T0) })], 'expiresAt must be after effectiveAt')
  assertConfigThrow([entry({ effectiveAt: iso(T0 + DAY_MS), expiresAt: iso(T0) })], 'a reversed window is refused')
}

// The module holds no clock: expiry against the WALL CLOCK is a CHECK-time decision, deliberately
// (an activation that depends on the time of day would take the whole plugin down at midnight).
// An already-expired entry LOADS and then refuses every single call.
function expiryIsCheckedAtCheckTimeNotLoadTime() {
  const expired = build([entry({ effectiveAt: iso(T0), expiresAt: iso(T0 + DAY_MS) })])
  assert.notEqual(expired, null, 'a well-formed but expired entry LOADS')
  assert.equal(expired.entryCount, 1)
  const error = assertRefusal(expired, {}, 'expired', 'an expired registration refuses at check time')
  assert.equal(error.details.notExpired, false)
  assert.equal(error.details.effective, true)
  assert.equal(error.details.expiryHandling, 'refuse', 'the refusal states the rule it is applying')

  // The boundary is exclusive at the top: at `expiresAt` exactly, it is expired.
  const boundary = build([entry({ effectiveAt: iso(T0), expiresAt: iso(NOW) })])
  assertRefusal(boundary, {}, 'expired', 'expiry is exclusive at the top of the window')
  assert.ok(check(build([entry({ effectiveAt: iso(T0), expiresAt: iso(NOW + 1) })])), 'one ms before expiry still passes')

  // …and inclusive at the bottom.
  assert.ok(check(build([entry({ effectiveAt: iso(NOW), expiresAt: iso(NOW + DAY_MS) })])), 'effectiveAt is inclusive')
  const notYet = build([entry({ effectiveAt: iso(NOW + 1), expiresAt: iso(NOW + DAY_MS) })])
  const early = assertRefusal(notYet, {}, 'not_yet_effective', 'a future registration does not authorize today')
  assert.equal(early.details.effective, false)

  // No clock, no decision. Fail-closed rather than defaulting to "now".
  assertRefusal(build([entry()]), { now: undefined }, 'missing_now', 'a missing clock refuses')
  assertRefusal(build([entry()]), { now: NaN }, 'missing_now', 'a NaN clock refuses')
  assertRefusal(build([entry()]), { now: '1754000000000' }, 'missing_now', 'a string clock refuses')
}

// ── 4. THE GATE DECISION ──────────────────────────────────────────────────────

function aMatchingEntryPasses() {
  const registry = build([entry()])
  const stanza = check(registry)
  assert.deepEqual(stanza, {
    armed: true,
    registryId: 'b2a-2026-q3',
    registryVersion: 1,
    entryId: 'b2a-factory-a-plm',
    purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    sourceSystemId: PLM_SYSTEM,
    sourceBindingMatched: true,
    projectInScope: true,
    effective: true,
    notExpired: true,
    forbidReuse: true,
    expiryHandling: 'refuse',
  })
  assert.ok(Object.isFrozen(stanza), 'the stanza is frozen')
  // VALUES-FREE on the PASS path too: ids and booleans, never a project number, a tenant, an owner
  // or a date.
  const text = JSON.stringify(stanza)
  for (const forbidden of [IN_SCOPE_PROJECT, TENANT, 'owner-a', '2026-08', 'migrate onto']) {
    assert.equal(text.includes(forbidden), false, `pass stanza leaked ${JSON.stringify(forbidden)}`)
  }
}

// THE R-09 LESSON, made executable. The production-policy instrument is process-global and carries
// NO tenant and NO project field, so it can only ever say "this server may apply". These four
// refusals are the four dimensions that shape could not express.
function theEntryIsScopedOnAllFourDimensions() {
  const registry = build([entry()])
  assertRefusal(registry, { tenantId: OTHER_TENANT }, 'no_entry', 'another tenant is not covered')
  assertRefusal(registry, { externalSystemId: K3_SYSTEM }, 'no_entry', 'the SAME customer\'s OTHER system is not covered')
  assertRefusal(registry, { projectNo: OUT_OF_SCOPE_PROJECT }, 'project_out_of_scope', 'a project outside the scope is refused')
  assertRefusal(registry, { purpose: B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST }, 'purpose_not_permitted', 'another consumer is refused')

  // The one that motivated the key: a tenant with TWO registered systems gets an entry per system,
  // and neither authorizes the other.
  const two = build([
    entry({ entryId: 'b2a-plm', sourceBinding: { externalSystemId: PLM_SYSTEM } }),
    entry({ entryId: 'b2a-k3', sourceBinding: { externalSystemId: K3_SYSTEM }, projectScope: { projectNos: ['P-777'] } }),
  ])
  assert.equal(check(two).entryId, 'b2a-plm')
  assert.equal(check(two, { externalSystemId: K3_SYSTEM, projectNo: 'P-777' }).entryId, 'b2a-k3')
  // …and the PLM entry's project scope does not travel to the K3 binding.
  assertRefusal(two, { externalSystemId: K3_SYSTEM }, 'project_out_of_scope', 'scope does not cross bindings')

  // `no_entry` cannot name an entry it did not find.
  const noEntry = captured(() => check(registry, { tenantId: OTHER_TENANT }))
  assert.equal('entryIds' in noEntry.details, false)
  assert.equal('candidateEntryIds' in noEntry.details, false)
}

// systemKind, when an entry pins one, is a second lock on the binding — an entry approved for a
// read-only SQL source must not authorize the same id after it is repointed at another adapter kind.
function systemKindPinsTheBindingWhenDeclared() {
  const pinned = build([entry({ sourceBinding: { externalSystemId: PLM_SYSTEM, systemKind: SYSTEM_KIND } })])
  assert.ok(check(pinned), 'the pinned kind matches')
  assertRefusal(pinned, { systemKind: 'bridge:legacy-sql-readonly' }, 'no_entry', 'a repointed adapter kind is not covered')
  assertRefusal(pinned, { systemKind: undefined }, 'no_entry', 'an unresolved kind does not satisfy a pin')

  // Omitted: the entry does not care which adapter kind serves the id.
  const unpinned = build([entry()])
  assert.ok(check(unpinned, { systemKind: 'bridge:legacy-sql-readonly' }))
  assert.ok(check(unpinned, { systemKind: undefined }))
}

// WHAT forbidReuse ACTUALLY ENFORCES. A `purpose` is the identity of a CALL SITE — a frozen constant
// at every call site, never request-derived — so a SECOND consumer reaching for the same narrow
// binding presents a different purpose and is refused even though tenant, system and project all
// match. That is the mechanically enforceable core of "禁止被其他应用复用".
function forbidReuseBindsAnEntryToOneConsumer() {
  assert.deepEqual([...B2A_PURPOSES], [
    B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
    B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
    B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
  ])

  const locked = build([entry({ forbidReuse: true, purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION })])
  assert.equal(check(locked).forbidReuse, true)
  for (const other of [B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST, B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM]) {
    const error = assertRefusal(locked, { purpose: other }, 'purpose_not_permitted', `reuse by ${other} is refused`)
    assert.equal(error.details.forbidReuse, true)
    assert.deepEqual(error.details.candidateEntryIds, ['b2a-factory-a-plm'])
  }

  // forbidReuse:true without a purpose is meaningless, so it is refused at LOAD rather than silently
  // degrading to a wildcard.
  assertConfigThrow([entry({ forbidReuse: true, purpose: undefined })], 'forbidReuse without a purpose is refused')

  // The explicit, reviewable opposite: a SHARED registration. It has to be written down —
  // `forbidReuse: false` AND an omitted purpose — rather than defaulted into.
  const shared = build([entry({ entryId: 'b2a-shared', forbidReuse: false, purpose: undefined })])
  for (const purpose of B2A_PURPOSES) {
    assert.equal(check(shared, { purpose }).entryId, 'b2a-shared', `a shared entry serves ${purpose}`)
  }
  assert.equal(check(shared).forbidReuse, false)

  // A purpose OUTSIDE the closed vocabulary is refused even against a shared entry. This is
  // unreachable from a request (purposes are module constants); it exists so that ADDING a call site
  // without declaring one fails loudly instead of inheriting somebody else's registration.
  assertRefusal(shared, { purpose: 'some.new.read.path' }, 'unknown_purpose', 'an undeclared call site is refused')
  assertRefusal(shared, { purpose: undefined }, 'unknown_purpose', 'a call site with no purpose is refused')
  assertConfigThrow([entry({ purpose: 'some.new.read.path' })], 'an unrecognized purpose is refused at load')

  // A per-purpose registration set: two locked entries on the SAME binding, each serving only its
  // own consumer. This is the shape a deployment must write when it wants two call sites — a
  // reviewable act, which is the point. What this module does NOT claim: it cannot stop a human
  // ADDING that second entry. The file is a reviewed artifact; that is a review control.
  const perPurpose = build([
    entry({ entryId: 'b2a-refresh', purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION }),
    entry({ entryId: 'b2a-mvp', purpose: B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST }),
  ])
  assert.equal(check(perPurpose).entryId, 'b2a-refresh')
  assert.equal(check(perPurpose, { purpose: B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST }).entryId, 'b2a-mvp')
  assertRefusal(perPurpose, { purpose: B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM }, 'purpose_not_permitted', 'the third consumer is still refused')
}

function anUnderSpecifiedCallIsRefused() {
  const registry = build([entry()])
  for (const [field, label] of [['tenantId', 'tenantResolved'], ['externalSystemId', 'sourceSystemResolved'], ['projectNo', 'projectResolved']]) {
    const error = assertRefusal(registry, { [field]: undefined }, 'missing_scope', `a missing ${field} refuses`)
    assert.equal(error.details[label], false, `${label} is reported as unresolved`)
    assertRefusal(registry, { [field]: '   ' }, 'missing_scope', `a blank ${field} refuses`)
  }
}

// A caller that reaches the gate with something that is not a built registry must never fall through
// to "allow". It is not a refusable caller either — it is a wiring bug.
function aMalformedRegistryAtCheckTimeIsFailClosed() {
  for (const bogus of [{}, { registryId: 'r' }, { entries: [] }, 'registry', 7, true, []]) {
    const error = captured(() => assertB2aTrialAuthorized({ registry: bogus, tenantId: TENANT, projectNo: IN_SCOPE_PROJECT, now: NOW }))
    assert.ok(error, `${JSON.stringify(bogus)} must not be accepted as a registry`)
    assert.equal(error.code, 'B2A_TRIAL_REGISTRY_INVALID')
    assert.equal(error.status, 500)
  }
}

// When several live entries authorize the same call, evidence must name the NARROWEST authorization
// in force rather than an arbitrary one — deterministically, so the stanza is reproducible.
function theSoonestExpiringLiveEntryWins() {
  const registry = build([
    entry({ entryId: 'b2a-long', forbidReuse: false, purpose: undefined, expiresAt: iso(T0 + 90 * DAY_MS) }),
    entry({ entryId: 'b2a-short', forbidReuse: false, purpose: undefined, expiresAt: iso(T0 + 30 * DAY_MS) }),
  ])
  assert.equal(check(registry).entryId, 'b2a-short')
  // Stable under input order.
  const reversed = build([
    entry({ entryId: 'b2a-short', forbidReuse: false, purpose: undefined, expiresAt: iso(T0 + 30 * DAY_MS) }),
    entry({ entryId: 'b2a-long', forbidReuse: false, purpose: undefined, expiresAt: iso(T0 + 90 * DAY_MS) }),
  ])
  assert.equal(check(reversed).entryId, 'b2a-short')

  // An EXPIRED entry alongside a live one does not poison the live one.
  const mixed = build([
    entry({ entryId: 'b2a-stale', forbidReuse: false, purpose: undefined, effectiveAt: iso(T0), expiresAt: iso(T0 + DAY_MS) }),
    entry({ entryId: 'b2a-live', forbidReuse: false, purpose: undefined, effectiveAt: iso(T0), expiresAt: iso(T0 + 60 * DAY_MS) }),
  ])
  assert.equal(check(mixed).entryId, 'b2a-live')
}

function theBuiltRegistryIsImmutable() {
  const registry = build([entry()])
  assert.ok(Object.isFrozen(registry))
  assert.ok(Object.isFrozen(registry.entries))
  assert.ok(Object.isFrozen(registry.entries[0]))
  assert.ok(Object.isFrozen(registry.entries[0].projectScope.projectNos))
  // A mutation attempt must not widen the scope.
  try { registry.entries[0].projectScope.projectNos.push(OUT_OF_SCOPE_PROJECT) } catch { /* frozen */ }
  assertRefusal(registry, { projectNo: OUT_OF_SCOPE_PROJECT }, 'project_out_of_scope', 'a frozen scope cannot be widened in place')

  // The registry does not alias the caller's config object either: mutating the source after the
  // build must not change what the gate enforces.
  const config = { [B2A_TRIAL_REGISTRY_CONFIG_KEY]: registryConfig([entry()]) }
  const built = createB2aTrialRegistry({ config })
  config[B2A_TRIAL_REGISTRY_CONFIG_KEY].entries[0].projectScope.projectNos.push(OUT_OF_SCOPE_PROJECT)
  assertRefusal(built, { projectNo: OUT_OF_SCOPE_PROJECT }, 'project_out_of_scope', 'a post-build config mutation does not reach the gate')
}

const TESTS = [
  dormantWhenTheKeyIsAbsent,
  switchingItOffFromInsideTheFileIsRefused,
  registryEnvelopeIsValidated,
  everyRegisteredFieldIsRequired,
  theSourceBindingIsMandatory,
  theProjectScopeMustEnumerate,
  timestampsAreStrictIsoAndAgreeWithTheProductionPolicyParser,
  theWindowIsBounded,
  expiryIsCheckedAtCheckTimeNotLoadTime,
  aMatchingEntryPasses,
  theEntryIsScopedOnAllFourDimensions,
  systemKindPinsTheBindingWhenDeclared,
  forbidReuseBindsAnEntryToOneConsumer,
  anUnderSpecifiedCallIsRefused,
  aMalformedRegistryAtCheckTimeIsFailClosed,
  theSoonestExpiringLiveEntryWins,
  theBuiltRegistryIsImmutable,
]

for (const test of TESTS) {
  test()
  process.stdout.write(`  ${test.name} OK\n`)
}
process.stdout.write('b2a-trial-registry.test.cjs OK\n')
