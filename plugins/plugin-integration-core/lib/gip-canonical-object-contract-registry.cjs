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

const CANONICAL_OBJECT_CONTRACT_ERROR_REASONS = Object.freeze([
  'CANONICAL_OBJECT_CONTRACT_UNREGISTERED',
  'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
  'CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE',
  'CANONICAL_OBJECT_CONTRACT_ACTIVATION_BLOCKED',
  'CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT',
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
const trustedContractRegistries = new WeakSet()

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
  if (!isPlainObject(entry.fields) || Object.keys(entry.fields).length === 0) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'fields must be a non-empty plain object', { field: 'fields' })
  }
  // Own, frozen copy — the registry's internal state can never be mutated
  // through a reference the caller kept to the object it passed in.
  return Object.freeze({
    contractId,
    version,
    fields: Object.freeze({ ...entry.fields }),
  })
}

// Builds a CLOSED registry from a fixed, first-party entries array — the
// SAME structural shape as gip-connector-kind-registry.cjs's
// createConnectorKindRegistry (P3-b fix, review round 2). `entries` MAY be
// empty (and the shipped default below IS empty). Every entry is validated
// and inserted HERE, at construction, and never again: the returned object
// exposes no verb that could add, edit, or replace an entry after this
// function returns — "append-only" now means a caller passes a LONGER
// entries array to a NEW call of this function (a source-level, reviewed
// change), never a runtime method call against an already-built registry.
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
  const registry = Object.freeze({
    lookup,
    size() {
      let total = 0
      for (const versions of byContractId.values()) total += versions.size
      return total
    },
  })
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
// runtime register() call that could add to this instance once built.
const CANONICAL_OBJECT_CONTRACT_REGISTRY = createCanonicalObjectContractRegistry([])

// ---------------------------------------------------------------------------
// Activation gate (owner decision γ: "inventory and backfill existing
// references BEFORE activation"). This module performs NO inventory itself
// and reads no database — it consumes an explicitly-provided report shape and
// refuses to call the state "ready" unless that report both (a) affirmatively
// claims a completed inventory and (b) shows zero unbacked references.
//
//   inventoryReport = {
//     inventoryStatus: 'COMPLETE' | 'NOT_RUN',
//     references: [{ contractId, version }, ...],   // only meaningful when COMPLETE
//   }
//
// An omitted/'NOT_RUN' status refuses with CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT
// regardless of what `references` contains (including an empty array) — this
// is the fix for the fail-OPEN shape an empty array alone would otherwise be:
// "no inventory has run" and "inventory ran and found nothing" must not be
// the same value, or a caller could accidentally activate on day zero.
function assertCanonicalObjectContractRegistryActivationReady(registry, inventoryReport) {
  assertTrustedRegistry(registry)
  if (!isPlainObject(inventoryReport)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'inventoryReport must be a plain object', { field: 'inventoryReport' })
  }
  if (inventoryReport.inventoryStatus !== 'COMPLETE') {
    fail('CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT', 'no completed canonical-object-contract reference inventory has been supplied; activation refused', {})
  }
  const references = inventoryReport.references
  if (!Array.isArray(references)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'inventoryReport.references must be an array', { field: 'references' })
  }
  let backedCount = 0
  let unbackedCount = 0
  for (const reference of references) {
    if (!isPlainObject(reference)) {
      fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'each reference must be a plain object', { field: 'references' })
    }
    const contractId = requiredIdentityToken(reference.contractId, 'contractId')
    const version = requiredIdentityToken(reference.version, 'version')
    if (registry.lookup(contractId, version)) backedCount += 1
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
    trustedContractRegistries,
    normalizeContractEntry,
  },
}
