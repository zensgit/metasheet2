'use strict'

// GIP-D0 profile-certification contracts — a LATENT contract (not wired to any runtime).
//
// RATIFY SCOPE (owner 2026-07-23, GIP-D0 @ d58ec38f4): the ratify unlocked ONLY
// (1) profile schema, (2) compliance harness, (3) read-only qualification spike.
// This module is (1): the frozen vocabularies + certificate validators + derivations
// of the GIP-D0 platform design lock (docs/development/gip-d0-general-integration-
// platform-design-lock-20260723.md) and the scale-kernel D0 capability matrix
// (general-prep-scale-sync-kernel-d0-design-lock-20260723.md §2, A1-A3 amendments).
//
// It does NOT certify any concrete profile (each profile passes its own gate), does
// NOT register a profile registry, does NOT touch D2 runtime / external write-back /
// rollout, and is NOT reachable from any route or runtime. It only describes and
// gates. Mirrors connector-action-contracts.cjs (DF-T1A latent-contract precedent).
//
// Serialization/domain discipline: the ONE shared strict canonical codec
// (gip-canonical-json.cjs) — never a local partial definition.
//
// Discipline: every frozen vocabulary here carries the three-layer pin
// (deepEqual exact test + runtime consumer in fail() + source-level invariant test)
// — the carry-policy lesson transplanted verbatim.

// ── Frozen vocabularies (scale-D0 §2 as amended A1-A3; GIP-D0 §5) ─────────────────

// source certification schema — FOUR dimensions (applyMode is NOT a source dimension).
const { CanonicalDomainError, deepCloneFrozenCanonical } = require('./gip-canonical-json.cjs')

const GIP_ACQUISITION_MODES = Object.freeze([
  'BOUNDED_READ',
  'PAGED_READ',
  'SEALED_EXPORT',
  'CHANGE_FEED',
])
// supportedConsistencyProofs is a SET drawn from this closed three-value vocabulary.
// The EMPTY set is a legal, HONEST declaration of "no snapshot proof" (it is not a
// fourth proof; acceptance of the empty set is scenario-role policy, not schema).
const GIP_CONSISTENCY_PROOFS = Object.freeze([
  'SOURCE_SNAPSHOT_TXN',
  'IMMUTABLE_SNAPSHOT_TOKEN',
  'MONOTONIC_VERSION_PIN',
])
const GIP_CONTINUATION_LIFETIMES = Object.freeze([
  'SINGLE_REQUEST',
  'CONNECTION_BOUND',
  'DURABLE_TOKEN',
])
// supportedCompletenessProofs is a SET from this closed vocabulary; a certificate
// MUST declare a non-empty set (a successful run requires usedCompletenessProofs
// non-empty and ⊆ supported — an empty supported set could never run successfully).
const GIP_COMPLETENESS_PROOFS = Object.freeze([
  'SHORT_PAGE',
  'DECLARED_TOTAL',
  'SIGNED_MANIFEST',
])
// Independent axis — CertifiedApplyProfile, INTERNAL_APPLY_TARGET only.
const GIP_APPLY_MODES = Object.freeze([
  'SYNCHRONOUS_UOW',
  'STAGED_GENERATION',
])
// Recovery strategies are DERIVED from the matrix (scale-D0 §2), never declared.
const GIP_RECOVERY_STRATEGIES = Object.freeze([
  'WHOLE_RERUN',
  'WHOLE_ROUND_RESTART',
  'PAGE_RESUME',
  'CHUNK_RESUME',
])
// GIP-D0 §5 scenario-role vocabularies (frozen here as the platform vocab home; the
// role/scenario RUNTIME is not part of this ratify scope).
const GIP_ROLE_TYPES = Object.freeze([
  'EXTERNAL_READ_SOURCE',
  'INTERNAL_APPLY_TARGET',
  'EXTERNAL_WRITE_TARGET', // v1: certification/runtime for this type is ALWAYS refused
])
const GIP_CROSS_ROLE_TEMPORAL_POLICIES = Object.freeze([
  'DISCLOSE_ONLY',
  'MAX_CAPTURE_GAP', // freshness SLO — NOT a consistency proof
  'COMMON_EFFECTIVE_CUT',
  'COORDINATED_SNAPSHOT', // reserved; v1 never certifiable
])
const GIP_CONSISTENCY_REQUIREMENT_STATUSES = Object.freeze([
  'REQUIRED',
  'NOT_REQUIRED',
])

