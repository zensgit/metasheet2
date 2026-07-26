'use strict'

// gip-canonical-object-contract-registry.cjs — plain node test, hermetic.
// Proves: the shipped default registry is empty; entries are supplied ONLY
// at construction (P3-b, review round 2 — no register()/add() verb exists
// anywhere on a built registry, under any name, mirroring
// gip-connector-kind-registry.cjs's already-audited structural shape);
// duplicate (contractId, version) within one entries array is refused, even
// with byte-identical content (append-only immutability, now proven at
// construction time rather than across repeated runtime calls); an
// unregistered lookup fails closed by name and does NOT auto-vivify an
// entry; and the activation gate refuses to report "ready" both when no
// inventory has been supplied AND when one has been supplied but leaves
// references unbacked — with a positive control proving the gate is not
// merely all-refusing.
//
// P1-1/P1-3/P2 FIXES (owner HARD HOLD #4610): createCanonicalObjectContractRegistry
// no longer grants trust just by being called (mirrors
// gip-connector-kind-registry.cjs's sibling fix) — MECHANISM tests below
// (declaration/append-only/lookup behavior) therefore call `.lookup()`
// DIRECTLY on registries this test builds, never through the trust-gated
// resolveCanonicalObjectContractVersion, and a dedicated test reproduces the
// owner's exact "call the exported factory, get a trusted object" probe.
// assertCanonicalObjectContractRegistryActivationReady now requires a
// server-attested inventoryReport (object identity, module-private
// construction) instead of accepting any caller-shaped plain object — a
// dedicated test reproduces the owner's exact
// `{ inventoryStatus: 'COMPLETE', references: [] }` probe and proves it now
// refuses; the blocked/ready mechanics themselves (which can no longer be
// reached through the gate from outside this module, since nothing can
// produce a trusted attestation from a test file) are proven directly
// against the pure __internals.computeActivationReadiness helper. Contract
// `fields` is now a deep, recursively-frozen OWNED clone
// (deepCloneFrozenCanonical) rather than a shallow copy+freeze — a dedicated
// test proves a retained nested reference can no longer mutate a registered
// version after the fact.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  createCanonicalObjectContractRegistry,
  resolveCanonicalObjectContractVersion,
  assertCanonicalObjectContractRegistryActivationReady,
  CANONICAL_OBJECT_CONTRACT_REGISTRY,
  GipCanonicalObjectContractError,
  CANONICAL_OBJECT_CONTRACT_ERROR_REASONS,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'gip-canonical-object-contract-registry.cjs'))

function rejects(fn, reason, message) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught instanceof GipCanonicalObjectContractError, `${message} — expected GipCanonicalObjectContractError`)
  assert.equal(caught.reason, reason, `${message} — expected reason ${reason}, got ${caught && caught.reason}`)
  return caught
}

// ---------------------------------------------------------------------------
// (1) Shipped default registry is EMPTY.
// ---------------------------------------------------------------------------
function defaultRegistryIsEmpty() {
  assert.equal(CANONICAL_OBJECT_CONTRACT_REGISTRY.size(), 0, 'shipped registry must be empty — no contract registered yet')
  rejects(
    () => resolveCanonicalObjectContractVersion(CANONICAL_OBJECT_CONTRACT_REGISTRY, 'bom_line', 'v1'),
    'CANONICAL_OBJECT_CONTRACT_UNREGISTERED',
    'default registry must refuse any lookup',
  )
}

// ---------------------------------------------------------------------------
// (2) STRUCTURAL shape (P3-b fix): lookup/size ONLY — exact key set, on BOTH
// a freshly constructed registry AND the exported singleton itself, the same
// technique as the connector-kind registry and the qualification prober's
// residual-1 predicate. No register/add/set verb exists anywhere, under any
// name — this is what makes the registry closed STRUCTURALLY, not just by a
// comment's claim (the defect this review round closed: the prior shape
// exposed .register() on the frozen singleton, reachable by any importer at
// any time).
// ---------------------------------------------------------------------------
function exactKeySet() {
  const registry = createCanonicalObjectContractRegistry([])
  assert.deepEqual(Object.keys(registry).sort(), ['lookup', 'size'], 'a freshly built registry must expose exactly lookup()/size()')
  assert.ok(Object.isFrozen(registry))

  // The SHIPPED SINGLETON specifically — not merely "some registry built by
  // the factory" — must also carry no register verb. This is the exact gap
  // the review named: any future module importing CANONICAL_OBJECT_CONTRACT_REGISTRY
  // could otherwise call .register() on it directly, at runtime, from
  // anywhere, entirely bypassing the "separately-reviewed amendment" process.
  assert.deepEqual(Object.keys(CANONICAL_OBJECT_CONTRACT_REGISTRY).sort(), ['lookup', 'size'])
  assert.equal(typeof CANONICAL_OBJECT_CONTRACT_REGISTRY.register, 'undefined', 'the shipped singleton must not carry a register verb under any name')
}

