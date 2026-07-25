'use strict'

// gip-canonical-object-contract-registry.cjs — plain node test, hermetic.
// Proves: the shipped default registry is empty; registration is append-only
// (a version, once registered, can never be edited or replaced — not even
// with identical content); an unregistered lookup fails closed by name and
// does NOT auto-vivify an entry; and the activation gate refuses to report
// "ready" both when no inventory has been supplied AND when one has been
// supplied but leaves references unbacked — with a positive control proving
// the gate is not merely all-refusing.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  createCanonicalObjectContractRegistry,
  resolveCanonicalObjectContractVersion,
  assertCanonicalObjectContractRegistryActivationReady,
  CANONICAL_OBJECT_CONTRACT_REGISTRY,
  GipCanonicalObjectContractError,
  CANONICAL_OBJECT_CONTRACT_ERROR_REASONS,
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
// (2) Structural shape: register/lookup/size ONLY — exact key set, same
// technique as the connector-kind registry and the qualification prober's
// residual-1 predicate.
// ---------------------------------------------------------------------------
function exactKeySet() {
  const registry = createCanonicalObjectContractRegistry()
  assert.deepEqual(Object.keys(registry).sort(), ['lookup', 'register', 'size'])
  assert.ok(Object.isFrozen(registry))
}

// ---------------------------------------------------------------------------
// (3) Positive control: register then lookup succeeds and round-trips.
// ---------------------------------------------------------------------------
function positiveControlRegisterAndLookup() {
  const registry = createCanonicalObjectContractRegistry()
  const registered = registry.register({ contractId: 'bom_line', version: 'v1', fields: { materialCode: true } })
  assert.equal(registered.contractId, 'bom_line')
  assert.equal(registered.version, 'v1')
  assert.deepEqual(registered.fields, { materialCode: true })
  assert.ok(Object.isFrozen(registered))
  assert.ok(Object.isFrozen(registered.fields))

  const found = resolveCanonicalObjectContractVersion(registry, 'bom_line', 'v1')
  assert.equal(found, registered)
}

// ---------------------------------------------------------------------------
// (4) Append-only: re-registering the SAME (contractId, version) is refused,
// even with byte-identical fields — re-registration itself is the defect.
// A DIFFERENT version for the same contractId is a legal, separate append.
// ---------------------------------------------------------------------------
function appendOnlyImmutability() {
  const registry = createCanonicalObjectContractRegistry()
  registry.register({ contractId: 'bom_line', version: 'v1', fields: { materialCode: true } })

  rejects(
    () => registry.register({ contractId: 'bom_line', version: 'v1', fields: { materialCode: true } }),
    'CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE',
    're-registering the identical (contractId, version) must be refused',
  )
  rejects(
    () => registry.register({ contractId: 'bom_line', version: 'v1', fields: { materialCode: false } }),
    'CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE',
    're-registering the same version with DIFFERENT fields must still be refused (never edited)',
  )

  // v2 for the same contractId is a legal, separate append — v1 stays intact.
  registry.register({ contractId: 'bom_line', version: 'v2', fields: { materialCode: true, uom: true } })
  assert.equal(registry.size(), 2)
  const v1Still = resolveCanonicalObjectContractVersion(registry, 'bom_line', 'v1')
  assert.deepEqual(v1Still.fields, { materialCode: true }, 'v1 must remain exactly as first registered')
}

// ---------------------------------------------------------------------------
// (5) No auto-vivification: two consecutive misses on the SAME (contractId,
// version) leave size() unchanged and both throw UNREGISTERED — proves
// lookup never silently creates an entry on first miss.
// ---------------------------------------------------------------------------
function noAutoVivification() {
  const registry = createCanonicalObjectContractRegistry()
  const before = registry.size()
  rejects(() => resolveCanonicalObjectContractVersion(registry, 'ghost', 'v1'), 'CANONICAL_OBJECT_CONTRACT_UNREGISTERED', 'first miss')
  rejects(() => resolveCanonicalObjectContractVersion(registry, 'ghost', 'v1'), 'CANONICAL_OBJECT_CONTRACT_UNREGISTERED', 'second miss')
  assert.equal(registry.size(), before, 'size must not change across repeated misses')
}

