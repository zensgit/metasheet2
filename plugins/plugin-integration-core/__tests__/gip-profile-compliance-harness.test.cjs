'use strict'

// GIP-D0 A2 — compliance-harness battery. Plain node test. Hermetic + values-free.
// The harness's own load-bearing proof: it must PASS a schema-clean fixture, FAIL a
// broken one, and its report must stay values-free.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  BATTERY_CHECK_IDS,
  runReadActionProfileComplianceBattery,
  summarizeBatteryForEvidence,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'gip-profile-compliance-harness.cjs'))

function fixtureProfile(overrides = {}) {
  const base = {
    profileId: 'fixture.paged_read.v1',
    connectorKind: 'fixture',
    actionId: 'paged_read',
    implementationVersion: 'spike-0',
    certificate: {
      acquisitionMode: 'PAGED_READ',
      supportedConsistencyProofs: ['SOURCE_SNAPSHOT_TXN'],
      continuationLifetime: 'CONNECTION_BOUND',
      supportedCompletenessProofs: ['SHORT_PAGE', 'DECLARED_TOTAL'],
    },
  }
  return { ...base, ...overrides, certificate: { ...base.certificate, ...(overrides.certificate || {}) } }
}

// 1. A schema-clean candidate passes the whole battery (all mutants rejected).
function cleanCandidatePasses() {
  const report = runReadActionProfileComplianceBattery(fixtureProfile())
  const failed = report.checks.filter((entry) => !entry.ok)
  assert.deepEqual(failed, [], `battery must pass for a clean fixture: ${JSON.stringify(failed)}`)
  assert.equal(report.passed, true)
  // full expected check id roster — a silently-skipped probe is a battery hole
  assert.deepEqual(report.checks.map((entry) => entry.checkId), [
    'C1_schema_valid',
    'C2_unknown_acquisition_rejected',
    'C2b_duplicate_set_entry_rejected',
    'C3_empty_completeness_rejected',
    'C4_applymode_smuggle_rejected',
    'C5_recovery_declaration_rejected',
    'C6_sealed_export_without_manifest_rejected',
    'C7_change_feed_without_pin_rejected',
    'C8_durable_token_without_immutable_rejected',
    'C9_bounded_read_lifetime_rejected',
    'C10_recovery_derived_stable',
    'C11a_required_empty_proofclasses_rejected',
    'C11b_notrequired_nonempty_rejected',
    'C11c_successful_empty_used_rejected',
    'C11d_unsupported_used_rejected',
    'C11e_undeclared_combination_rejected',
  ])
  // for the default fixture (2 supported proofs, singleton combos) C11e must be a REAL probe
  const c11e = report.checks.find((entry) => entry.checkId === 'C11e_undeclared_combination_rejected')
  assert.equal(c11e.observed, 'COMPLETENESS_EVIDENCE_INVALID')
}

// The harness's own accepted-mutant branch is LOAD-BEARING (review P2): a fixture
// run() that does NOT throw must yield ok:false/'accepted_mutant'; a wrong-reason
// throw must yield ok:false; only the expected rejection yields ok:true.
function expectRejectionIsLoadBearing() {
  const accepted = __internals.expectRejection('probe', ['SOME_REASON'], () => {})
  assert.deepEqual(accepted, { checkId: 'probe', ok: false, observed: 'accepted_mutant' })
  const wrong = __internals.expectRejection('probe', ['SOME_REASON'], () => { throw new Error('plain') })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.observed, 'non_contract_error')
}

// 2. A schema-broken candidate fails at C1 and the battery stops (no vacuous green).
function brokenCandidateFails() {
  const report = runReadActionProfileComplianceBattery(fixtureProfile({ certificate: { supportedCompletenessProofs: [] } }))
  assert.equal(report.passed, false)
  assert.equal(report.checks.length, 1)
  assert.equal(report.checks[0].checkId, 'C1_schema_valid')
  assert.equal(report.checks[0].ok, false)
  assert.equal(report.checks[0].observed, 'COMPLETENESS_PROOFS_EMPTY')
}

// 3. Values-free report: candidate content never leaks into the report.
function reportIsValuesFree() {
  const MARKER = 'fixture_secret_marker_value'
  const report = runReadActionProfileComplianceBattery(fixtureProfile({ implementationVersion: MARKER }))
  assert.ok(!JSON.stringify(report).includes(MARKER), 'battery report must not carry candidate content')
  const summary = summarizeBatteryForEvidence(report)
  assert.equal(summary.passed, true)
  assert.equal(summary.checkCount, 16)
  assert.deepEqual(summary.failedCheckIds, [])
  assert.ok(!JSON.stringify(summary).includes(MARKER))
}