// Closed error-reason vocabulary. fail() enforces membership at runtime (coarse
// token on violation — never echoes the offending value), the test suite pins the
// exact list with deepEqual, and a source-level invariant test asserts every
// fail('REASON') call site in this file is a member.
const GIP_PROFILE_ERROR_REASONS = Object.freeze([
  'PROFILE_NOT_OBJECT',
  'PROFILE_ID_INVALID',
  'CONNECTOR_KIND_REQUIRED',
  'ACTION_REQUIRED',
  'IMPLEMENTATION_VERSION_REQUIRED',
  'CERTIFICATE_NOT_OBJECT',
  'CERTIFICATE_UNKNOWN_FIELD',
  'ACQUISITION_MODE_INVALID',
  'CONSISTENCY_PROOFS_INVALID',
  'CONTINUATION_LIFETIME_INVALID',
  'COMPLETENESS_PROOFS_INVALID',
  'COMPLETENESS_PROOFS_EMPTY',
  'COMPLETENESS_COMBINATION_INVALID',
  'APPLY_MODE_FORBIDDEN_ON_READ_PROFILE',
  'RECOVERY_DECLARATION_FORBIDDEN',
  'ILLEGAL_CAPABILITY_COMBINATION',
  'APPLY_PROFILE_NOT_OBJECT',
  'APPLY_PROFILE_ID_INVALID',
  'APPLY_MODE_INVALID',
  'CONSISTENCY_STATUS_INVALID',
  'CONSISTENCY_EVIDENCE_INVALID',
  'COMPLETENESS_EVIDENCE_INVALID',
  'ROLE_TYPE_INVALID',
  'EXTERNAL_WRITE_TARGET_FORBIDDEN',
])
const GIP_PROFILE_ERROR_REASON_SET = new Set(GIP_PROFILE_ERROR_REASONS)

class GipProfileContractError extends Error {
  constructor(reason, message, details = {}) {
    super(message)
    this.name = 'GipProfileContractError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details) {
  if (!GIP_PROFILE_ERROR_REASON_SET.has(reason)) {
    // COARSE fixed token — never echo the rejected reason value (value-leak discipline).
    throw new Error(
      'gip-profile-certification-contracts internal: undeclared error reason '
        + '(add it to the frozen GIP_PROFILE_ERROR_REASONS vocabulary)',
    )
  }
  throw new GipProfileContractError(reason, message, details)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

// Opaque certificate fields go through the SHARED strict canonical codec (review
// P2: Date / class instances / sparse arrays previously slipped a local check and
// collided digests). Domain violations fail closed with the field name only.
function deepCloneFrozenJson(value, field) {
  try {
    return deepCloneFrozenCanonical(value)
  } catch (error) {
    if (error instanceof CanonicalDomainError) {
      fail('CERTIFICATE_UNKNOWN_FIELD', 'certificate fields must stay in the strict canonical JSON domain', { field })
    }
    throw error
  }
}

// Membership-checked, DUPLICATE-free set drawn from a closed vocabulary. Coarse
// details: counts and field name only — never the offending values.
function normalizeClosedSet(value, vocabulary, field, reason) {
  if (!Array.isArray(value)) {
    fail(reason, `${field} must be an array drawn from its frozen vocabulary`, { field })
  }
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || !vocabulary.includes(entry) || seen.has(entry)) {
      fail(reason, `${field} contains a value outside its frozen vocabulary (or a duplicate)`, {
        field,
        declaredCount: value.length,
      })
    }
    seen.add(entry)
  }
  // CANONICAL order (review P2): equivalent sets normalize identically — members are
  // re-ordered by their frozen vocabulary index, never by caller order.
  return Object.freeze(vocabulary.filter((entry) => seen.has(entry)))
}

// profileId naming pattern: <connectorKind>.<action>.v<positiveInt> — e.g. the
// (future, individually-gated) bridge.bounded_read.v1. The pattern is frozen here so
// lineage fields agree on ONE spelling; certifying any concrete id stays gated.
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[1-9][0-9]*$/

