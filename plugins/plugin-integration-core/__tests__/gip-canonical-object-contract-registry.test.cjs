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
// (6b) P3 FIX (owner HARD HOLD #4610 residual, round 6) — TOCTOU on
// entry.fields. Pre-fix, normalizeContractEntry read `entry.fields` THREE
// times (isPlainObject check, Object.keys().length check,
// deepCloneFrozenCanonical). A getter returning `{a:1}` on its first two
// reads and `{}` on its third would pass the non-empty check on reads 1-2
// and then register the EMPTY value read on read 3 — reproducing exactly
// `{"contractId":"c","version":"v","fields":{}}`, an empty fields object
// past the guard meant to refuse it. Reading the property ONCE into a local
// closes the window. This test discriminates precisely: on the OLD
// (unfixed) code, `reads` ends at 3 and the registered fields is `{}`; on
// the FIXED code, `reads` ends at 1 and the registered fields is the SAME
// non-empty value that passed validation.
// ---------------------------------------------------------------------------
function fieldsToctouGetterCannotBypassNonEmptyCheck() {
  let reads = 0
  const hostile = {
    contractId: 'c',
    version: 'v',
    get fields() {
      reads += 1
      return reads <= 2 ? { a: 1 } : {}
    },
  }
  const registry = createCanonicalObjectContractRegistry([hostile])
  const registered = registry.lookup('c', 'v')
  assert.ok(registered, 'sanity: entry must register — fields WAS non-empty on the single read that validation observed')
  assert.deepEqual(registered.fields, { a: 1 }, 'registered fields must be the SAME non-empty value that was validated, never a later, different (empty) read of the same getter')
  assert.equal(reads, 1, 'entry.fields must be read exactly ONCE — no TOCTOU window between validation and use')
}

// ---------------------------------------------------------------------------
// (6c) P1 FIX (owner HARD HOLD #4610, round 7 — RAW-CONTRACT-ID): a hostile
// GETTER on entry.contractId, entry.version, or entry.fields must never
// escape this module as a raw foreign error — it must be discarded and
// replaced with GipCanonicalObjectContractError, the SAME contract every
// other reachable throw in this module now explicitly states (module
// header's "CLOSED ERROR CONTRACT" paragraph). Proves values-free too: the
// raw marker text must never leak into the branded error's message, details,
// OR stack — a branded-but-message-echoing error would pass a class/reason
// check but still be the leak the owner is describing.
// ---------------------------------------------------------------------------
function hostileGetterOnContractIdVersionOrFieldsNeverEscapesRaw() {
  for (const field of ['contractId', 'version', 'fields']) {
    const marker = `RAW-CONTRACT-ID-MARKER-${field}`
    const base = { contractId: 'c', version: 'v1', fields: { a: 1 } }
    delete base[field]
    Object.defineProperty(base, field, {
      enumerable: true,
      configurable: true,
      get() { throw new TypeError(marker) },
    })
    const caught = rejects(
      () => createCanonicalObjectContractRegistry([base]),
      'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
      `a hostile getter on ${field} must be discarded and converted to GipCanonicalObjectContractError, never escape as a raw foreign error`,
    )
    assert.equal(caught.details.field, field)
    const serialized = String(caught.message) + JSON.stringify(caught.details) + String(caught.stack)
    assert.ok(!serialized.includes(marker), `the raw marker text must never leak into the branded error (message/details/stack) for ${field}`)
  }
}