// 4. The battery works for every legal acquisition family (matrix coverage smoke).
function batteryCoversAllFamilies() {
  const families = [
    fixtureProfile({ certificate: { acquisitionMode: 'BOUNDED_READ', continuationLifetime: 'SINGLE_REQUEST', supportedConsistencyProofs: [], supportedCompletenessProofs: ['SHORT_PAGE'] } }),
    fixtureProfile(), // PAGED_READ / CONNECTION_BOUND
    fixtureProfile({ certificate: { acquisitionMode: 'PAGED_READ', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['IMMUTABLE_SNAPSHOT_TOKEN'] } }),
    fixtureProfile({ certificate: { acquisitionMode: 'SEALED_EXPORT', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['IMMUTABLE_SNAPSHOT_TOKEN'], supportedCompletenessProofs: ['SIGNED_MANIFEST'] } }),
    fixtureProfile({ certificate: { acquisitionMode: 'CHANGE_FEED', continuationLifetime: 'DURABLE_TOKEN', supportedConsistencyProofs: ['MONOTONIC_VERSION_PIN'], supportedCompletenessProofs: ['DECLARED_TOTAL'] } }), // scale-D0 §2 row 5
  ]
  for (const candidate of families) {
    const report = runReadActionProfileComplianceBattery(candidate)
    assert.equal(report.passed, true, `family battery must pass: ${candidate.certificate.acquisitionMode}`)
  }
}

// 5. summarize is fail-closed on garbage AND on out-of-roster check ids (review P2:
//    the values-free projection must never echo caller-controlled ids).
function summarizeFailClosed() {
  assert.deepEqual(summarizeBatteryForEvidence(null), { passed: false, checkCount: 0, failedCheckIds: ['REPORT_INVALID'] })
  const MARKER = 'caller_smuggled_check_id_marker'
  const crafted = { passed: false, checks: [{ checkId: MARKER, ok: false, observed: 'x' }] }
  const summary = summarizeBatteryForEvidence(crafted)
  assert.deepEqual(summary, { passed: false, checkCount: 0, failedCheckIds: ['REPORT_INVALID'] })
  assert.ok(!JSON.stringify(summary).includes(MARKER))
  // the roster itself is exact-pinned and exported
  assert.deepEqual([...BATTERY_CHECK_IDS], [
    'C1_schema_valid',
    'C2_unknown_acquisition_rejected',
    'C2b_duplicate_set_entry_rejected',
    'C3_empty_completeness_rejected',
    'C4_applymode_smuggle_rejected',
    'C5_recovery_declaration_rejected',
    'C6_sealed_export_without_manifest_rejected',
    'C7_change_feed_without_pin_rejected',
    'C8_durable_token_without_immutable_rejected',
    'C9_bounded_read_lifetime_rejected',
    'C10_recovery_derived_stable',
    'C11a_required_empty_proofclasses_rejected',
    'C11b_notrequired_nonempty_rejected',
    'C11c_successful_empty_used_rejected',
    'C11d_unsupported_used_rejected',
    'C11e_undeclared_combination_rejected',
  ])
}

// 6. C11e full-powerset (review P2): "all pairs + triple, NO singletons" must still
//    exercise a real negative probe (an undeclared SINGLETON exists); only a candidate
//    declaring EVERY non-empty subset gets the explicit not-applicable marker.
function c11ePowerset() {
  const allThree = ['SHORT_PAGE', 'DECLARED_TOTAL', 'SIGNED_MANIFEST']
  const pairs = [['SHORT_PAGE', 'DECLARED_TOTAL'], ['SHORT_PAGE', 'SIGNED_MANIFEST'], ['DECLARED_TOTAL', 'SIGNED_MANIFEST']]
  const evasion = fixtureProfile({
    certificate: {
      supportedCompletenessProofs: allThree,
      completenessCombinationRules: [...pairs, allThree],
    },
  })
  const evasionReport = runReadActionProfileComplianceBattery(evasion)
  const evasionC11e = evasionReport.checks.find((entry) => entry.checkId === 'C11e_undeclared_combination_rejected')
  assert.equal(evasionC11e.observed, 'COMPLETENESS_EVIDENCE_INVALID', 'undeclared singleton must be probed')
  assert.equal(evasionReport.passed, true)

  const exhaustive = fixtureProfile({
    certificate: {
      supportedCompletenessProofs: allThree,
      completenessCombinationRules: [...allThree.map((proof) => [proof]), ...pairs, allThree],
    },
  })
  const exhaustiveReport = runReadActionProfileComplianceBattery(exhaustive)
  const exhaustiveC11e = exhaustiveReport.checks.find((entry) => entry.checkId === 'C11e_undeclared_combination_rejected')
  assert.equal(exhaustiveC11e.observed, 'not_applicable_all_combinations_declared')
}

function main() {
  cleanCandidatePasses()
  expectRejectionIsLoadBearing()
  brokenCandidateFails()
  reportIsValuesFree()
  batteryCoversAllFamilies()
  summarizeFailClosed()
  c11ePowerset()
  console.log('gip-profile-compliance-harness.test.cjs OK')
}

main()