// ---------------------------------------------------------------------------
// (3) Positive control (MECHANISM, not trust): entries supplied at
// construction round-trip through lookup. createCanonicalObjectContractRegistry's
// output is UNTRUSTED (P1-1 fix) — lookup()/size() work identically
// regardless of trust, so this is tested via `.lookup()` DIRECTLY, never
// through the trust-gated resolveCanonicalObjectContractVersion. Trust-gate
// behavior itself is proven separately below
// (forgedRegistryViaExportedFactoryIsRefused).
// ---------------------------------------------------------------------------
function positiveControlConstructAndLookup() {
  const registry = createCanonicalObjectContractRegistry([
    { contractId: 'bom_line', version: 'v1', fields: { materialCode: true } },
  ])
  const found = registry.lookup('bom_line', 'v1')
  assert.ok(found, 'a registered entry must resolve via the object\'s own lookup()')
  assert.equal(found.contractId, 'bom_line')
  assert.equal(found.version, 'v1')
  assert.deepEqual(found.fields, { materialCode: true })
  assert.ok(Object.isFrozen(found))
  assert.ok(Object.isFrozen(found.fields))
}

// ---------------------------------------------------------------------------
// (3b) P1-1 FIX (owner HARD HOLD #4610) — mirrors
// gip-connector-kind-registry.test.cjs's forgedRegistryViaExportedFactoryIsRefused
// exactly: registering a contract via the still-exported
// createCanonicalObjectContractRegistry factory must NOT pass the trust
// gate. Before this fix, the factory unconditionally added its output to the
// module-private trust WeakSet.
// ---------------------------------------------------------------------------
function forgedRegistryViaExportedFactoryIsRefused() {
  const forged = createCanonicalObjectContractRegistry([
    { contractId: 'bom_line', version: 'v1', fields: { materialCode: true } },
  ])
  assert.ok(forged.lookup('bom_line', 'v1'), 'sanity: the forged registry must be well-formed and resolve its own entry via .lookup()')

  const caught = rejects(
    () => resolveCanonicalObjectContractVersion(forged, 'bom_line', 'v1'),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a registry built via the exported factory must be refused by the trust gate, exactly like a duck-typed forgery',
  )
  assert.equal(caught.details.field, 'registry')

  // Contrast with the genuine trusted singleton: it passes the trust gate
  // (reaches "unregistered", never "untrusted").
  rejects(
    () => resolveCanonicalObjectContractVersion(CANONICAL_OBJECT_CONTRACT_REGISTRY, 'bom_line', 'v1'),
    'CANONICAL_OBJECT_CONTRACT_UNREGISTERED',
    'the genuine trusted singleton must pass the trust gate (fail at lookup, not at trust)',
  )
}

// ---------------------------------------------------------------------------
// (4) Append-only immutability: two entries for the SAME (contractId,
// version) within one entries array are refused — even with byte-identical
// fields — re-declaration itself is the defect, not just a duplicate. A
// DIFFERENT version for the same contractId is a legal, separate append.
// MECHANISM-level (`.lookup()` direct), same rationale as (3) above.
// ---------------------------------------------------------------------------
function appendOnlyImmutability() {
  rejects(
    () => createCanonicalObjectContractRegistry([
      { contractId: 'bom_line', version: 'v1', fields: { materialCode: true } },
      { contractId: 'bom_line', version: 'v1', fields: { materialCode: true } },
    ]),
    'CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE',
    'duplicate (contractId, version) within one entries array must be refused',
  )
  rejects(
    () => createCanonicalObjectContractRegistry([
      { contractId: 'bom_line', version: 'v1', fields: { materialCode: true } },
      { contractId: 'bom_line', version: 'v1', fields: { materialCode: false } },
    ]),
    'CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE',
    'duplicate (contractId, version) with DIFFERENT fields must still be refused (never edited)',
  )

  // v2 for the same contractId is a legal, separate append — v1 stays intact.
  const registry = createCanonicalObjectContractRegistry([
    { contractId: 'bom_line', version: 'v1', fields: { materialCode: true } },
    { contractId: 'bom_line', version: 'v2', fields: { materialCode: true, uom: true } },
  ])
  assert.equal(registry.size(), 2)
  const v1Still = registry.lookup('bom_line', 'v1')
  assert.deepEqual(v1Still.fields, { materialCode: true }, 'v1 must remain exactly as first declared')
}