// ---------------------------------------------------------------------------
// (6) Malformed registrations refused.
// ---------------------------------------------------------------------------
function malformedRegistrationsRefused() {
  const registry = createCanonicalObjectContractRegistry()
  rejects(() => registry.register({ contractId: '', version: 'v1', fields: { a: true } }), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'empty contractId')
  rejects(() => registry.register({ contractId: 'bom_line', version: '', fields: { a: true } }), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'empty version')
  rejects(() => registry.register({ contractId: 'bom_line', version: 'v1', fields: {} }), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'empty fields object')
  rejects(() => registry.register({ contractId: 'bom_line', version: 'v1', fields: null }), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'null fields')
  rejects(() => registry.register({ contractId: 'bom_line', version: 'v1', fields: ['not', 'an', 'object'] }), 'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'array fields')
  rejects(
    () => resolveCanonicalObjectContractVersion({ lookup: () => null, register: () => {}, size: () => 0 }, 'bom_line', 'v1'),
    'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
    'a duck-typed non-trusted registry must be refused',
  )
}

// ---------------------------------------------------------------------------
// (7) Activation gate — the fail-OPEN trap this line has shipped before:
// an EMPTY references array must not read the same as "inventory ran and
// found nothing". Three states, all tested, with a genuine positive control.
// ---------------------------------------------------------------------------
function activationGateThreeStates() {
  const registry = createCanonicalObjectContractRegistry()
  registry.register({ contractId: 'bom_line', version: 'v1', fields: { materialCode: true } })

  // (a) no inventoryStatus at all, even with an empty references array —
  // must NOT read as "clean" / "ready".
  rejects(
    () => assertCanonicalObjectContractRegistryActivationReady(registry, { references: [] }),
    'CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT',
    'a missing inventoryStatus with zero references must still refuse — day-zero must not look like day-complete',
  )
  // (b) explicit NOT_RUN.
  rejects(
    () => assertCanonicalObjectContractRegistryActivationReady(registry, { inventoryStatus: 'NOT_RUN', references: [] }),
    'CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT',
    'an explicit NOT_RUN status must refuse regardless of references content',
  )
  // (c) COMPLETE, but with an unbacked reference — ACTIVATION_BLOCKED, counts only.
  const blocked = rejects(
    () => assertCanonicalObjectContractRegistryActivationReady(registry, {
      inventoryStatus: 'COMPLETE',
      references: [
        { contractId: 'bom_line', version: 'v1' },
        { contractId: 'bom_line', version: 'v9' },
        { contractId: 'material', version: 'v1' },
      ],
    }),
    'CANONICAL_OBJECT_CONTRACT_ACTIVATION_BLOCKED',
    'COMPLETE inventory with unbacked references must refuse',
  )
  assert.deepEqual(blocked.details, { unbackedCount: 2, backedCount: 1, totalReferences: 3 })
  // values-free: no contractId/version string anywhere in the error.
  const serializedError = blocked.message + JSON.stringify(blocked.details)
  assert.ok(!serializedError.includes('bom_line') && !serializedError.includes('material'), 'activation-blocked error must be values-free')

  // (d) POSITIVE CONTROL — COMPLETE with zero unbacked references reports
  // ready. Without this, an all-refusing gate would also pass (a)-(c).
  const ready = assertCanonicalObjectContractRegistryActivationReady(registry, {
    inventoryStatus: 'COMPLETE',
    references: [{ contractId: 'bom_line', version: 'v1' }],
  })
  assert.deepEqual(ready, { ready: true, backedCount: 1, totalReferences: 1 })

  // Zero references under a genuinely COMPLETE inventory is also legally ready.
  const readyEmpty = assertCanonicalObjectContractRegistryActivationReady(registry, {
    inventoryStatus: 'COMPLETE',
    references: [],
  })
  assert.deepEqual(readyEmpty, { ready: true, backedCount: 0, totalReferences: 0 })
}

// ---------------------------------------------------------------------------
// (8) Vocabulary discipline.
// ---------------------------------------------------------------------------
function frozenVocabularyIsExhaustive() {
  assert.deepEqual(
    [...CANONICAL_OBJECT_CONTRACT_ERROR_REASONS].sort(),
    [
      'CANONICAL_OBJECT_CONTRACT_ACTIVATION_BLOCKED',
      'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
      'CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT',
      'CANONICAL_OBJECT_CONTRACT_UNREGISTERED',
      'CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE',
    ],
  )
  assert.ok(Object.isFrozen(CANONICAL_OBJECT_CONTRACT_ERROR_REASONS))
}

function main() {
  defaultRegistryIsEmpty()
  exactKeySet()
  positiveControlRegisterAndLookup()
  appendOnlyImmutability()
  noAutoVivification()
  malformedRegistrationsRefused()
  activationGateThreeStates()
  frozenVocabularyIsExhaustive()
  console.log('gip-canonical-object-contract-registry.test.cjs OK')
}

main()