// ---------------------------------------------------------------------------
// (6d) P1 FIX (owner HARD HOLD #4610, round 7 — RAW-OWN-KEYS): a hostile
// `ownKeys` trap on a Proxy passed as `fields` throws DURING ENUMERATION
// itself (`Object.keys(proxy)`) — guarding the property READ of entry.fields
// (6c above) is not enough, because the Proxy object itself is a perfectly
// valid read result; the ENUMERATION of that value must be guarded
// separately. A Proxy whose target is a plain, non-array object passes
// isPlainObject cleanly (typeof/Array.isArray both resolve against the
// target without invoking a trap) — only Object.keys's ownKeys trap exposes
// the hostility.
// ---------------------------------------------------------------------------
function hostileOwnKeysTrapOnFieldsNeverEscapesRaw() {
  const marker = 'RAW-OWN-KEYS-MARKER'
  const hostileFields = new Proxy({ a: 1 }, {
    ownKeys() { throw new TypeError(marker) },
  })
  const caught = rejects(
    () => createCanonicalObjectContractRegistry([{ contractId: 'c', version: 'v1', fields: hostileFields }]),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a hostile ownKeys trap on fields must be discarded and converted to GipCanonicalObjectContractError, never escape as a raw foreign error',
  )
  assert.equal(caught.details.field, 'fields')
  const serialized = String(caught.message) + JSON.stringify(caught.details) + String(caught.stack)
  assert.ok(!serialized.includes(marker), 'the raw marker text must never leak into the branded error')

  // Non-regression: the isPlainObject short-circuit for a non-object fields
  // value must still fire FIRST, without ever attempting enumeration — only
  // a Proxy can make Object.keys itself throw; null must still hit the
  // ORIGINAL "must be a non-empty plain object" reason.
  //
  // ROUND 8 FIX (owner HARD HOLD #4610 — closing a review-round-7 vacuous
  // assertion): the check below used to assert ONLY the reason token
  // (CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID) returned by `rejects()`
  // — but BOTH the isPlainObject short-circuit above AND the enumeration
  // try/catch's own failure branch emit that SAME reason token; only their
  // `message` text differs ("fields must be a non-empty plain object" vs
  // "fields could not be enumerated"). A reason-only check cannot
  // discriminate which of the two guards actually fired. Measured directly:
  // moving the isPlainObject short-circuit to AFTER the Object.keys
  // try/catch (so `fields: null` reaches `Object.keys(null)`, which throws,
  // routing it into the enumeration guard's catch instead) left the
  // reason-only assertion passing, while `caught.message` had silently
  // become "fields could not be enumerated" — the pin's own named claim
  // ("must still hit the ORIGINAL ... reason, not the enumeration guard")
  // was false on the code as it stood. (`fields: []` — the pre-existing
  // "array fields" case in malformedEntriesRefused — does NOT discriminate
  // this mutation either: `Object.keys([])` does not throw, so that case is
  // caught only by the SAME, now-relocated isPlainObject check running
  // later in the function — door-level cover, not a pin on this specific
  // ordering.) Asserting the MESSAGE, not just the reason, closes the gap.
  const caughtNull = rejects(
    () => createCanonicalObjectContractRegistry([{ contractId: 'c', version: 'v1', fields: null }]),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'null fields must still be refused by the isPlainObject short-circuit, not the enumeration guard',
  )
  assert.equal(
    caughtNull.message,
    'fields must be a non-empty plain object',
    'null fields must produce the ORIGINAL isPlainObject short-circuit MESSAGE — the reason token alone is shared by the enumeration-guard failure path and does not discriminate between the two',
  )
}

