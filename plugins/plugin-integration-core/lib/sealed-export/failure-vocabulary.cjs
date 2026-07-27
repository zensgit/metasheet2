'use strict'

// Sealed-export S1 — closed failure vocabulary (issue #4636 deliverable 4).
//
// LATENT: nothing in this directory is wired to a route, scheduler, flag, package
// entry point or any runtime path. `index.cjs` requires each lib module by explicit
// path and never globs, so a module nobody requires has no consumer — asserted
// mechanically by the zero-consumer sweep in
// __tests__/sealed-export-failure-vocabulary.test.cjs.
//
// PROVENANCE / GOVERNANCE STATUS OF THIS SET
// -----------------------------------------
// The token list below is copied byte-for-byte from §10 of
// docs/development/stock-prep-sealed-export-manifest-capability-spike-20260727.md.
// That section states of this exact set: "This exact set is **proposed**, not
// ratified." §12 of the same document lists "failure vocabulary" among the things
// S0 freezes, and issue #4636 lists "closed failure vocabulary" as an S1
// deliverable. Those texts disagree. This module takes NO position on that
// disagreement: it pins the §10 set byte-for-byte so any drift REDs, and the
// question of which text governs is raised for the owner in the PR body. Nothing
// here asserts the set has been ratified.
//
// §10 rules implemented here:
//   - every thrown domain reason is a member of SEALED_EXPORT_FAILURE_REASONS;
//   - an undeclared reason becomes the fixed SEALED_EXPORT_INTERNAL_ERROR and the
//     rejected value is NEVER echoed into the message, the reason or the details;
//   - details expose only fixed field names, booleans, counts and safe tokens —
//     where "safe token" means a member of the first-party closed token set below,
//     never a free string (an arbitrary but syntactically clean ASCII string is
//     REFUSED, see the negative test).
//
// THROW-SITE INVARIANT: this is the ONLY module under lib/sealed-export/ that
// contains a `throw` statement. Every refusal in every sibling module routes
// through failSealedExport(). The invariant is enforced by a comment/string-
// stripping source scan in the vocabulary test, not by this comment.

// ---------------------------------------------------------------------------
// §10 vocabulary — exact set, exact spelling, exact order.
// ---------------------------------------------------------------------------
const SEALED_EXPORT_FAILURE_REASONS = Object.freeze([
  'SEALED_EXPORT_PROFILE_UNCERTIFIED',
  'SEALED_EXPORT_BINDING_UNQUALIFIED',
  'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
  'SEALED_EXPORT_CAPTURE_FAILED',
  'SEALED_EXPORT_CAPTURE_INCOMPLETE',
  'SEALED_EXPORT_SIGNER_UNENROLLED',
  'SEALED_EXPORT_SIGNER_EXPIRED',
  'SEALED_EXPORT_SIGNER_REVOKED',
  'SEALED_EXPORT_MANIFEST_INVALID',
  'SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID',
  'SEALED_EXPORT_MANIFEST_BINDING_MISMATCH',
  'SEALED_EXPORT_MANIFEST_SCHEMA_MISMATCH',
  'SEALED_EXPORT_MANIFEST_SNAPSHOT_MISMATCH',
  'SEALED_EXPORT_MANIFEST_REPLAYED',
  'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
  'SEALED_EXPORT_CHUNK_UNDECLARED',
  'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
  'SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT',
  'SEALED_EXPORT_CHUNK_ORDER_INVALID',
  'SEALED_EXPORT_CHUNK_SET_INCOMPLETE',
  'SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH',
  'SEALED_EXPORT_ROW_COUNT_MISMATCH',
  'SEALED_EXPORT_BUDGET_EXCEEDED',
  'SEALED_EXPORT_ARTIFACT_EXPIRED',
  'SEALED_EXPORT_STAGING_WRITE_FAILED',
  'SEALED_EXPORT_SEAL_INCOMPLETE',
  'SEALED_EXPORT_APPLY_INCOMPLETE',
  'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
  'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
  'SEALED_EXPORT_INTERNAL_ERROR',
])

const FAILURE_REASON_SET = new Set(SEALED_EXPORT_FAILURE_REASONS)

// The fixed substitute §10 names for an undeclared reason.
const SEALED_EXPORT_FIXED_INTERNAL_REASON = 'SEALED_EXPORT_INTERNAL_ERROR'