// ---------------------------------------------------------------------------
// (5) No auto-vivification: two consecutive misses on the SAME (contractId,
// version) leave size() unchanged and both return null — proves lookup never
// silently creates an entry on first miss. MECHANISM-level (`.lookup()`
// direct); the CERTIFIED singleton's own miss-throws-UNREGISTERED behavior
// is already covered by defaultRegistryIsEmpty above.
// ---------------------------------------------------------------------------
function noAutoVivification() {
  const registry = createCanonicalObjectContractRegistry([])
  const before = registry.size()
  assert.equal(registry.lookup('ghost', 'v1'), null, 'first miss')
  assert.equal(registry.lookup('ghost', 'v1'), null, 'second miss')
  assert.equal(registry.size(), before, 'size must not change across repeated misses')
}

// ---------------------------------------------------------------------------
// (6) Malformed entries refused at construction time.
// ---------------------------------------------------------------------------
function malformedEntriesRefused() {
  rejects(() => createCanonicalObjectContractRegistry([{ contractId: '', version: 'v1', fields: { a: true } }]), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'empty contractId')
  rejects(() => createCanonicalObjectContractRegistry([{ contractId: 'bom_line', version: '', fields: { a: true } }]), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'empty version')
  rejects(() => createCanonicalObjectContractRegistry([{ contractId: 'bom_line', version: 'v1', fields: {} }]), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'empty fields object')
  rejects(() => createCanonicalObjectContractRegistry([{ contractId: 'bom_line', version: 'v1', fields: null }]), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'null fields')
  rejects(() => createCanonicalObjectContractRegistry([{ contractId: 'bom_line', version: 'v1', fields: ['not', 'an', 'object'] }]), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'array fields')
  rejects(() => createCanonicalObjectContractRegistry('not-an-array'), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'entries must be an array')
  rejects(() => createCanonicalObjectContractRegistry([42]), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'a non-plain-object entry must be refused')
  rejects(
    () => resolveCanonicalObjectContractVersion({ lookup: () => null, register: () => {}, size: () => 0 }, 'bom_line', 'v1'),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a duck-typed non-trusted registry must be refused, even one that ADDS BACK a register() to look legitimate',
  )
}

// ---------------------------------------------------------------------------
// (6b) P2 FIX (owner HARD HOLD #4610) — REPRODUCES THE OWNER'S EXACT PROBE:
// `fields` used to be only shallow-copied + shallow-frozen, so a retained
// reference to a NESTED structure inside `fields` let a caller mutate a
// registered version's content after registration. Owner measured
// `nestedFrozen: false`, `registeredVersionChanged: true`. Now fixed via
// deepCloneFrozenCanonical (an owned, recursively-frozen clone) — this test
// mutates the ORIGINAL nested structure after registration and proves the
// registered version is unaffected, per the ledger's §3.1 ⟲R2 mandate.
// ---------------------------------------------------------------------------
function nestedFieldsAreDeeplyFrozenAndOwned() {
  const originalFields = { materialCode: true, nested: { level: 1, deeper: { value: 'x' } }, list: [{ a: 1 }] }
  const registry = createCanonicalObjectContractRegistry([
    { contractId: 'bom_line', version: 'v1', fields: originalFields },
  ])

  // Mutate the ORIGINAL nested structure — the exact owner construction.
  originalFields.nested.level = 999
  originalFields.nested.deeper.value = 'TAMPERED'
  originalFields.list[0].a = 999
  originalFields.list.push({ a: 'injected' })

  const registered = registry.lookup('bom_line', 'v1')
  assert.equal(registered.fields.nested.level, 1, 'a mutation to the original nested object after registration must not reach the registered version')
  assert.equal(registered.fields.nested.deeper.value, 'x', 'a mutation two levels deep must not reach the registered version')
  assert.equal(registered.fields.list[0].a, 1, 'a mutation to an array-element object must not reach the registered version')
  assert.equal(registered.fields.list.length, 1, 'pushing to the original array must not reach the registered version')

  // Structural proof, not just value proof: every nested level is genuinely frozen.
  assert.ok(Object.isFrozen(registered.fields), 'top-level fields must be frozen')
  assert.ok(Object.isFrozen(registered.fields.nested), 'nested object must be frozen')
  assert.ok(Object.isFrozen(registered.fields.nested.deeper), 'doubly-nested object must be frozen')
  assert.ok(Object.isFrozen(registered.fields.list), 'nested array must be frozen')
  assert.ok(Object.isFrozen(registered.fields.list[0]), 'nested array element object must be frozen')

  // Direct mutation attempts on the registered copy itself must also be no-ops
  // (or throw in strict mode) — never silently succeed.
  assert.throws(() => { registered.fields.nested.level = 12345 }, 'assigning into a frozen nested object must throw in strict mode')

  // Non-canonical fields (e.g. a function or undefined value) must be refused
  // at registration, not silently dropped or coerced.
  rejects(
    () => createCanonicalObjectContractRegistry([{ contractId: 'bad', version: 'v1', fields: { fn: () => {} } }]),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a fields value outside the strict canonical JSON domain must be refused',
  )
}