// GIP-D0 §3 "complete contract" components are all expressible: the four schema
// dimensions + combination rules + maxScale + orderingKeyRequirement + the declared
// SHAPES (manifest/token/cursor) and the profile's failure vocabulary. Shape/vocab
// fields are carried opaquely at schema level — their DEEP validation belongs to each
// profile's own certification gate. 恢复许可 (recovery permission) is intentionally
// NOT a field: it is satisfied by derivation (declaring it stays forbidden).
const READ_CERTIFICATE_FIELDS = Object.freeze([
  'acquisitionMode',
  'supportedConsistencyProofs',
  'continuationLifetime',
  'supportedCompletenessProofs',
  'completenessCombinationRules',
  'maxScale',
  'orderingKeyRequirement',
  'manifestShape',
  'tokenShape',
  'cursorShape',
  'failureVocabulary',
])

// ── CertifiedReadActionProfile (read-action certification; FOUR source dimensions) ──
//
//   CertifiedReadActionProfile
//     = connector kind + action/queryPreset + implementation version + capability certificate
//
// The certificate's version identity is the SINGLE authoritative actionProfileVersion
// (= profileId); the action/queryPreset version is pinned INSIDE this definition and
// is never an independent digest input (review P2: two implementations must not each
// compute their own digest).
// Frozen cross-dimension legality (scale-D0 §2) — shared so deriveRecoveryStrategy
// re-checks it too (review P2: derivation must never grant a resume strategy to a
// schema-ILLEGAL certificate). Reads only membership of already-frozen closed sets.
function assertCertificateCrossDimensionLegal({ acquisitionMode, continuationLifetime, supportedConsistencyProofs, supportedCompletenessProofs }) {
  const consistency = Array.isArray(supportedConsistencyProofs) ? supportedConsistencyProofs : []
  const completeness = Array.isArray(supportedCompletenessProofs) ? supportedCompletenessProofs : []
  // 1. BOUNDED_READ is a single page: SINGLE_REQUEST only.
  if (acquisitionMode === 'BOUNDED_READ' && continuationLifetime !== 'SINGLE_REQUEST') {
    fail('ILLEGAL_CAPABILITY_COMBINATION', 'BOUNDED_READ is single-request by definition', { rule: 'BOUNDED_READ_SINGLE_REQUEST' })
  }
  // 2. SEALED_EXPORT must include SIGNED_MANIFEST.
  if (acquisitionMode === 'SEALED_EXPORT' && !completeness.includes('SIGNED_MANIFEST')) {
    fail('ILLEGAL_CAPABILITY_COMBINATION', 'SEALED_EXPORT requires SIGNED_MANIFEST completeness', { rule: 'SEALED_EXPORT_REQUIRES_SIGNED_MANIFEST' })
  }
  // 3. CHANGE_FEED requires the monotonic version pin.
  if (acquisitionMode === 'CHANGE_FEED' && !consistency.includes('MONOTONIC_VERSION_PIN')) {
    fail('ILLEGAL_CAPABILITY_COMBINATION', 'CHANGE_FEED requires MONOTONIC_VERSION_PIN consistency', { rule: 'CHANGE_FEED_REQUIRES_VERSION_PIN' })
  }
  // 4. DURABLE_TOKEN needs a durable anchor (immutable token, or CHANGE_FEED watermark).
  if (continuationLifetime === 'DURABLE_TOKEN') {
    const immutableAnchor = consistency.includes('IMMUTABLE_SNAPSHOT_TOKEN')
    const watermarkAnchor = acquisitionMode === 'CHANGE_FEED' && consistency.includes('MONOTONIC_VERSION_PIN')
    if (!immutableAnchor && !watermarkAnchor) {
      fail('ILLEGAL_CAPABILITY_COMBINATION', 'DURABLE_TOKEN continuation requires a durable consistency anchor', { rule: 'DURABLE_TOKEN_REQUIRES_DURABLE_ANCHOR' })
    }
  }
}

