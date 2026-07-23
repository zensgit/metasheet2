'use strict'

// GIP-D0 — FIRST concrete Read Action Profile: bridge.bounded_read.v1 (LATENT).
//
// GATE (owner 2026-07-23): the individual certification door for a concrete profile,
// authorized narrowly — "首个具体 Read Action Profile 认证 … 仍保持 latent、零 runtime
// 接线". This module FREEZES and self-verifies the certified capability of a single
// BOUNDED (unpaginated) read over the legacy-SQL read-only bridge. It is NOT wired to
// any runtime: it neither imports nor calls the bridge feeder
// (stock-preparation-readonly-source-run.cjs) — it is a certified SPEC. A drift-guard
// TEST (not this module) imports the feeder's exported constants and asserts the frozen
// numbers still match, so the spec cannot silently diverge from the real source.
//
// Grounding (facts extracted from the real bridge, quoted in the PR):
//   • connector kind (runtime literal)  bridge:legacy-sql-readonly
//     — pagination 'none', limitContract 'adapter_reported' (SOURCE_KIND_CAPABILITIES)
//   • single-page supported bound        BRIDGE_SOURCE_PAGE_SIZE = 500
//     (overflow guard: adapterRowCount > pageSize ⇒ SOURCE_RUN_RESULT_TOO_LARGE)
//     — NOT config.maxLimit (per-deployment default 20) and NOT the cross-kind host
//       ceiling TRUSTED_EXECUTION_MAX_ROW_CAP (1000).
//   • completeness proofs                short_page | declared_total  (the feeder's
//     only two proofs); an adapter's done:true is NEVER a proof (feeder comment
//     "an adapter's `done: true` is NEVER evidence of completeness").
//   • no transaction / snapshot          a single standalone facade SELECT ⇒ the
//     honest consistency-proof set is EMPTY (not a fabricated SOURCE_SNAPSHOT_TXN).
//
// The profileId literal `bridge.bounded_read.v1` decomposes (per PROFILE_ID_PATTERN,
// which cannot hold a colon) to connectorKind `bridge` + action `bounded_read`; the
// precise runtime kind string is carried as implementationVersion. There is no semver
// literal in the source, so implementationVersion anchors to the real kind string
// (drift-guarded against SOURCE_KIND_CAPABILITIES keys) — a deliberate choice.

const {
  normalizeCertifiedReadActionProfile,
  validateCompletenessEvidence,
  deriveRecoveryStrategy,
} = require('./gip-profile-certification-contracts.cjs')

// ── Frozen adjudication error vocabulary (three-layer pin: deepEqual test + runtime
//    fail() consumer + source-level invariant test) ────────────────────────────────
const BRIDGE_BOUNDED_READ_ERROR_REASONS = Object.freeze([
  'BOUNDED_READ_RESULT_INVALID',
  'BOUNDED_READ_CLAMP_UNREPORTED',
  'BOUNDED_READ_CLAMP_EXCEEDS_SUPPORTED_BOUND',
  'BOUNDED_READ_RESULT_EXCEEDS_CLAMP',
  // a declared total is authoritative in BOTH directions (feeder assertKnownSource*):
  'BOUNDED_READ_DECLARED_TOTAL_EXCEEDED', // received > declared (feeder INCONSISTENT)
  'BOUNDED_READ_DECLARED_TOTAL_SHORTFALL', // short page, received < declared (feeder INCOMPLETE)
  'BOUNDED_READ_COMPLETENESS_UNPROVABLE', // full page, no matching total
])
const BRIDGE_BOUNDED_READ_ERROR_REASON_SET = new Set(BRIDGE_BOUNDED_READ_ERROR_REASONS)

