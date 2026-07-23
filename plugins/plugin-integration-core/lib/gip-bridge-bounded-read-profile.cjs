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
  'BOUNDED_READ_COMPLETENESS_UNPROVABLE', // full page ⇒ no completeness proof available
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

// The registered runtime CONNECTOR KIND this profile certifies (review P2: the kind is
// the full runtime kind — it must NOT be borrowed by implementationVersion). Drift-
// guarded against the feeder's SOURCE_KIND_CAPABILITIES keys by the test.
const BRIDGE_BOUNDED_READ_CONNECTOR_KIND = 'bridge:legacy-sql-readonly'

// The adapter IMPLEMENTATION VERSION — a SEPARATE, incrementable identity (review P2).
// Drift-guarded against the adapter's exported BRIDGE_READONLY_ADAPTER_IMPLEMENTATION_
// VERSION by the test; a bump there forces re-certification here.
const BRIDGE_BOUNDED_READ_IMPLEMENTATION_VERSION = 'bridge-readonly-adapter.v1'

// ── The certified profile — built (and frozen) through the shared schema normalizer,
//    so it is schema-valid BY CONSTRUCTION (a malformed literal would throw at load). ─
const BRIDGE_BOUNDED_READ_PROFILE = normalizeCertifiedReadActionProfile({
  profileId: 'bridge.bounded_read.v1',
  connectorKind: BRIDGE_BOUNDED_READ_CONNECTOR_KIND,
  actionId: 'bounded_read',
  implementationVersion: BRIDGE_BOUNDED_READ_IMPLEMENTATION_VERSION,
  certificate: {
    acquisitionMode: 'BOUNDED_READ',
    // single standalone SELECT, no txn/snapshot ⇒ honest EMPTY consistency set.
    supportedConsistencyProofs: [],
    continuationLifetime: 'SINGLE_REQUEST',
    // SHORT_PAGE ONLY (review P1): the concrete bridge adapter reports its applied limit
    // (metadata.limit ⇒ effectiveLimit) so short_page is REACHABLE, but it NEVER
    // propagates a source total (no sourceTotalCount / dataRowCount), so the feeder's
    // declared_total proof is UNREACHABLE for this adapter. Certifying DECLARED_TOTAL
    // would overstate the adapter's real capability — a trusted total needs an agent
    // protocol + adapter propagation + same-read binding, i.e. a separate runtime /
    // profile-v2 gate.
    supportedCompletenessProofs: ['SHORT_PAGE'],
    completenessCombinationRules: [['SHORT_PAGE']],
    maxScale: { maxRowsPerBoundedRead: BRIDGE_BOUNDED_READ_MAX_ROWS },
    // failureVocabulary binds the profile's EXACT error semantics to its version (review
    // P2: RATIFIED GIP-D0's complete contract carries it) — sourced from the ONE frozen
    // BRIDGE_BOUNDED_READ_ERROR_REASONS list, exact-pinned by the test. manifest/token/
    // cursor/orderingKey shapes stay OMITTED (a single BOUNDED_READ page has none).
    failureVocabulary: [...BRIDGE_BOUNDED_READ_ERROR_REASONS],
  },
})

// Fields the adjudicator accepts on a run-result projection. `adapterDone` is accepted
// but DELIBERATELY never consulted (the feeder distrusts an adapter's done:true as a
// completeness proof) — carrying it in the shape makes "done is never read" a testable
// negative control (a mutation that reads it flips a fail-closed case to accepted).
// v1 accepts COUNTS ONLY. A `sourceDeclaredTotal` is DELIBERATELY not an accepted field
// (review P1): this profile certifies SHORT_PAGE only, so a declared total is refused
// fail-closed as an unknown field rather than silently ignored — trusted totals are a
// profile-v2 capability. `adapterDone` is accepted but never consulted.
const BOUNDED_READ_RESULT_FIELDS = Object.freeze([
  'pageRowCount',
  'reportedClamp',
  'adapterDone',
])

function completenessEvidence(proof) {
  return Object.freeze({ runOutcome: 'successful', usedCompletenessProofs: Object.freeze([proof]) })
}

// Adjudicate a SINGLE bounded read's completeness from COUNTS ONLY (values-free) —
// never row content. SHORT_PAGE is this profile's only completeness proof (review P1).
//
//   short page (rows < reported clamp)   ⇒ SHORT_PAGE (proof)
//   full page  (rows == reported clamp)  ⇒ FAIL-CLOSED (UNPROVABLE — no proof available)
//   clamp not reported                   ⇒ FAIL-CLOSED (feeder L437-446)
//   rows > clamp                         ⇒ FAIL-CLOSED (outside conforming contract)
//   adapterDone                          ⇒ NEVER consulted
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
    // DELIBERATELY STRICTER THAN THE FEEDER (review P3, owner chose keep-strict): the
    // feeder treats rows >= appliedPageSize as a "full page" and would still try to vouch
    // it (e.g. via a declared-total match); this spec fails closed. This region is OUTSIDE
    // THE CONFORMING CONTRACT BUT RUNTIME-REACHABLE — the bridge adapter does NOT trim the
    // records an agent returns, so an anomalous agent can genuinely return more rows than
    // the clamp it reported. Failing closed is the SAFE direction (a false-fail, never a
    // false-complete). NB this is NOT the feeder's own overflow guard: SOURCE_RUN_RESULT_
    // TOO_LARGE fires on rows > BRIDGE_SOURCE_PAGE_SIZE (500), a different bound.
    fail('BOUNDED_READ_RESULT_EXCEEDS_CLAMP', 'page row count exceeds the clamp the source reported it applied', {})
  }

  // adapterDone is NEVER consulted (feeder: an adapter's done:true is never a proof).
  // SHORT page: fewer rows than the applied clamp — the source had no more to give.
  if (pageRowCount < clamp) {
    return completenessEvidence('SHORT_PAGE')
  }

  // FULL page (pageRowCount === clamp): this profile has NO other completeness proof
  // (declared_total is unreachable for this adapter — review P1), and BOUNDED_READ has no
  // cursor, so completeness is unprovable — fail closed (the #4437 posture, by design).
  fail('BOUNDED_READ_COMPLETENESS_UNPROVABLE', 'a full bounded page has no available completeness proof for this profile', {})
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
  BRIDGE_BOUNDED_READ_CONNECTOR_KIND,
  BRIDGE_BOUNDED_READ_IMPLEMENTATION_VERSION,
  BRIDGE_BOUNDED_READ_ERROR_REASONS,
  BridgeBoundedReadError,
  adjudicateBoundedReadCompleteness,
  bridgeBoundedReadRecoveryStrategy,
  assertCompletenessEvidenceCertified,
  __internals: { fail, BOUNDED_READ_RESULT_FIELDS },
}