function normalizeCertifiedReadActionProfile(input) {
  if (!isPlainObject(input)) {
    fail('PROFILE_NOT_OBJECT', 'certified read-action profile must be a plain object', {})
  }
  // Strict TOP-LEVEL shape too (review P2: unknown top-level fields were silently
  // ignored — the profile is a closed shape end to end).
  for (const key of Object.keys(input)) {
    if (!['profileId', 'connectorKind', 'actionId', 'implementationVersion', 'certificate'].includes(key)) {
      fail('PROFILE_NOT_OBJECT', 'profile carries an undeclared top-level field', {
        fieldCount: Object.keys(input).length,
      })
    }
  }
  const profileId = nonBlankString(input.profileId)
  if (!profileId || profileId.length > 128 || !PROFILE_ID_PATTERN.test(profileId)) {
    fail('PROFILE_ID_INVALID', 'profileId must match <connectorKind>.<action>.v<N> (<=128 chars)', {})
  }
  const connectorKind = nonBlankString(input.connectorKind)
  if (!connectorKind) fail('CONNECTOR_KIND_REQUIRED', 'connectorKind is required', {})
  const actionId = nonBlankString(input.actionId)
  if (!actionId) fail('ACTION_REQUIRED', 'actionId (named action / queryPreset) is required', {})
  const implementationVersion = nonBlankString(input.implementationVersion)
  if (!implementationVersion) {
    fail('IMPLEMENTATION_VERSION_REQUIRED', 'implementationVersion is required', {})
  }

  const certificate = input.certificate
  if (!isPlainObject(certificate)) {
    fail('CERTIFICATE_NOT_OBJECT', 'capability certificate must be a plain object', {})
  }
  // Closed field list: a smuggled field (e.g. applyMode, recoveryStrategy) is refused
  // BY NAME below, and any other unknown field is refused generically — the
  // certificate is a closed shape, not an extensible bag.
  for (const key of Object.keys(certificate)) {
    if (key === 'applyMode') {
      // P2 split: apply is an independent axis (CertifiedApplyProfile). A read
      // certificate carrying applyMode is the exact drift the review forbade.
      fail('APPLY_MODE_FORBIDDEN_ON_READ_PROFILE', 'applyMode is not a source dimension', {})
    }
    if (key === 'recoveryStrategy' || key === 'recovery') {
      // Recovery is DERIVED from the matrix — a certificate may not declare it.
      fail('RECOVERY_DECLARATION_FORBIDDEN', 'recovery strategy is derived, never declared', {})
    }
    if (!READ_CERTIFICATE_FIELDS.includes(key)) {
      fail('CERTIFICATE_UNKNOWN_FIELD', 'certificate carries an undeclared field', {
        fieldCount: Object.keys(certificate).length,
      })
    }
  }

  const acquisitionMode = certificate.acquisitionMode
  if (!GIP_ACQUISITION_MODES.includes(acquisitionMode)) {
    fail('ACQUISITION_MODE_INVALID', 'acquisitionMode is outside the frozen vocabulary', {})
  }
  const supportedConsistencyProofs = normalizeClosedSet(
    certificate.supportedConsistencyProofs,
    GIP_CONSISTENCY_PROOFS,
    'supportedConsistencyProofs',
    'CONSISTENCY_PROOFS_INVALID',
  )
  const continuationLifetime = certificate.continuationLifetime
  if (!GIP_CONTINUATION_LIFETIMES.includes(continuationLifetime)) {
    fail('CONTINUATION_LIFETIME_INVALID', 'continuationLifetime is outside the frozen vocabulary', {})
  }
  const supportedCompletenessProofs = normalizeClosedSet(
    certificate.supportedCompletenessProofs,
    GIP_COMPLETENESS_PROOFS,
    'supportedCompletenessProofs',
    'COMPLETENESS_PROOFS_INVALID',
  )
  if (supportedCompletenessProofs.length === 0) {
    // successful run ⇒ used ≠ [] ∧ used ⊆ supported — an empty supported set can
    // never produce a legal successful run, so the certificate itself is illegal.
    fail('COMPLETENESS_PROOFS_EMPTY', 'a certificate must support at least one completeness proof', {})
  }

  // completenessCombinationRules: the run-usable proof COMBINATIONS, declared by the
  // certificate (review: SIGNED_MANIFEST combination rules are frozen in the
  // certificate; a run may never use an undeclared combination). Default: each
  // supported proof usable alone.
  let combinations
  if (certificate.completenessCombinationRules === undefined) {
    combinations = supportedCompletenessProofs.map((proof) => Object.freeze([proof]))
  } else {
    if (!Array.isArray(certificate.completenessCombinationRules)
      || certificate.completenessCombinationRules.length === 0) {
      fail('COMPLETENESS_COMBINATION_INVALID', 'completenessCombinationRules must be a non-empty array of proof sets', {})
    }
    const seenCombos = new Set()
    combinations = certificate.completenessCombinationRules.map((combo) => {
      const normalized = normalizeClosedSet(
        combo,
        GIP_COMPLETENESS_PROOFS,
        'completenessCombinationRules',
        'COMPLETENESS_COMBINATION_INVALID',
      )
      if (normalized.length === 0) {
        fail('COMPLETENESS_COMBINATION_INVALID', 'a declared proof combination must be non-empty', {})
      }
      for (const proof of normalized) {
        if (!supportedCompletenessProofs.includes(proof)) {
          fail('COMPLETENESS_COMBINATION_INVALID', 'a declared combination uses an unsupported proof', {})
        }
      }
      const key = normalized.join('+')
      if (seenCombos.has(key)) {
        fail('COMPLETENESS_COMBINATION_INVALID', 'a proof combination is declared twice', {})
      }
      seenCombos.add(key)
      return normalized
    })
    // canonical LIST order: by size, then joined canonical members.
    combinations.sort((a, b) => (a.length - b.length) || (a.join('+') < b.join('+') ? -1 : 1))
  }

  assertCertificateCrossDimensionLegal({
    acquisitionMode, continuationLifetime, supportedConsistencyProofs, supportedCompletenessProofs,
  })

  return Object.freeze({
    profileId,
    // actionProfileVersion is the SINGLE authoritative version identity for every
    // lineage/digest consumer (qualificationDigest, roleBindingFingerprint).
    actionProfileVersion: profileId,
    connectorKind,
    actionId,
    implementationVersion,
    certificate: Object.freeze({
      acquisitionMode,
      supportedConsistencyProofs,
      continuationLifetime,
      supportedCompletenessProofs,
      completenessCombinationRules: Object.freeze(combinations),
      ...(certificate.maxScale !== undefined
        ? { maxScale: deepCloneFrozenJson(certificate.maxScale, 'maxScale') } : {}),
      ...(certificate.orderingKeyRequirement !== undefined
        ? { orderingKeyRequirement: deepCloneFrozenJson(certificate.orderingKeyRequirement, 'orderingKeyRequirement') } : {}),
      ...(certificate.manifestShape !== undefined
        ? { manifestShape: deepCloneFrozenJson(certificate.manifestShape, 'manifestShape') } : {}),
      ...(certificate.tokenShape !== undefined
        ? { tokenShape: deepCloneFrozenJson(certificate.tokenShape, 'tokenShape') } : {}),
      ...(certificate.cursorShape !== undefined
        ? { cursorShape: deepCloneFrozenJson(certificate.cursorShape, 'cursorShape') } : {}),
      ...(certificate.failureVocabulary !== undefined
        ? { failureVocabulary: deepCloneFrozenJson(certificate.failureVocabulary, 'failureVocabulary') } : {}),
    }),
  })
}