// ---------------------------------------------------------------------------
// (7) Activation gate — P1-3 FIX (owner HARD HOLD #4610). REPRODUCES THE
// OWNER'S EXACT PROBE: a caller-supplied plain object
// `{ inventoryStatus: 'COMPLETE', references: [] }` — exactly the shape and
// exact values the owner quoted — must now be refused, never read as
// "ready". This subsumes the pre-fix "fail-OPEN empty array" concern: EVERY
// caller-shaped object is refused as UNATTESTED before its inventoryStatus
// or references are ever inspected, because nothing in this test file (or
// anywhere reachable via require()) can produce a trusted attestation —
// buildInventoryAttestation is module-private and has no call site in the
// shipped module.
// ---------------------------------------------------------------------------
function activationGateRefusesCallerAssertedEvidence() {
  // Uses the GENUINE trusted singleton (assertTrustedRegistry must pass, so
  // the assertion below is really discriminating on the INVENTORY gate, not
  // incidentally tripping the registry-trust gate first).
  const registry = CANONICAL_OBJECT_CONTRACT_REGISTRY

  // The owner's EXACT construction.
  rejects(
    () => assertCanonicalObjectContractRegistryActivationReady(registry, { inventoryStatus: 'COMPLETE', references: [] }),
    'CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED',
    'owner\'s exact probe — a caller-asserted COMPLETE status with empty references — must be refused as unattested, not read as ready',
  )
  // A plausible-looking, fully-backed caller object must ALSO be refused —
  // proves the gate checks EVIDENCE PROVENANCE, not merely content shape.
  rejects(
    () => assertCanonicalObjectContractRegistryActivationReady(registry, {
      inventoryStatus: 'COMPLETE',
      references: [{ contractId: 'bom_line', version: 'v1' }],
    }),
    'CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED',
    'a caller-supplied object claiming full backing must still be refused — content alone is never evidence',
  )
  // No inventoryStatus at all, and explicit NOT_RUN — both are ALSO plain
  // caller objects, so both hit the SAME new gate first.
  rejects(
    () => assertCanonicalObjectContractRegistryActivationReady(registry, { references: [] }),
    'CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED',
    'a missing inventoryStatus is refused as unattested (it is a plain object, never attested evidence)',
  )
  rejects(
    () => assertCanonicalObjectContractRegistryActivationReady(registry, { inventoryStatus: 'NOT_RUN', references: [] }),
    'CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED',
    'an explicit NOT_RUN plain object is refused as unattested too',
  )
  // Non-object / null inputs must also be refused by the SAME gate (WeakSet.has
  // on a primitive returns false, never throws) — never reach a TypeError.
  for (const bad of [null, undefined, 'COMPLETE', 42, []]) {
    rejects(
      () => assertCanonicalObjectContractRegistryActivationReady(registry, bad),
      'CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED',
      `non-object inventoryReport (${JSON.stringify(bad)}) must be refused as unattested, not throw a TypeError`,
    )
  }
}