// ---------------------------------------------------------------------------
// (6e) P1 FIX (owner HARD HOLD #4610, round 7 — RAW-CANONICAL-ITERATOR): the
// `entries` array's ITERATION is attacker-reachable — a hostile accessor at
// one index (Object.defineProperty), or a hostile Symbol.iterator assigned
// as an own property of a genuine array — neither breaks Array.isArray. Both
// must never escape a raw foreign error. The Symbol.iterator variant
// additionally proves the fix is STRUCTURAL, not merely a catch: the guarded
// length+index loop never invokes the iterator protocol at all, so the
// hostile Symbol.iterator is simply never CALLED (registration succeeds
// normally) rather than merely having its throw caught.
// ---------------------------------------------------------------------------
function hostileEntriesIteratorNeverEscapesRaw() {
  const marker = 'RAW-CANONICAL-ITERATOR-MARKER'
  const validEntry = { contractId: 'c', version: 'v1', fields: { a: 1 } }

  const indexHostile = [validEntry]
  Object.defineProperty(indexHostile, 1, {
    enumerable: true,
    configurable: true,
    get() { throw new TypeError(marker) },
  })
  indexHostile.length = 2
  const caught = rejects(
    () => createCanonicalObjectContractRegistry(indexHostile),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a hostile getter at one entries index must be discarded and converted, never escape as a raw foreign error',
  )
  assert.equal(caught.details.field, 'entries')
  const serialized = String(caught.message) + JSON.stringify(caught.details) + String(caught.stack)
  assert.ok(!serialized.includes(marker), 'the raw marker text must never leak into the branded error')

  const iteratorHostile = [validEntry]
  iteratorHostile[Symbol.iterator] = function* () { throw new TypeError(marker) }
  const registry = createCanonicalObjectContractRegistry(iteratorHostile)
  assert.equal(registry.size(), 1, 'a hostile Symbol.iterator override must not prevent registration — the guarded loop never invokes it at all')

  // (c) a Proxy WRAPPING a real array target, with a hostile `.length` trap.
  // `Array.isArray` is true for such a Proxy (the spec's IsArray walks the
  // proxy target chain without invoking any trap), so the direct-read form
  // this guard replaces (`entries.length`) would throw raw the moment the
  // length is actually read — a DIFFERENT read site than (a)'s per-index
  // getter, pinned separately so neutering readArrayLength alone (leaving
  // readArrayElement intact) also reds.
  const lengthProxyHostile = new Proxy([validEntry], {
    get(target, prop, receiver) {
      if (prop === 'length') throw new TypeError(marker)
      return Reflect.get(target, prop, receiver)
    },
  })
  const caughtLength = rejects(
    () => createCanonicalObjectContractRegistry(lengthProxyHostile),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a hostile length trap on a Proxy-wrapped entries array must be discarded, never escape as a raw foreign error',
  )
  assert.equal(caughtLength.details.field, 'entries')
  const serializedLength = String(caughtLength.message) + JSON.stringify(caughtLength.details) + String(caughtLength.stack)
  assert.ok(!serializedLength.includes(marker), 'the raw marker text must never leak into the branded error')
}