// Recovery strategy — DERIVED from the matrix (scale-D0 §2), never configured:
//   BOUNDED_READ                                  ⇒ WHOLE_RERUN
//   SEALED_EXPORT                                 ⇒ CHUNK_RESUME (re-upload, never re-export)
//   IMMUTABLE_SNAPSHOT_TOKEN + DURABLE_TOKEN      ⇒ PAGE_RESUME
//   everything else (connection-bound snapshot …) ⇒ WHOLE_ROUND_RESTART
function deriveRecoveryStrategy(certificate) {
  if (!isPlainObject(certificate)) {
    fail('CERTIFICATE_NOT_OBJECT', 'recovery derivation needs a certificate object', {})
  }
  // review P2: derivation is fail-CLOSED — a schema-illegal certificate never earns a
  // resume-grade strategy. Validate the closed vocabularies + cross-dimension legality
  // the same way normalization does before deriving anything.
  if (!GIP_ACQUISITION_MODES.includes(certificate.acquisitionMode)) {
    fail('ACQUISITION_MODE_INVALID', 'acquisitionMode is outside the frozen vocabulary', {})
  }
  if (!GIP_CONTINUATION_LIFETIMES.includes(certificate.continuationLifetime)) {
    fail('CONTINUATION_LIFETIME_INVALID', 'continuationLifetime is outside the frozen vocabulary', {})
  }
  normalizeClosedSet(certificate.supportedConsistencyProofs, GIP_CONSISTENCY_PROOFS, 'supportedConsistencyProofs', 'CONSISTENCY_PROOFS_INVALID')
  normalizeClosedSet(certificate.supportedCompletenessProofs, GIP_COMPLETENESS_PROOFS, 'supportedCompletenessProofs', 'COMPLETENESS_PROOFS_INVALID')
  assertCertificateCrossDimensionLegal(certificate)
  if (certificate.acquisitionMode === 'BOUNDED_READ') return 'WHOLE_RERUN'
  if (certificate.acquisitionMode === 'SEALED_EXPORT') return 'CHUNK_RESUME'
  const proofs = Array.isArray(certificate.supportedConsistencyProofs)
    ? certificate.supportedConsistencyProofs
    : []
  if (certificate.continuationLifetime === 'DURABLE_TOKEN'
    && (proofs.includes('IMMUTABLE_SNAPSHOT_TOKEN')
      || (certificate.acquisitionMode === 'CHANGE_FEED' && proofs.includes('MONOTONIC_VERSION_PIN')))) {
    // Durable-anchor resume: immutable-token page resume, or the CHANGE_FEED
    // watermark resume (scale-D0 §2 row 5's DURABLE_TOKEN(水位)).
    return 'PAGE_RESUME'
  }
  return 'WHOLE_ROUND_RESTART'
}