// ---------------------------------------------------------------------------
// Latent-surface partition (§10 "runtime consumer pin", named honestly).
//
// S1 ships NO runtime consumer — the slice is latent by authorization, so there is
// no runtime to pin. What CAN be pinned exactly is which reasons this latent
// surface can actually raise and which it cannot. The two lists are asserted
// disjoint and to union to the full vocabulary; a new throw site that lights up an
// UNREACHED reason, or one that stops reaching a REACHED reason, REDs the pin.
// ---------------------------------------------------------------------------
const SEALED_EXPORT_S1_REACHED_REASONS = Object.freeze([
  'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
  'SEALED_EXPORT_MANIFEST_INVALID',
  'SEALED_EXPORT_MANIFEST_BINDING_MISMATCH',
  'SEALED_EXPORT_MANIFEST_SCHEMA_MISMATCH',
  'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
  'SEALED_EXPORT_CHUNK_UNDECLARED',
  'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
  'SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT',
  'SEALED_EXPORT_CHUNK_ORDER_INVALID',
  'SEALED_EXPORT_CHUNK_SET_INCOMPLETE',
  'SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH',
  'SEALED_EXPORT_ROW_COUNT_MISMATCH',
  'SEALED_EXPORT_BUDGET_EXCEEDED',
  'SEALED_EXPORT_INTERNAL_ERROR',
])

// Reasons whose preconditions belong to slices S2-S6 (capture, signing, upload
// sessions, tombstones, staging, apply, CAS). S1 owns no code that can raise them.
const SEALED_EXPORT_S1_UNREACHED_REASONS = Object.freeze([
  'SEALED_EXPORT_PROFILE_UNCERTIFIED',
  'SEALED_EXPORT_BINDING_UNQUALIFIED',
  'SEALED_EXPORT_CAPTURE_FAILED',
  'SEALED_EXPORT_CAPTURE_INCOMPLETE',
  'SEALED_EXPORT_SIGNER_UNENROLLED',
  'SEALED_EXPORT_SIGNER_EXPIRED',
  'SEALED_EXPORT_SIGNER_REVOKED',
  'SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID',
  'SEALED_EXPORT_MANIFEST_SNAPSHOT_MISMATCH',
  'SEALED_EXPORT_MANIFEST_REPLAYED',
  'SEALED_EXPORT_ARTIFACT_EXPIRED',
  'SEALED_EXPORT_STAGING_WRITE_FAILED',
  'SEALED_EXPORT_SEAL_INCOMPLETE',
  'SEALED_EXPORT_APPLY_INCOMPLETE',
  'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
  'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
])

// ---------------------------------------------------------------------------
// Details discipline (§10: "fixed field names, booleans, counts, and safe tokens").
// ---------------------------------------------------------------------------
const SEALED_EXPORT_DETAIL_FIELDS = Object.freeze([
  'object', // which contract object was refused (a CONTRACT_OBJECT token)
  'field', // which schema field (a schema key token)
  'canonical', // boolean: did the canonical codec accept the value
  'declaredCount', // count asserted by the untrusted input
  'observedCount', // count this module computed itself
  'chunkIndex', // count
  'expectedChunkIndex', // count
  'budget', // which budget was exceeded (a *_BUDGET token, never its value)
  'state', // lifecycle state token
  'targetState', // lifecycle state token
  'proofClass', // source-capture proof-class token
])
const DETAIL_FIELD_SET = new Set(SEALED_EXPORT_DETAIL_FIELDS)

