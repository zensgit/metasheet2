'use strict'

// GIP-D0 B1a — step 1.3: first-party canonical object contract registry +
// version lookup (owner decision γ, ledger §4.0 row γ / §4 step 1.3 / §3.0 B-3).
//
// LATENT: not wired to any runtime, route, scheduler or flag. No caller in
// this tree consults CANONICAL_OBJECT_CONTRACT_REGISTRY yet.
//
// `canonicalObjectVersion` names the version of OUR OWN first-party canonical
// object contract — never a witness of external source-side schema (that is
// source-catalog evidence / BindingQualification / field-mapping proof,
// ledger §3.0 B-3). The prior (HELD, non-ratified) attempt derived this field
// as a pure function of inputs already present elsewhere in the qualification
// tuple (systemContentKey + objectKey + fieldMap) — adding no contract
// identity at all. This module is the registry that closes that: a version is
// either REGISTERED here (first-party, deliberate) or it does not exist.
//
// Ruled design (owner decision γ, ledger §4.0):
//   - first-party only; contracts registered IMMUTABLY by contractId+version;
//     versions APPEND-ONLY — a registered version is never edited or replaced;
//   - NO auto-synthesis from customer config — the failure mode this closes
//     is exactly B-3's "invented locally". STRUCTURAL, not conventional (P3-b
//     fix, review round 2 — the prior shape here was FALSE to this comment:
//     `register` sat on the frozen singleton itself, reachable by ANY module
//     holding the import, at ANY time during a running process, which is
//     exactly the runtime-customer-synthesis mode this decision closes — see
//     the git history of this file for the shape that comment was written
//     against). The fix mirrors gip-connector-kind-registry.cjs's already-
//     audited pattern exactly: entries are supplied ONLY as a fixed array to
//     createCanonicalObjectContractRegistry(entries) at construction time;
//     the returned frozen object exposes ONLY lookup()/size() — there is no
//     register/add/set verb anywhere on it, under any name, pinned by the
//     exact-key-set test. "Append" now means a future, separately-reviewed
//     amendment edits THIS FILE's own CANONICAL_OBJECT_CONTRACT_REGISTRY
//     literal entries array (a real code change, a real review) — never a
//     runtime call from anywhere else in the process;
//   - unregistered => values-free CANONICAL_OBJECT_CONTRACT_UNREGISTERED;
//   - inventory + backfill of existing references BEFORE activation — see
//     assertCanonicalObjectContractRegistryActivationReady below. Per the
//     #4609 amendment (an inventory TOOL is not an inventory RESULT — the
//     probe tooling's CI runs a fake executor with no real database), the
//     concrete reference list this gate needs does not exist yet. The gate
//     therefore requires its caller to name that fact explicitly
//     (inventoryStatus) rather than let an empty array default to "clean" —
//     an omitted/'NOT_RUN' inventory refuses activation exactly like an
//     inventory that found unbacked references; only an explicit COMPLETE
//     status with zero unbacked references reports ready.
//
// This module SHIPS its default registry EMPTY: no contract has been
// registered by anyone yet. Only a future, separately-reviewed amendment may
// extend the literal entries array passed to createCanonicalObjectContractRegistry below.

const { deepCloneFrozenCanonical, CanonicalDomainError } = require('./gip-canonical-json.cjs')

const CANONICAL_OBJECT_CONTRACT_ERROR_REASONS = Object.freeze([
  'CANONICAL_OBJECT_CONTRACT_UNREGISTERED',
  'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
  'CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE',
  'CANONICAL_OBJECT_CONTRACT_ACTIVATION_BLOCKED',
  'CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT',
  'CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED',
])
const ERROR_REASON_SET = new Set(CANONICAL_OBJECT_CONTRACT_ERROR_REASONS)