// ── CertifiedApplyProfile (independent axis; INTERNAL_APPLY_TARGET only) ──────────
function normalizeCertifiedApplyProfile(input) {
  if (!isPlainObject(input)) {
    fail('APPLY_PROFILE_NOT_OBJECT', 'certified apply profile must be a plain object', {})
  }
  // closed top-level shape (review P2): only the two declared fields.
  for (const key of Object.keys(input)) {
    if (!['applyProfileId', 'applyMode'].includes(key)) {
      fail('APPLY_PROFILE_NOT_OBJECT', 'apply profile carries an undeclared top-level field', {
        fieldCount: Object.keys(input).length,
      })
    }
  }
  const applyProfileId = nonBlankString(input.applyProfileId)
  if (!applyProfileId || applyProfileId.length > 128 || !PROFILE_ID_PATTERN.test(applyProfileId)) {
    fail('APPLY_PROFILE_ID_INVALID', 'applyProfileId must match <family>.<name>.v<N> (<=128 chars)', {})
  }
  if (!GIP_APPLY_MODES.includes(input.applyMode)) {
    fail('APPLY_MODE_INVALID', 'applyMode is outside the frozen vocabulary', {})
  }
  return Object.freeze({ applyProfileId, applyMode: input.applyMode })
}

// ── Run-evidence shape validators (machine shapes, not prose) ─────────────────────

// consistencyRequirementStatus (scale-D0 §3, both directions closed):
//   REQUIRED      ⇒ proofClasses non-empty ∧ ⊆ certificate.supportedConsistencyProofs
//   NOT_REQUIRED  ⇒ proofClasses = []
// 'NONE' never enters the proof-class vocabulary — "not required" lives in status.
function validateConsistencyEvidence(profile, evidence) {
  if (!isPlainObject(evidence)) {
    fail('CONSISTENCY_EVIDENCE_INVALID', 'consistency evidence must be a plain object', {})
  }
  for (const key of Object.keys(evidence)) {
    if (!['consistencyRequirementStatus', 'proofClasses'].includes(key)) {
      fail('CONSISTENCY_EVIDENCE_INVALID', 'consistency evidence carries an undeclared field', {})
    }
  }
  const status = evidence.consistencyRequirementStatus
  if (!GIP_CONSISTENCY_REQUIREMENT_STATUSES.includes(status)) {
    fail('CONSISTENCY_STATUS_INVALID', 'consistencyRequirementStatus is outside the frozen vocabulary', {})
  }
  const proofClasses = normalizeClosedSet(
    evidence.proofClasses,
    GIP_CONSISTENCY_PROOFS,
    'proofClasses',
    'CONSISTENCY_EVIDENCE_INVALID',
  )
  if (status === 'NOT_REQUIRED' && proofClasses.length !== 0) {
    fail('CONSISTENCY_EVIDENCE_INVALID', 'NOT_REQUIRED demands an empty proofClasses array', {
      proofClassCount: proofClasses.length,
    })
  }
  if (status === 'REQUIRED') {
    if (proofClasses.length === 0) {
      fail('CONSISTENCY_EVIDENCE_INVALID', 'REQUIRED demands a non-empty proofClasses array', {})
    }
    for (const proof of proofClasses) {
      if (!profile.certificate.supportedConsistencyProofs.includes(proof)) {
        fail('CONSISTENCY_EVIDENCE_INVALID', 'a claimed proof class is not supported by the certificate', {})
      }
    }
  }
  return Object.freeze({ consistencyRequirementStatus: status, proofClasses })
}