// Closed first-party token set admissible as a details STRING value. Deliberately
// NOT a syntax check: a syntactically clean ASCII string that is not a member is
// refused, so a customer value can never ride out through a details field. Kept in
// sync with the producing modules by the mirror assertion in the vocabulary test.
const SEALED_EXPORT_SAFE_DETAIL_TOKENS = Object.freeze([
  'ACCEPT',
  'ACTIVE',
  'ACTIVE_POINTER_OUTCOME',
  'APPLYING',
  'BYTE_BUDGET',
  'CAPTURING',
  'CHUNK_BUDGET',
  'CHUNK_DESCRIPTOR',
  'CHUNK_RECEIPT',
  'CHUNK_SUBMISSION',
  'EXPORT_REQUEST_ENVELOPE',
  'EXPIRED',
  'FAILURE',
  'IDEMPOTENT_REPLAY',
  'IMMUTABLE_SNAPSHOT_TOKEN',
  'LIFECYCLE_EVIDENCE',
  'MANIFEST_VERIFIED',
  'NOT_REQUIRED',
  'QUARANTINED',
  'REQUESTED',
  'REVOKED',
  'ROW_BUDGET',
  'SEALED',
  'SIGNED_MANIFEST',
  'SOURCE_SNAPSHOT_TXN',
  'STAGING',
  'SUCCESS',
  'UNENROLLED',
  'UPLOADING',
  'UPLOAD_COMPLETE',
  'VERIFIED',
  'acceptedAt',
  'activePointerOutcome',
  'actionProfileVersion',
  'agentImplementationVersion',
  'agentProtocolVersion',
  'applyProfileVersion',
  'approvedConfigVersionId',
  'byteBudget',
  'byteCount',
  'canonicalObjectVersion',
  'canonicalRowsetMultiplicityDigest',
  'canonicalizationVersion',
  'captureCompletionTimestamp',
  'chunkBudget',
  'chunkCount',
  'chunkDigest',
  'chunkIndex',
  'chunks',
  'cleanupOutcome',
  'configContentKey',
  'domainIsolatedArtifactDigest',
  'domainIsolatedGenerationDigest',
  'domainIsolatedManifestDigest',
  'domainIsolatedSchemaDigest',
  'duration',
  'encodingVersion',
  'executionMode',
  'expectedSourceSchemaFieldMapDigest',
  'expiry',
  'exportRequestEnvelopeDigest',
  'exportRequestId',
  'externalWrite',
  'manifestDigest',
  'manifestExpiry',
  'manifestPresent',
  'nonce',
  'profileToken',
  'proofClassToken',
  'qualificationDigest',
  'queryObjectFilterBindingDigest',
  'reason',
  'retryCount',
  'roleBindingFingerprint',
  'roleId',
  'rowBudget',
  'rowCount',
  'scenarioVersion',
  'signatureAlgorithm',
  'signature',
  'signerKeyId',
  'signerLifecycleState',
  'signingKeyPresent',
  'sourceCaptureIdentity',
  'sourceCaptureProofClass',
  'sourceSchemaDigest',
  'status',
  'systemContentKey',
  'tenantDomainBinding',
  'totalBytes',
  'totalRows',
  'wholeArtifactByteDigest',
])
const SAFE_DETAIL_TOKEN_SET = new Set(SEALED_EXPORT_SAFE_DETAIL_TOKENS)

class SealedExportError extends Error {
  constructor(reason, details) {
    // The message is the reason token itself — a vocabulary member by construction,
    // so the message surface carries no caller-derived text at all.
    super('sealed-export refusal: ' + reason)
    this.name = 'SealedExportError'
    this.reason = reason
    this.details = details
  }
}

function isSafeDetailCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

// Returns a frozen, owned details object, or null when the caller handed over
// anything the §10 details rule does not permit. Null means "refuse the details",
// never "silently drop the offending entry".
function buildSafeDetails(details) {
  if (details === undefined) return Object.freeze({})
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null
  if (Object.getPrototypeOf(details) !== Object.prototype) return null
  if (Object.getOwnPropertySymbols(details).length > 0) return null
  const out = {}
  const names = Object.getOwnPropertyNames(details)
  for (let index = 0; index < names.length; index += 1) {
    const key = names[index]
    if (!DETAIL_FIELD_SET.has(key)) return null
    const descriptor = Object.getOwnPropertyDescriptor(details, key)
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return null
    const value = descriptor.value
    if (typeof value === 'boolean' || isSafeDetailCount(value)) {
      Object.defineProperty(out, key, { value, enumerable: true, writable: false, configurable: false })
      continue
    }
    if (typeof value === 'string' && SAFE_DETAIL_TOKEN_SET.has(value)) {
      Object.defineProperty(out, key, { value, enumerable: true, writable: false, configurable: false })
      continue
    }
    return null
  }
  return Object.freeze(out)
}

// The single throw site of the whole sealed-export surface.
function failSealedExport(reason, details) {
  const declared = typeof reason === 'string' && FAILURE_REASON_SET.has(reason)
  const safeReason = declared ? reason : SEALED_EXPORT_FIXED_INTERNAL_REASON
  // An undeclared reason loses its details entirely: the rejected value must not
  // reach message, reason or details, and details assembled for an undeclared
  // reason cannot be trusted to be about anything this vocabulary knows.
  const safeDetails = declared ? buildSafeDetails(details) : Object.freeze({})
  if (safeDetails === null) {
    throw new SealedExportError(SEALED_EXPORT_FIXED_INTERNAL_REASON, Object.freeze({}))
  }
  throw new SealedExportError(safeReason, safeDetails)
}

function isDeclaredFailureReason(reason) {
  return typeof reason === 'string' && FAILURE_REASON_SET.has(reason)
}

module.exports = {
  SEALED_EXPORT_FAILURE_REASONS,
  SEALED_EXPORT_FIXED_INTERNAL_REASON,
  SEALED_EXPORT_S1_REACHED_REASONS,
  SEALED_EXPORT_S1_UNREACHED_REASONS,
  SEALED_EXPORT_DETAIL_FIELDS,
  SEALED_EXPORT_SAFE_DETAIL_TOKENS,
  SealedExportError,
  failSealedExport,
  isDeclaredFailureReason,
  __internals: Object.freeze({ buildSafeDetails, isSafeDetailCount }),
}