class GipCanonicalObjectContractError extends Error {
  constructor(reason, message, details = {}) {
    super(message)
    this.name = 'GipCanonicalObjectContractError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details = {}) {
  if (!ERROR_REASON_SET.has(reason)) {
    throw new Error(
      'gip-canonical-object-contract-registry internal: undeclared error reason '
        + '(add it to the frozen CANONICAL_OBJECT_CONTRACT_ERROR_REASONS vocabulary)',
    )
  }
  throw new GipCanonicalObjectContractError(reason, message, details)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Control-char check via explicit char-code comparison (never a regex escape
// literal) — printable ASCII is code point 0x20-0x7e; anything below 0x20 or
// exactly 0x7f (DEL) is a control character.
function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function requiredIdentityToken(value, field) {
  if (typeof value !== 'string') {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', `${field} must be a string`, { field })
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 128 || hasControlCharacter(trimmed)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', `${field} must be a non-empty, <=128 printable-char token`, { field })
  }
  return trimmed
}

// TRUST is OBJECT IDENTITY (module-private WeakSet) — same unforgeable pattern
// as the probe-strategy and connector-kind registries.
// P2 FIX (review round 3): this WeakSet is NOT re-exported via __internals —
// matches gip-binding-qualification-spike.cjs's precedent (it does not
// export its own trustedProbeStrategyRegistries either) and
// gip-connector-kind-registry.cjs's sibling fix in this same round.
// Exporting it would have let ANY require()-holding caller do
// `__internals.trustedContractRegistries.add(fakeRegistry)`, turning a
// duck-typed forgery into something assertTrustedRegistry accepts — after
// which `registry.lookup(...)` above becomes attacker-controlled and could
// throw arbitrary text straight out of resolveCanonicalObjectContractVersion
// / assertCanonicalObjectContractRegistryActivationReady (neither wraps that
// call in a discarding catch) — "unforgeable" above is true only because
// this stays private.
//
// P1-1 FIX (owner HARD HOLD #4610 — the SAME finding as
// gip-connector-kind-registry.cjs's sibling module, mirrored here exactly):
// round 3's fix above closed only the `.add(fake)` door; the front door was
// still open, because createCanonicalObjectContractRegistry — this module's
// exported factory — unconditionally added every registry it built to this
// WeakSet. Any importer could call it directly and receive back a "trusted"
// object with no source edit at all. Fixed the same way as the sibling
// module: createCanonicalObjectContractRegistry below now only builds a
// registry object; trust is granted in EXACTLY one place,
// buildTrustedCanonicalObjectContractRegistry, which is NEVER exported —
// not at the top level, not under __internals (still reachable via
// require() by any importer, so a trust-granting constructor there is the
// identical hole one namespace deeper). Its only caller is the literal
// invocation that builds CANONICAL_OBJECT_CONTRACT_REGISTRY at module load,
// below.
const trustedContractRegistries = new WeakSet()

// P1-3 FIX (owner HARD HOLD #4610): assertCanonicalObjectContractRegistryActivationReady
// used to accept a PLAIN, caller-supplied object as inventoryReport — a
// caller could simply write `{ inventoryStatus: 'COMPLETE', references: [] }`
// and get `ready: true` back. "A tool is not a result" (this line's own
// ratified discipline, #4609's ⟲OD2 amendment) applies just as much to a
// caller-asserted STRING as to a caller-asserted tool run: a string is not
// evidence either. TRUST is, again, object identity — an inventory report is
// "attested" only if it was built by buildInventoryAttestation below, which
// is NEVER exported anywhere (not even __internals: unlike a pure function,
// this constructor's mere output identity confers a security property a
// later gate trusts, exactly the class of thing P1-1 above says must never
// be reachable via require()). Nothing in this shipped module calls it —
// there is no real inventory scanner in this repo yet (LATENT slice, no
// wiring) — so assertCanonicalObjectContractRegistryActivationReady refuses
// EVERY caller today, unconditionally. A future, separately-reviewed
// amendment that wires a genuine server-side inventory scan must call
// buildInventoryAttestation from a line added to THIS FILE — never from a
// runtime call anywhere else in the process.
const trustedInventoryAttestations = new WeakSet()

function assertTrustedRegistry(registry) {
  if (!trustedContractRegistries.has(registry)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'a trusted canonical-object-contract registry (from createCanonicalObjectContractRegistry) is required', { field: 'registry' })
  }
}

// Normalizes and validates ONE contract-version entry. `fields` is validated
// only for shape here (a non-empty plain object) — GIP-D0 §4's field-level
// requirement vocabulary (ALL_ROWS_REQUIRED / NON_EMPTY_WHEN_PRESENT /
// OPTIONAL, standardization rules, closed-vocabulary mapping, identity-key
// uniqueness) is a further specification this registry's mechanics do not
// build — out of scope for step 1.3, which is the identity+version+lookup+
// activation-gate mechanism, not the field-contract content model.
function normalizeContractEntry(entry) {
  if (!isPlainObject(entry)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'a contract registration must be a plain object', {})
  }
  const contractId = requiredIdentityToken(entry.contractId, 'contractId')
  const version = requiredIdentityToken(entry.version, 'version')
  // P3 FIX (owner HARD HOLD #4610 residual, round 6) — TOCTOU on entry.fields:
  // this used to read `entry.fields` THREE separate times (the isPlainObject
  // check, the Object.keys().length check, and deepCloneFrozenCanonical
  // below) — fine for an ordinary data property, but a GETTER can return a
  // DIFFERENT value on each read. A getter returning `{a:1}` on its first
  // two reads and `{}` on its third passes the non-empty check using the
  // first two reads and then clones the THIRD (empty) read — registering an
  // EMPTY `fields` past the very guard meant to refuse it. Reading the
  // property ONCE into a local closes the window: every check below and the
  // clone all observe the identical value. (Immaterial on the one production
  // path today — the shipped registry's entries are the in-file literal `[]`
  // — but this is the entry point a future amendment would wire to an
  // externally-sourced entries array, so the TOCTOU should not survive
  // silently into that amendment.)
  const rawFields = entry.fields
  if (!isPlainObject(rawFields) || Object.keys(rawFields).length === 0) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'fields must be a non-empty plain object', { field: 'fields' })
  }
  // P2 FIX (owner HARD HOLD #4610): `fields: Object.freeze({ ...entry.fields })`
  // was only a SHALLOW copy + SHALLOW freeze — Object.freeze only locks the
  // top-level property bindings; any object/array VALUE inside `fields`
  // stayed the identical reference the caller passed in. A caller that kept
  // a reference to a nested structure could mutate it after registration and
  // the registered version's content would change — owner measured
  // `nestedFrozen: false`, `registeredVersionChanged: true`, defeating
  // "immutable registration, append-only versions". Fixed using the
  // primitive this line already ratified for exactly this domain (§3.1 ⟲R2):
  // deepCloneFrozenCanonical (gip-canonical-json.cjs) — an OWNED clone in the
  // strict canonical-JSON domain, recursively frozen, so no reference the
  // caller retains can ever reach the registered copy.
  let fields
  try {
    fields = deepCloneFrozenCanonical(rawFields)
  } catch (error) {
    if (error instanceof CanonicalDomainError) {
      fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'fields must stay in the strict canonical JSON domain', { field: 'fields' })
    }
    throw error
  }
  return Object.freeze({ contractId, version, fields })
}