// ---------------------------------------------------------------------------
// (6f) P3-latent FIX (post-round-8 review of #4610): assertCanonicalObjectContractRegistryActivationReady's
// FIRST call — assertTrustedRegistry(registry) — had NO test that ever fed it
// an untrusted registry. Every existing (7)/(7b) test below calls this
// function with the GENUINE trusted singleton, so commenting the call out
// entirely left the full suite green (measured directly: it does — the
// inventoryReport-side gate right after it, assertTrustedInventoryAttestation,
// still refuses every caller-shaped inventoryReport those tests pass, so the
// second door covered for the first going missing). createCanonicalObjectContractRegistry
// is EXPORTED and grants no trust on its own (P1-1 fix, this same file's
// forgedRegistryViaExportedFactoryIsRefused test) — calling it here produces
// a real, well-formed, but UNTRUSTED registry, which is exactly the
// untrusted-but-genuine-shaped input this gate must still refuse. Asserts
// the reason, the `details.field` ('registry' — the SAME field name
// assertTrustedRegistry's own fail() call uses, discriminating this from the
// inventory-side UNATTESTED reason below, which never sets a `field`), and
// the message text — reason alone is not enough here for the same reason
// round 8's own caughtNull.message pin (above) was added: a message-only or
// field-only assertion could pass against a DIFFERENT guard's failure that
// happens to reuse the same reason token.
// ---------------------------------------------------------------------------
function activationGateRefusesUntrustedRegistry() {
  const untrustedRegistry = createCanonicalObjectContractRegistry([])
  const caught = rejects(
    () => assertCanonicalObjectContractRegistryActivationReady(untrustedRegistry, { inventoryStatus: 'COMPLETE', references: [] }),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'an untrusted-but-genuine registry (built via the exported factory, never granted trust) must be refused by assertTrustedRegistry before the inventoryReport is ever inspected',
  )
  assert.equal(caught.details.field, 'registry', 'the registry-trust gate must report field "registry", distinguishing it from the inventory-attestation gate below')
  assert.equal(
    caught.message,
    'a trusted canonical-object-contract registry (from createCanonicalObjectContractRegistry) is required',
    'the registry-trust gate\'s message must be the exact fixed text assertTrustedRegistry throws — a generic pass/fail check could be satisfied by an unrelated guard sharing the same reason token',
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
// (7c) P1 FIX (owner HARD HOLD #4610, round 7): __internals.computeActivationReadiness
// IS reachable from outside this module (this very test file calls it
// directly, above) — the module header's "CLOSED ERROR CONTRACT" paragraph
// therefore covers it too, unlike buildInventoryAttestation (which has ZERO
// call sites and is provably unreachable). Three foreign-call sites: the
// `references` array's ITERATION, each reference's `contractId`/`version`
// PROPERTY READS, and `registry.lookup(...)` itself (an attacker-suppliable
// FUNCTION on a duck-typed registry — this function takes no trust check on
// `registry`, by design, so a hostile registry object is squarely its own
// caller's responsibility to have excluded, but a raw throw must still never
// escape THIS function).
//
// ROUND 8 FIX (owner HARD HOLD #4610 — closing a review-round-7 overclaim):
// round 7's own commit message claimed this function's guards were "proven
// branded + values-free, then independently neutered to red (one guard at a
// time)" — true for the Symbol.iterator/contractId/lookup cases below, but
// FALSE for three of this function's OWN guarded reads: readArrayLength(references),
// readArrayElement(references, index), and readEntryField(reference, 'version')
// had NO test that set a hostile value at that SPECIFIC site — the
// Symbol.iterator case (a) below never reaches readArrayLength/readArrayElement
// at all (the guarded loop never invokes the iterator, so .length and each
// index are read normally, from a real, well-behaved array), and case (b)
// only ever probed reference.contractId, never reference.version. Measured
// directly, on the code as it stood before this fix: neutering
// `readArrayLength(references, 'references')` back to `references.length`
// ALONE left this file's full suite GREEN (rc=0); same for
// `readArrayElement(references, index, 'references')` back to
// `references[index]`; same for `readEntryField(reference, 'version')` back
// to `reference.version`. The three cases below close exactly those three
// gaps, mirroring the Proxy-`.length`-trap and index-getter fixtures
// `hostileEntriesIteratorNeverEscapesRaw` already uses for `entries`.
// ---------------------------------------------------------------------------
function computeActivationReadinessNeverEscapesRawForeignErrors() {
  const registry = createCanonicalObjectContractRegistry([
    { contractId: 'bom_line', version: 'v1', fields: { materialCode: true } },
  ])

  // (a) hostile Symbol.iterator on the references array — structural proof:
  // the guarded length+index loop never invokes the iterator protocol at
  // all, so this SUCCEEDS (the hostile iterator is simply never called)
  // rather than merely having its throw caught.
  const iteratorMarker = 'ACTIVATION-READINESS-ITERATOR-MARKER'
  const iteratorHostileRefs = [{ contractId: 'bom_line', version: 'v1' }]
  iteratorHostileRefs[Symbol.iterator] = function* () { throw new TypeError(iteratorMarker) }
  const okDespiteHostileIterator = __internals.computeActivationReadiness(registry, iteratorHostileRefs)
  assert.deepEqual(okDespiteHostileIterator, { ready: true, backedCount: 1, totalReferences: 1 }, 'a hostile Symbol.iterator override on references must not prevent the readiness computation — the guarded loop never invokes it')

  // (b) hostile getter on reference.contractId.
  const getterMarker = 'ACTIVATION-READINESS-GETTER-MARKER'
  const hostileRef = { version: 'v1', get contractId() { throw new TypeError(getterMarker) } }
  const caughtGetter = rejects(
    () => __internals.computeActivationReadiness(registry, [hostileRef]),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a hostile getter on a reference field must be discarded and converted, never escape as a raw foreign error',
  )
  assert.equal(caughtGetter.details.field, 'contractId')
  const serializedGetter = String(caughtGetter.message) + JSON.stringify(caughtGetter.details) + String(caughtGetter.stack)
  assert.ok(!serializedGetter.includes(getterMarker), 'the raw marker text must never leak into the branded error')

  // (b2) ROUND 8 FIX — the SAME hostile-getter class, but on reference.version
  // specifically (round 7 only ever probed contractId at this site; version's
  // readEntryField call had zero direct test coverage).
  const versionGetterMarker = 'ACTIVATION-READINESS-VERSION-GETTER-MARKER'
  const hostileVersionRef = { contractId: 'bom_line', get version() { throw new TypeError(versionGetterMarker) } }
  const caughtVersionGetter = rejects(
    () => __internals.computeActivationReadiness(registry, [hostileVersionRef]),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a hostile getter on reference.version must be discarded and converted, never escape as a raw foreign error',
  )
  assert.equal(caughtVersionGetter.details.field, 'version')
  const serializedVersionGetter = String(caughtVersionGetter.message) + JSON.stringify(caughtVersionGetter.details) + String(caughtVersionGetter.stack)
  assert.ok(!serializedVersionGetter.includes(versionGetterMarker), 'the raw marker text must never leak into the branded error')

  // (b3) ROUND 8 FIX — a Proxy WRAPPING a real `references` array, with a
  // hostile `.length` trap. Mirrors hostileEntriesIteratorNeverEscapesRaw's
  // case (c) for `entries`: `Array.isArray` is true for such a Proxy (IsArray
  // walks the proxy target chain without invoking any trap), so the
  // UNGUARDED direct-read form (`references.length`) would throw raw the
  // moment the length is actually read. Pins readArrayLength(references, ...)
  // specifically — the Symbol.iterator case (a) above never exercises this
  // read at all, since a well-behaved real array's `.length` is read without
  // incident on that path.
  const lengthMarker = 'ACTIVATION-READINESS-LENGTH-MARKER'
  const lengthProxyRefs = new Proxy([{ contractId: 'bom_line', version: 'v1' }], {
    get(target, prop, receiver) {
      if (prop === 'length') throw new TypeError(lengthMarker)
      return Reflect.get(target, prop, receiver)
    },
  })
  const caughtLength = rejects(
    () => __internals.computeActivationReadiness(registry, lengthProxyRefs),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a hostile length trap on a Proxy-wrapped references array must be discarded, never escape as a raw foreign error',
  )
  assert.equal(caughtLength.details.field, 'references')
  const serializedLength = String(caughtLength.message) + JSON.stringify(caughtLength.details) + String(caughtLength.stack)
  assert.ok(!serializedLength.includes(lengthMarker), 'the raw marker text must never leak into the branded error')

  // (b4) ROUND 8 FIX — a genuine array carrying a hostile accessor at ONE
  // index (`Object.defineProperty`), the rest ordinary. Mirrors
  // hostileEntriesIteratorNeverEscapesRaw's case (a) for `entries`. Pins
  // readArrayElement(references, index, ...) specifically — distinct from the
  // Symbol.iterator case (a) above (which never invokes an indexed read
  // through this hostile path at all) and from the length-Proxy case (b3)
  // just above (a different read site: the per-index `[[Get]]`, not `.length`).
  const elementMarker = 'ACTIVATION-READINESS-ELEMENT-MARKER'
  const indexHostileRefs = [{ contractId: 'bom_line', version: 'v1' }]
  Object.defineProperty(indexHostileRefs, 1, {
    enumerable: true,
    configurable: true,
    get() { throw new TypeError(elementMarker) },
  })
  indexHostileRefs.length = 2
  const caughtElement = rejects(
    () => __internals.computeActivationReadiness(registry, indexHostileRefs),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a hostile getter at one references index must be discarded and converted, never escape as a raw foreign error',
  )
  assert.equal(caughtElement.details.field, 'references')
  const serializedElement = String(caughtElement.message) + JSON.stringify(caughtElement.details) + String(caughtElement.stack)
  assert.ok(!serializedElement.includes(elementMarker), 'the raw marker text must never leak into the branded error')

  // (c) duck-typed registry whose .lookup() itself throws raw.
  const lookupMarker = 'ACTIVATION-READINESS-LOOKUP-MARKER'
  const hostileRegistry = { lookup() { throw new TypeError(lookupMarker) } }
  const caughtLookup = rejects(
    () => __internals.computeActivationReadiness(hostileRegistry, [{ contractId: 'bom_line', version: 'v1' }]),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a hostile registry.lookup() must be discarded and converted, never escape as a raw foreign error',
  )
  assert.equal(caughtLookup.details.field, 'registry')
  const serializedLookup = String(caughtLookup.message) + JSON.stringify(caughtLookup.details) + String(caughtLookup.stack)
  assert.ok(!serializedLookup.includes(lookupMarker), 'the raw marker text must never leak into the branded error')

  // Non-regression: a registry.lookup() call that throws its OWN legitimate
  // branded error (e.g. a malformed contractId) must propagate UNCHANGED,
  // never re-labeled as a `registry` failure.
  const malformedRefCaught = rejects(
    () => __internals.computeActivationReadiness(registry, [{ contractId: '', version: 'v1' }]),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a malformed reference contractId must propagate lookup()\'s own branded error unchanged',
  )
  assert.equal(malformedRefCaught.details.field, 'contractId', 'the branded error from inside registry.lookup() must keep its ORIGINAL field, not be re-labeled to "registry"')
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
// (8b) ROUND 8 FIX (owner HARD HOLD #4610 — closing a review-round-7 false
// claim): round 7's own commit message claimed "Spot-checked the two
// remaining __internals keys (requiredIdentityToken, hasControlCharacter):
// both gate on `typeof value !== 'string'` before touching the value" — FALSE
// for hasControlCharacter, which is ALSO directly on __internals (this test
// file already calls __internals.computeActivationReadiness and
// __internals.normalizeContractEntry directly, so hasControlCharacter is
// reachable the identical way) and had no type gate of its own — only its
// caller, requiredIdentityToken, gated before calling it. Proves BOTH
// failure shapes the false claim concealed: (a) a hostile non-string object
// whose `.length` throws must never escape a raw foreign error, and (b) a
// plain non-string primitive must be refused as a validated contract
// (branded error), not silently coerced/ignored — pinning a TYPE gate, not
// merely a length-read guard.
// ---------------------------------------------------------------------------
function hasControlCharacterGuardsNonStringInput() {
  const marker = 'CONTROL-CHAR-HOSTILE-LENGTH-MARKER'
  const hostileLength = { length: { valueOf() { throw new RangeError(marker) } } }
  const caughtHostile = rejects(
    () => __internals.hasControlCharacter(hostileLength),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a hostile non-string value with a throwing .length must be discarded and converted, never escape as a raw foreign error',
  )
  const serializedHostile = String(caughtHostile.message) + JSON.stringify(caughtHostile.details) + String(caughtHostile.stack)
  assert.ok(!serializedHostile.includes(marker), 'the raw marker text must never leak into the branded error')

  // A PLAIN non-string primitive (no hostile getter at all) must ALSO be
  // refused — this is the pin that discriminates "added a length-read try/catch"
  // from "added an actual typeof gate": a length-read guard alone would let
  // `42` through silently (since `(42).length` is `undefined`, the loop body
  // never runs, and the old code returned `false` with no error at all).
  rejects(
    () => __internals.hasControlCharacter(42),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a plain non-string primitive must be refused by an explicit type gate, not silently treated as containing no control characters',
  )

  // Non-regression: a genuine string with a control character, and one
  // without, must still behave exactly as before.
  assert.equal(__internals.hasControlCharacter('clean'), false, 'a clean string must still report no control character')
  assert.equal(__internals.hasControlCharacter('bad\x01text'), true, 'a string containing a control character must still be detected')
}

// ---------------------------------------------------------------------------
// (8c) P3 FIX (post-round-8 review of #4610) — RETRACTION: this module's own
// comment and requiredIdentityToken's rejection message both used to claim
// "printable ASCII is code point 0x20-0x7e"/"printable-char token". FALSE,
// measured directly here. This function pins the TRUE invariant so the
// description cannot silently drift from the behavior again: hasControlCharacter
// rejects ONLY the C0 range (0x00-0x1f) and DEL (0x7f) — nothing else, no
// matter how non-ASCII or non-"printable" — and requiredIdentityToken accepts
// every one of those non-ASCII code points when they appear BETWEEN other
// characters in a token, because trim() only strips LEADING/TRAILING runs.
// ---------------------------------------------------------------------------
function hasControlCharacterTrueInvariantIsPinned() {
  // (a) C0/DEL boundary, exhaustively at the edges — the mutation this
  // guards against is narrower than "delete the whole function": dropping
  // JUST the `|| code === 0x7f` disjunct, or narrowing `code < 0x20` to
  // `code < 0x02`, both left the suite green before these four assertions
  // existed (measured directly: neither mutation was caught by 'bad\x01text'
  // alone, since 0x01 is inside both the wide AND the narrowed range).
  assert.equal(__internals.hasControlCharacter('\x00'), true, '0x00 (NUL) must be detected')
  assert.equal(__internals.hasControlCharacter('\x1f'), true, '0x1f (US, the top of the C0 range) must be detected')
  assert.equal(__internals.hasControlCharacter('\x7f'), true, '0x7f (DEL) must be detected — a distinct disjunct from the C0 range, not adjacent to it')
  assert.equal(__internals.hasControlCharacter('\x20'), false, '0x20 (SPACE, one past the top of C0) must NOT be detected')
  assert.equal(__internals.hasControlCharacter('\x7e'), false, '0x7e (~, one below DEL) must NOT be detected')

  // (b) The four code points the retracted "printable ASCII 0x20-0x7e" claim
  // said were rejected, but are not: none of these is inside 0x20-0x7e, and
  // hasControlCharacter flags none of them.
  const acceptedByHasControlCharacter = {
    '0x85 NEL': '\x85',
    '0xa0 NBSP': '\xa0',
    'U+2028 LINE SEPARATOR': '\u2028',
    'U+200b ZWSP': '\u200b',
  }
  for (const [name, ch] of Object.entries(acceptedByHasControlCharacter)) {
    assert.equal(__internals.hasControlCharacter(ch), false, `${name} must NOT be detected as a control character — the retracted comment implied it would be`)
  }

  // (c) requiredIdentityToken, mid-token (trim only strips LEADING/TRAILING
  // runs, so placing the character BETWEEN two other characters is the only
  // shape that isolates hasControlCharacter's own behavior from trim()'s):
  // all four survive whole, unmodified, inside the returned token.
  for (const [name, ch] of Object.entries(acceptedByHasControlCharacter)) {
    const token = `abc${ch}def`
    const result = __internals.requiredIdentityToken(token, 'field')
    assert.equal(result, token, `${name} embedded mid-token must be accepted verbatim by requiredIdentityToken`)
  }

  // (d) The trim() trap this correction names explicitly: NBSP and LINE
  // SEPARATOR are both in ECMAScript's WhiteSpace/LineTerminator sets, so a
  // token composed SOLELY of one of them trims to '' and is refused by the
  // NON-EMPTY check — not by hasControlCharacter, which (per (b) above)
  // never flags it. NEL and ZWSP are NOT in those sets and survive trim()
  // unchanged, so a token composed solely of either is ACCEPTED (a single,
  // one-character, non-empty token).
  rejects(
    () => __internals.requiredIdentityToken('\xa0', 'field'),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a token consisting solely of NBSP must be refused — but via the non-empty check after trim(), never via hasControlCharacter',
  )
  rejects(
    () => __internals.requiredIdentityToken('\u2028', 'field'),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a token consisting solely of LINE SEPARATOR must be refused — but via the non-empty check after trim(), never via hasControlCharacter',
  )
  assert.equal(__internals.requiredIdentityToken('\x85', 'field'), '\x85', 'a token consisting solely of NEL survives trim() unchanged and must be accepted')
  assert.equal(__internals.requiredIdentityToken('\u200b', 'field'), '\u200b', 'a token consisting solely of ZWSP survives trim() unchanged and must be accepted')
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
  fieldsToctouGetterCannotBypassNonEmptyCheck()
  hostileGetterOnContractIdVersionOrFieldsNeverEscapesRaw()
  hostileOwnKeysTrapOnFieldsNeverEscapesRaw()
  hostileEntriesIteratorNeverEscapesRaw()
  activationGateRefusesUntrustedRegistry()
  activationGateRefusesCallerAssertedEvidence()
  activationReadinessMechanism()
  computeActivationReadinessNeverEscapesRawForeignErrors()
  hasControlCharacterGuardsNonStringInput()
  hasControlCharacterTrueInvariantIsPinned()
  internalsExactKeySet()
  frozenVocabularyIsExhaustive()
  console.log('gip-canonical-object-contract-registry.test.cjs OK')
}

main()