// ---------------------------------------------------------------------------
// (7b) The BLOCKED/READY mechanics themselves — no longer reachable through
// the gate from a test file (nothing can produce a trusted attestation
// outside this module), so proven directly against the pure
// __internals.computeActivationReadiness helper, which confers no trust and
// is exactly what assertCanonicalObjectContractRegistryActivationReady calls
// once trust is established. The fail-OPEN trap this line has shipped before
// (an empty references array reading as "clean") is preserved here at the
// mechanism level: zero references is legitimately ready (there is nothing
// to be unbacked), which is DIFFERENT from zero EVIDENCE (the (7) tests
// above).
// ---------------------------------------------------------------------------
function activationReadinessMechanism() {
  const registry = createCanonicalObjectContractRegistry([
    { contractId: 'bom_line', version: 'v1', fields: { materialCode: true } },
  ])

  // Unbacked reference — ACTIVATION_BLOCKED, counts only, values-free.
  const blocked = rejects(
    () => __internals.computeActivationReadiness(registry, [
      { contractId: 'bom_line', version: 'v1' },
      { contractId: 'bom_line', version: 'v9' },
      { contractId: 'material', version: 'v1' },
    ]),
    'CANONICAL_OBJECT_CONTRACT_ACTIVATION_BLOCKED',
    'unbacked references must refuse',
  )
  assert.deepEqual(blocked.details, { unbackedCount: 2, backedCount: 1, totalReferences: 3 })
  const serializedError = blocked.message + JSON.stringify(blocked.details)
  assert.ok(!serializedError.includes('bom_line') && !serializedError.includes('material'), 'activation-blocked error must be values-free')

  // POSITIVE CONTROL — fully-backed references report ready. Without this,
  // an all-refusing mechanism would also pass the blocked case above.
  const ready = __internals.computeActivationReadiness(registry, [{ contractId: 'bom_line', version: 'v1' }])
  assert.deepEqual(ready, { ready: true, backedCount: 1, totalReferences: 1 })

  // Zero references is legitimately ready (nothing to be unbacked).
  const readyEmpty = __internals.computeActivationReadiness(registry, [])
  assert.deepEqual(readyEmpty, { ready: true, backedCount: 0, totalReferences: 0 })
}

// ---------------------------------------------------------------------------
// (8) P2 FIX (review round 4 — blocking): __internals's own key set was never
// pinned in this file — the same gap gip-connector-kind-registry.test.cjs had
// (see that file's matching fix note). A junk key added under __internals, or
// — decisively — RE-EXPORTING this module's private module-scope trust
// WeakSet through __internals (the exact regression the module's own header
// comment says is closed by staying unexported) both passed silently before
// this test existed. (Deliberately not naming the private WeakSet's
// identifier in this comment or a fixture — doing so would itself add a hit
// to a `grep -rn` over __tests__ that this PR's body cites as returning
// zero — see the sibling file's matching note.)
// ---------------------------------------------------------------------------
function internalsExactKeySet() {
  assert.deepEqual(
    Object.keys(__internals).sort(),
    ['computeActivationReadiness', 'fail', 'hasControlCharacter', 'normalizeContractEntry', 'requiredIdentityToken'],
    '__internals must expose exactly this key set — in particular, the module-private trust WeakSets (registries AND inventory attestations) must never be re-exported under any name, and buildInventoryAttestation must never appear here either',
  )
}

// ---------------------------------------------------------------------------
// (9) Vocabulary discipline.
// ---------------------------------------------------------------------------
function frozenVocabularyIsExhaustive() {
  assert.deepEqual(
    [...CANONICAL_OBJECT_CONTRACT_ERROR_REASONS].sort(),
    [
      'CANONICAL_OBJECT_CONTRACT_ACTIVATION_BLOCKED',
      'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
      'CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT',
      'CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED',
      'CANONICAL_OBJECT_CONTRACT_UNREGISTERED',
      'CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE',
    ],
  )
  assert.ok(Object.isFrozen(CANONICAL_OBJECT_CONTRACT_ERROR_REASONS))
}

function main() {
  defaultRegistryIsEmpty()
  exactKeySet()
  positiveControlConstructAndLookup()
  forgedRegistryViaExportedFactoryIsRefused()
  appendOnlyImmutability()
  noAutoVivification()
  malformedEntriesRefused()
  nestedFieldsAreDeeplyFrozenAndOwned()
  activationGateRefusesCallerAssertedEvidence()
  activationReadinessMechanism()
  internalsExactKeySet()
  frozenVocabularyIsExhaustive()
  console.log('gip-canonical-object-contract-registry.test.cjs OK')
}

main()