// Builds a registry object (lookup()/size()) from a fixed, first-party
// entries array — the SAME structural shape as
// gip-connector-kind-registry.cjs's createConnectorKindRegistry (P3-b fix,
// review round 2). `entries` MAY be empty (and the shipped default below IS
// empty). Every entry is validated and inserted HERE, at construction, and
// never again: the returned object exposes no verb that could add, edit, or
// replace an entry after this function returns — "append-only" now means a
// caller passes a LONGER entries array to a NEW call of this function (a
// source-level, reviewed change), never a runtime method call against an
// already-built registry. P1-1 FIX (owner HARD HOLD #4610): calling this
// function grants NO trust — see the fix note above trustedContractRegistries.
function createCanonicalObjectContractRegistry(entries) {
  if (!Array.isArray(entries)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'entries must be an array', { field: 'entries' })
  }
  // Two-level Map (contractId -> version -> frozen entry) rather than a
  // single joined string key — no separator character is needed at all, so
  // there is no join-collision surface between (contractId, version) pairs
  // to reason about.
  const byContractId = new Map()
  for (const raw of entries) {
    const normalized = normalizeContractEntry(raw)
    let versions = byContractId.get(normalized.contractId)
    if (versions && versions.has(normalized.version)) {
      // Immutable: a version is NEVER edited or replaced, even with
      // byte-identical content — re-declaring the same (contractId, version)
      // within one entries array is itself the defect this refuses, not
      // just a duplicate.
      fail('CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE', 'a registered contract version cannot be re-registered or edited', { field: 'version' })
    }
    if (!versions) {
      versions = new Map()
      byContractId.set(normalized.contractId, versions)
    }
    versions.set(normalized.version, normalized)
  }

  function lookup(contractId, version) {
    const normalizedContractId = requiredIdentityToken(contractId, 'contractId')
    const normalizedVersion = requiredIdentityToken(version, 'version')
    const versions = byContractId.get(normalizedContractId)
    if (!versions) return null
    return versions.get(normalizedVersion) || null
  }

  // Frozen object exposes EXACTLY these keys — pinned by the exact-key-set
  // test the same way the qualification prober's residual-1 predicate (and
  // the connector-kind registry's own resolve()/size() pin) are pinned, so a
  // future change cannot quietly add a synthesize/register/auto-register
  // verb under a different name.
  return Object.freeze({
    lookup,
    size() {
      let total = 0
      for (const versions of byContractId.values()) total += versions.size
      return total
    },
  })
}