class BridgeBoundedReadError extends Error {
  constructor(reason, message, details = {}) {
    super(message)
    this.name = 'BridgeBoundedReadError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details) {
  if (!BRIDGE_BOUNDED_READ_ERROR_REASON_SET.has(reason)) {
    // COARSE fixed token — never echo the rejected reason value.
    throw new Error(
      'gip-bridge-bounded-read-profile internal: undeclared error reason '
        + '(add it to the frozen BRIDGE_BOUNDED_READ_ERROR_REASONS vocabulary)',
    )
  }
  throw new BridgeBoundedReadError(reason, message, details)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireNonNegInt(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    fail('BOUNDED_READ_RESULT_INVALID', `${field} must be a non-negative integer`, { field })
  }
  return value
}

// The certified single-page supported bound. Value is BRIDGE_SOURCE_PAGE_SIZE (500)
// from the real feeder; the drift-guard test asserts equality with the exported symbol
// so this literal can never diverge unnoticed.
const BRIDGE_BOUNDED_READ_MAX_ROWS = 500

// The runtime kind string this profile certifies (drift-guarded against the feeder's
// SOURCE_KIND_CAPABILITIES keys by the test).
const BRIDGE_BOUNDED_READ_IMPLEMENTATION = 'bridge:legacy-sql-readonly'

// ── The certified profile — built (and frozen) through the shared schema normalizer,
//    so it is schema-valid BY CONSTRUCTION (a malformed literal would throw at load). ─
const BRIDGE_BOUNDED_READ_PROFILE = normalizeCertifiedReadActionProfile({
  profileId: 'bridge.bounded_read.v1',
  connectorKind: 'bridge',
  actionId: 'bounded_read',
  implementationVersion: BRIDGE_BOUNDED_READ_IMPLEMENTATION,
  certificate: {
    acquisitionMode: 'BOUNDED_READ',
    // single standalone SELECT, no txn/snapshot ⇒ honest EMPTY consistency set.
    supportedConsistencyProofs: [],
    continuationLifetime: 'SINGLE_REQUEST',
    // the feeder's two real completeness proofs; each provable ALONE.
    supportedCompletenessProofs: ['SHORT_PAGE', 'DECLARED_TOTAL'],
    completenessCombinationRules: [['SHORT_PAGE'], ['DECLARED_TOTAL']],
    maxScale: { maxRowsPerBoundedRead: BRIDGE_BOUNDED_READ_MAX_ROWS },
    // manifest/token/cursor shapes + orderingKeyRequirement + failureVocabulary are
    // intentionally OMITTED: a single BOUNDED_READ page has no cursor/token/manifest,
    // and fail-closed behaviour is proven by adjudicateBoundedReadCompleteness + its
    // test, not by a certificate field. Minimal honest certificate.
  },
})

// Fields the adjudicator accepts on a run-result projection. `adapterDone` is accepted
// but DELIBERATELY never consulted (the feeder distrusts an adapter's done:true as a
// completeness proof) — carrying it in the shape makes "done is never read" a testable
// negative control (a mutation that reads it flips a fail-closed case to accepted).
const BOUNDED_READ_RESULT_FIELDS = Object.freeze([
  'pageRowCount',
  'reportedClamp',
  'sourceDeclaredTotal',
  'adapterDone',
])

function completenessEvidence(proof) {
  return Object.freeze({ runOutcome: 'successful', usedCompletenessProofs: Object.freeze([proof]) })
}

// Adjudicate a SINGLE bounded read's completeness from COUNTS ONLY (values-free) —
// never row content. Returns certificate-legal completeness evidence, or fails closed.
//
//   short page (rows < reported clamp)            ⇒ SHORT_PAGE
//   full page (rows == clamp) + exact trusted total ⇒ DECLARED_TOTAL
//   full page, no/□≠ trusted total, no cursor     ⇒ FAIL-CLOSED (UNPROVABLE)
//   clamp not reported                            ⇒ FAIL-CLOSED (feeder L437-446)
//   adapterDone                                   ⇒ NEVER consulted
function adjudicateBoundedReadCompleteness(runResult) {
  if (!isPlainObject(runResult)) {
    fail('BOUNDED_READ_RESULT_INVALID', 'a bounded-read result projection must be a plain object', {})
  }
  for (const key of Object.keys(runResult)) {
    if (!BOUNDED_READ_RESULT_FIELDS.includes(key)) {
      fail('BOUNDED_READ_RESULT_INVALID', 'the result projection carries an undeclared field', {
        fieldCount: Object.keys(runResult).length,
      })
    }
  }
  const pageRowCount = requireNonNegInt(runResult.pageRowCount, 'pageRowCount')

  // The adapter-reported effective clamp. For an ADAPTER_REPORTED_LIMIT kind it may be
  // absent — and a short page cannot be judged without it, so absence fails closed
  // (mirrors the feeder's SOURCE_RUN_COMPLETENESS_UNPROVABLE when the clamp is null).
  if (runResult.reportedClamp === null || runResult.reportedClamp === undefined) {
    fail('BOUNDED_READ_CLAMP_UNREPORTED', 'the source did not report its effective clamp; short-page cannot be judged', {})
  }
  const clamp = requireNonNegInt(runResult.reportedClamp, 'reportedClamp')
  if (clamp === 0) {
    fail('BOUNDED_READ_RESULT_INVALID', 'reportedClamp must be a positive integer', { field: 'reportedClamp' })
  }
  if (clamp > BRIDGE_BOUNDED_READ_MAX_ROWS) {
    // a clamp beyond the certified supported bound is outside this profile's scope.
    fail('BOUNDED_READ_CLAMP_EXCEEDS_SUPPORTED_BOUND', 'reported clamp exceeds the certified bounded-read maximum', {})
  }
  if (pageRowCount > clamp) {
    // DELIBERATELY STRICTER THAN THE FEEDER, and producer-unreachable: a conforming
    // single-SELECT adapter cannot return more rows than the LIMIT it reports it applied
    // (reportedClamp), so pageRowCount > clamp only happens if the adapter MISREPORTS its
    // clamp. In that non-conforming region the feeder would still try to vouch the page
    // via a declared-total match (its PROOF 1 fires regardless of page fullness); this
    // spec fails closed instead — the SAFE direction (a false-fail, never a false-
    // complete). NB this is NOT the feeder's own overflow guard: SOURCE_RUN_RESULT_TOO_
    // LARGE fires on rows > BRIDGE_SOURCE_PAGE_SIZE (500), a different bound. (PR note:
    // owner may prefer an exact mirror here — see the certification PR.)
    fail('BOUNDED_READ_RESULT_EXCEEDS_CLAMP', 'page row count exceeds the clamp the source reported it applied (non-conforming producer)', {})
  }

  // A declared total (when the source supplies one) is authoritative in BOTH directions
  // and applies to a SHORT page as much as a full one — mirroring the feeder, which
  // validates the declared total (assertKnownSourceNotExceeded / assertKnownSourceComplete)
  // BEFORE it will accept a short_page proof. adapterDone is NEVER consulted.
  const hasTotal = runResult.sourceDeclaredTotal !== null && runResult.sourceDeclaredTotal !== undefined
  let declaredTotal = null
  if (hasTotal) {
    declaredTotal = requireNonNegInt(runResult.sourceDeclaredTotal, 'sourceDeclaredTotal')
    if (pageRowCount > declaredTotal) {
      // more rows than the source declared ⇒ inconsistent (feeder SOURCE_RUN_PAGINATION_INCONSISTENT).
      fail('BOUNDED_READ_DECLARED_TOTAL_EXCEEDED', 'received more rows than the declared total', {})
    }
  }

  // PROOF — an exact declared-total match proves completeness on a SHORT or a FULL page
  // (feeder PROOF 1, fired regardless of pageIsFull).
  if (hasTotal && pageRowCount === declaredTotal) {
    return completenessEvidence('DECLARED_TOTAL')
  }

  // SHORT page: fewer rows than the applied clamp.
  if (pageRowCount < clamp) {
    if (hasTotal && pageRowCount < declaredTotal) {
      // a short page that falls short of a KNOWN total is INCOMPLETE — a short page is
      // NOT self-sufficient proof when the source declared how many rows exist (feeder
      // PROOF 2 runs assertKnownSourceComplete before returning short_page).
      fail('BOUNDED_READ_DECLARED_TOTAL_SHORTFALL', 'short page ended before the declared total', {})
    }
    // short page with NO declared total (the exact-match case returned above) ⇒ complete.
    return completenessEvidence('SHORT_PAGE')
  }

  // FULL page (pageRowCount === clamp) with no matching declared total, and no cursor
  // (BOUNDED_READ is single-request) ⇒ completeness is unprovable — fail closed (the
  // #4437 posture, by design).
  fail('BOUNDED_READ_COMPLETENESS_UNPROVABLE', 'a full bounded page without a matching trusted total cannot prove completeness', {})
}

// Convenience: the DERIVED recovery strategy for this profile (BOUNDED_READ ⇒
// WHOLE_RERUN). Delegates to the shared derivation — never declared here.
function bridgeBoundedReadRecoveryStrategy() {
  return deriveRecoveryStrategy(BRIDGE_BOUNDED_READ_PROFILE.certificate)
}

// A run's completeness evidence must ALSO satisfy the certificate's own combination
// rules — thin re-export so callers/tests validate the adjudicator output against the
// frozen profile in one call.
function assertCompletenessEvidenceCertified(evidence) {
  return validateCompletenessEvidence(BRIDGE_BOUNDED_READ_PROFILE, evidence)
}

module.exports = {
  BRIDGE_BOUNDED_READ_PROFILE,
  BRIDGE_BOUNDED_READ_MAX_ROWS,
  BRIDGE_BOUNDED_READ_IMPLEMENTATION,
  BRIDGE_BOUNDED_READ_ERROR_REASONS,
  BridgeBoundedReadError,
  adjudicateBoundedReadCompleteness,
  bridgeBoundedReadRecoveryStrategy,
  assertCompletenessEvidenceCertified,
  __internals: { fail, BOUNDED_READ_RESULT_FIELDS },
}