// successful run ⇒ usedCompletenessProofs ≠ [] ∧ ⊆ supported ∧ the exact combination
// is declared by the certificate. An empty used set on a "successful" run is an
// ILLEGAL shape (review invariant), whatever the caller claims.
function validateCompletenessEvidence(profile, evidence) {
  if (!isPlainObject(evidence)) {
    fail('COMPLETENESS_EVIDENCE_INVALID', 'completeness evidence must be a plain object', {})
  }
  for (const key of Object.keys(evidence)) {
    if (!['runOutcome', 'usedCompletenessProofs'].includes(key)) {
      fail('COMPLETENESS_EVIDENCE_INVALID', 'completeness evidence carries an undeclared field', {})
    }
  }
  if (evidence.runOutcome !== 'successful') {
    // Only successful runs assert completeness; any other outcome carries no claim —
    // and is normalized to the COARSE token 'not_successful' (never echo an arbitrary
    // caller string into the frozen evidence shape).
    return Object.freeze({ runOutcome: 'not_successful', usedCompletenessProofs: Object.freeze([]) })
  }
  const used = normalizeClosedSet(
    evidence.usedCompletenessProofs,
    GIP_COMPLETENESS_PROOFS,
    'usedCompletenessProofs',
    'COMPLETENESS_EVIDENCE_INVALID',
  )
  if (used.length === 0) {
    fail('COMPLETENESS_EVIDENCE_INVALID', 'a successful run must use at least one completeness proof', {})
  }
  for (const proof of used) {
    if (!profile.certificate.supportedCompletenessProofs.includes(proof)) {
      fail('COMPLETENESS_EVIDENCE_INVALID', 'a used proof is not supported by the certificate', {})
    }
  }
  const usedKey = [...used].sort().join('+')
  const declared = profile.certificate.completenessCombinationRules.some(
    (combo) => [...combo].sort().join('+') === usedKey,
  )
  if (!declared) {
    fail('COMPLETENESS_EVIDENCE_INVALID', 'the used proof combination is not declared by the certificate', {
      usedCount: used.length,
    })
  }
  return Object.freeze({ runOutcome: 'successful', usedCompletenessProofs: used })
}

// Role-type gate (GIP-D0 §5): v1 refuses EXTERNAL_WRITE_TARGET unconditionally —
// external write-back is a separate certification/approval/audit track.
function assertRoleTypeAllowed(roleType) {
  if (!GIP_ROLE_TYPES.includes(roleType)) {
    fail('ROLE_TYPE_INVALID', 'roleType is outside the frozen vocabulary', {})
  }
  if (roleType === 'EXTERNAL_WRITE_TARGET') {
    fail('EXTERNAL_WRITE_TARGET_FORBIDDEN', 'external write-back is disabled in v1 (separate track)', {})
  }
  return roleType
}

module.exports = {
  GIP_ACQUISITION_MODES,
  GIP_CONSISTENCY_PROOFS,
  GIP_CONTINUATION_LIFETIMES,
  GIP_COMPLETENESS_PROOFS,
  GIP_APPLY_MODES,
  GIP_RECOVERY_STRATEGIES,
  GIP_ROLE_TYPES,
  GIP_CROSS_ROLE_TEMPORAL_POLICIES,
  GIP_CONSISTENCY_REQUIREMENT_STATUSES,
  GIP_PROFILE_ERROR_REASONS,
  GipProfileContractError,
  normalizeCertifiedReadActionProfile,
  normalizeCertifiedApplyProfile,
  deriveRecoveryStrategy,
  validateConsistencyEvidence,
  validateCompletenessEvidence,
  assertRoleTypeAllowed,
  __internals: {
    fail,
    normalizeClosedSet,
    assertCertificateCrossDimensionLegal,
    PROFILE_ID_PATTERN,
    READ_CERTIFICATE_FIELDS,
  },
}