// MODULE-PRIVATE. Never exported, under any name, anywhere. The ONLY place
// that grants trust — see the P1-1 fix note above trustedContractRegistries.
function buildTrustedCanonicalObjectContractRegistry(entries) {
  const registry = createCanonicalObjectContractRegistry(entries)
  trustedContractRegistries.add(registry)
  return registry
}

// The ONE fail-closed lookup entry point. Never echoes the rejected
// contractId/version into the error.
function resolveCanonicalObjectContractVersion(registry, contractId, version) {
  assertTrustedRegistry(registry)
  const found = registry.lookup(contractId, version)
  if (!found) {
    fail('CANONICAL_OBJECT_CONTRACT_UNREGISTERED', 'canonical object contract version is not registered', {})
  }
  return found
}

// The first-party registry itself — SHIPS EMPTY. Only a future, separately-
// reviewed amendment may extend this literal entries array (owner decision γ
// requires the backfill/reference inventory to come from a
// privately-authorized real run that has not happened — #4609's ⟲OD2
// amendment: an inventory TOOL is not an inventory RESULT). There is no
// runtime register() call that could add to this instance once built. Built
// via buildTrustedCanonicalObjectContractRegistry (module-private, P1-1 fix)
// — this is the ONE trusted registry instance that will ever exist.
const CANONICAL_OBJECT_CONTRACT_REGISTRY = buildTrustedCanonicalObjectContractRegistry([])

// MODULE-PRIVATE. Never exported, under any name, anywhere. The ONLY place
// that grants attestation trust — see the P1-3 fix note above
// trustedInventoryAttestations. Nothing in this shipped module calls this
// today (no real inventory scanner exists yet) — see that note for the full
// account of why that is the honest, correct state, not a gap.
function buildInventoryAttestation({ inventoryStatus, references }) {
  if (inventoryStatus !== 'COMPLETE' && inventoryStatus !== 'NOT_RUN') {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'inventoryStatus must be COMPLETE or NOT_RUN', { field: 'inventoryStatus' })
  }
  if (!Array.isArray(references)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'references must be an array', { field: 'references' })
  }
  for (const reference of references) {
    if (!isPlainObject(reference)) {
      fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'each reference must be a plain object', { field: 'references' })
    }
    requiredIdentityToken(reference.contractId, 'contractId')
    requiredIdentityToken(reference.version, 'version')
  }
  const attestation = Object.freeze({
    inventoryStatus,
    references: Object.freeze(references.map((reference) => Object.freeze({ contractId: reference.contractId, version: reference.version }))),
  })
  trustedInventoryAttestations.add(attestation)
  return attestation
}

function assertTrustedInventoryAttestation(inventoryReport) {
  // WeakSet.has(primitive) returns false (never throws) — null/plain objects/
  // strings all fail here too, before any of their fields are ever read.
  if (!trustedInventoryAttestations.has(inventoryReport)) {
    fail('CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED', 'inventoryReport must be server-attested evidence (from buildInventoryAttestation), a caller-supplied object is not evidence', {})
  }
}

// Pure mechanism: given an ALREADY-TRUSTED registry and an ALREADY-VALIDATED
// references array, computes backed/unbacked counts and reports readiness.
// Confers no trust of its own (like computeSystemContentKey in the sibling
// gip-system-identity-read.cjs module) — safe to expose for mechanism
// testing via __internals, unlike buildInventoryAttestation above.
function computeActivationReadiness(registry, references) {
  let backedCount = 0
  let unbackedCount = 0
  for (const reference of references) {
    if (registry.lookup(reference.contractId, reference.version)) backedCount += 1
    else unbackedCount += 1
  }
  if (unbackedCount > 0) {
    fail('CANONICAL_OBJECT_CONTRACT_ACTIVATION_BLOCKED', 'canonical object contract registry has unbacked references; activation refused until backfill completes', {
      unbackedCount,
      backedCount,
      totalReferences: references.length,
    })
  }
  return Object.freeze({ ready: true, backedCount, totalReferences: references.length })
}

// ---------------------------------------------------------------------------
// Activation gate (owner decision γ: "inventory and backfill existing
// references BEFORE activation"). This module performs NO inventory itself
// and reads no database — it consumes a report and refuses to call the state
// "ready" unless that report is (a) genuinely server-attested evidence — not
// a caller-supplied string, however plausible-looking (P1-3 fix, owner HARD
// HOLD #4610: "a tool is not a result" applies to a caller-asserted STATUS
// STRING exactly as much as to a caller-asserted tool run) — AND (b)
// affirmatively claims a completed inventory with zero unbacked references.
//
// An attestation whose inventoryStatus is NOT_RUN (or a caller object that
// isn't an attestation at all) refuses with a reason — the caller-object
// case with CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED (not evidence),
// the genuinely-attested-but-NOT_RUN case with the pre-existing
// CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT (evidence says nothing has run)
// — two DISTINCT reasons for two DISTINCT failure modes, so neither door can
// quietly cover for the other going missing.
//
// HONESTY NOTE (state this plainly, do not let the frozen vocabulary imply
// more than is true): CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT is
// CURRENTLY UNREACHABLE. Reaching it requires a genuinely-attested object
// whose inventoryStatus is NOT_RUN, and buildInventoryAttestation — the only
// function that can produce a trusted attestation at all — has ZERO call
// sites anywhere in this shipped module (see the LATENT fix note above it),
// so its own validation logic has never executed once, in production or in
// any test. The reason token stays in the frozen vocabulary because the
// SHAPE is correct and load-bearing the moment a future amendment adds a
// real caller — but until then, only CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED
// is reachable from outside this module.
function assertCanonicalObjectContractRegistryActivationReady(registry, inventoryReport) {
  assertTrustedRegistry(registry)
  assertTrustedInventoryAttestation(inventoryReport)
  if (inventoryReport.inventoryStatus !== 'COMPLETE') {
    fail('CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT', 'no completed canonical-object-contract reference inventory has been supplied; activation refused', {})
  }
  return computeActivationReadiness(registry, inventoryReport.references)
}

module.exports = {
  createCanonicalObjectContractRegistry,
  resolveCanonicalObjectContractVersion,
  assertCanonicalObjectContractRegistryActivationReady,
  CANONICAL_OBJECT_CONTRACT_REGISTRY,
  GipCanonicalObjectContractError,
  CANONICAL_OBJECT_CONTRACT_ERROR_REASONS,
  __internals: {
    fail,
    requiredIdentityToken,
    hasControlCharacter,
    normalizeContractEntry,
    computeActivationReadiness,
  },
}
