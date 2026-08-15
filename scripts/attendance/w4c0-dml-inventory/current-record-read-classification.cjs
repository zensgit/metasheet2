'use strict'

// #4556 W4C-3a §7.6 — every ordinary attendance-record read uses the canonical current view.
// Direct base-table reads are a closed set of history, write-lock, rollback, or operator-audit
// paths. A new runtime base read must be classified deliberately instead of inheriting a broad
// table allowlist.

function entry(relPath, enclosingSymbol, count, role) {
  return Object.freeze({ relPath, enclosingSymbol, count, role })
}

const ATTENDANCE_RECORD_BASE_READ_CLASSIFICATIONS = Object.freeze([
  entry('packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', 'lockShadowParentRecord', 1, 'write_lock'),
  // #4556 W4C-2 Gate D2 (#4844): the authoritative live-punch branch re-reads the parent row it
  // has held `FOR UPDATE` since `lockShadowParentRecord`, AFTER the core's pointer UPDATE, to
  // return the persisted row as the wire response's `record`. It MUST be the base table, not the
  // current view: the response has to carry the row for a REVIEW outcome too, whose parent is a
  // `retired`/`review_placeholder` row the view deliberately excludes — and the public punch
  // contract has always returned the row the write just produced. This read exposes the row only
  // to the punching actor as the acknowledgement of their own write; it is not an ordinary
  // listing/report surface (all of which stay on the view — see the §7.5 reader trace in the
  // boundary's own placeholder docblock).
  entry('packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', 'executeLivePunch', 1, 'write_response_echo'),
  // #4556 W4C-2 Gate D1 (#4844): the INERT authoritative-result-write CORE locks the exact base
  // parent row FOR UPDATE before moving its pointer/visibility — it MUST read the base table (not
  // the current view) to serialize the pointer move and to read the true projection_owner /
  // current_calculation_id it supersedes. INERT: no production caller yet (D2/D3 wire it).
  entry('packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', 'lockParent', 1, 'write_lock'),
  // #4556 W7-2: the group_shadow comparison recorder at the AUTHORITATIVE
  // producer sites (P1/P3a) re-reads the base parent row this transaction
  // already holds FOR UPDATE, AFTER the core wrote through it, as the SERVED
  // projection the comparison diffs against. Base table on purpose: a review
  // outcome leaves a retired/review_placeholder parent the current view
  // excludes, and the comparison must still record against the row as served.
  entry('packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', 'readServedComparableProjection', 1, 'w7_compare_served_projection'),
  // #4556 W7-2: the compare-window counters JOIN the base record table purely
  // to window calculations by (user_id, work_date) — values-free counting over
  // the shadow partition, never a listing/report surface (those stay on the
  // view). Five sites: selector-totality gate, critical count, off-roster
  // candidate fetch, coverage count, fail-close count.
  entry('packages/core-backend/src/attendance/w7-compare-window-status.ts', 'readAttendanceW7CompareWindowStatusV1', 5, 'w7_compare_window_counters'),
  entry('packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', 'captureParentPreimages', 1, 'historical_preimage'),
  entry('packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', 'ensureAuthoritativeParent', 1, 'write_precondition'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts', 'loadAuthorizationTargets', 1, 'rollback_authority'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts', 'loadLegacyTargets', 1, 'rollback_authority'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts', 'loadW4Targets', 2, 'rollback_authority'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts', 'legacyDeleteEligible', 1, 'rollback_precondition'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts', 'executeLegacyRollback', 1, 'rollback_write_lock'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback.ts', 'readTargetRecords', 1, 'rollback_history'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts', 'lockAndFreezeAttendanceRecordPreconditionsV1', 1, 'write_lock'),
  entry('packages/core-backend/src/attendance/w4c3a-legacy-plan-preconditions.ts', 'revisionMatches', 2, 'write_precondition'),
  entry('packages/core-backend/src/attendance/w4c3a-rollout-control.ts', 'lockTargetsAndParents', 1, 'rollout_precondition'),
  entry('packages/core-backend/src/attendance/w4c3a-rollout-control.ts', 'loadBatchReferenceState', 1, 'rollout_precondition'),
  // W4C-5: entry into eligible|authoritative locks every candidate record row (FOR UPDATE) while
  // it re-evaluates whether the record still carries an unresolved legacy-ingress review.
  entry('packages/core-backend/src/attendance/w4c3a-rollout-control.ts', 'countUnresolvedIngressReviews', 1, 'rollout_precondition'),
  entry('packages/core-backend/src/attendance/w4c3b-approved-leave-cancellation.ts', 'appendApprovedLeaveCancellationCalculationV1', 1, 'approval_reversal_write_lock'),
  entry('plugins/plugin-attendance/index.cjs', 'loadAttendanceRecordForUpdate', 1, 'write_lock'),
  entry('plugins/plugin-attendance/index.cjs', 'applyAttendanceResultEdit', 1, 'correction_write_lock'),
  entry('plugins/plugin-attendance/index.cjs', 'generateAbsenceRecords', 1, 'uniqueness_guard'),
  entry('plugins/plugin-attendance/index.cjs', 'flushRecordUpserts', 2, 'import_write_precondition'),
  entry('plugins/plugin-attendance/index.cjs', 'enqueueManualMissedPunchReminderTransaction', 1, 'current_row_lock_with_explicit_visibility'),
  // W4C-3c: operator retirement, recompute, and manual override lock the base parent before write.
  entry('packages/core-backend/src/attendance/w4c3c-ops-retirement.ts', 'appendOperatorRetirementCalculationV1', 1, 'write_lock'),
  entry('packages/core-backend/src/attendance/w4c3c-ops-retirement.ts', 'buildOperatorRetirementCleanupPlanSqlV1', 1, 'operator_fixture_or_audit'),
  entry('packages/core-backend/src/attendance/w4c3c-recompute.ts', 'appendRecomputeCalculationV1', 1, 'write_lock'),
  entry('packages/core-backend/src/attendance/w4c3c-manual-edit-apply.ts', 'appendManualOverrideCalculationV1', 1, 'write_lock'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readAttendanceCalculationDetail', 3, 'calculation_detail_current_or_history_scope'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readAuthoritativeTraceCalculation', 1, 'immutable_current_trace_scope'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readShadowTraceCalculation', 1, 'immutable_shadow_trace_scope'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readTraceSegments', 1, 'immutable_authorized_trace_segment_scope'),
  entry('plugins/plugin-attendance/index.cjs', 'loadW4c3cRecordSubjectForOperation', 1, 'write_precondition'),
])

function keyOf(site) {
  return `${site.relPath} :: ${site.enclosingSymbol}`
}

function classifyAttendanceRecordReadSites(
  sites,
  classifications = ATTENDANCE_RECORD_BASE_READ_CLASSIFICATIONS,
) {
  const expected = new Map(classifications.map((classification) => [keyOf(classification), classification]))
  const actualCounts = new Map()
  const classifiedSites = []
  const unclassified = []

  for (const site of sites) {
    if (site.table === 'attendance_current_records') {
      classifiedSites.push({ ...site, posture: 'current', role: 'ordinary_current_view' })
      continue
    }
    if (site.relPath.startsWith('scripts/')) {
      classifiedSites.push({ ...site, posture: 'historical', role: 'operator_fixture_or_audit' })
      continue
    }
    if (site.relPath.includes('/migrations/')) {
      classifiedSites.push({ ...site, posture: 'historical', role: 'schema_migration' })
      continue
    }
    const key = keyOf(site)
    const classification = expected.get(key)
    if (!classification) {
      unclassified.push(site)
      continue
    }
    actualCounts.set(key, (actualCounts.get(key) || 0) + 1)
    classifiedSites.push({ ...site, posture: 'historical', role: classification.role })
  }

  const countDrift = []
  const stale = []
  for (const [key, classification] of expected) {
    const actual = actualCounts.get(key) || 0
    if (actual === 0) stale.push(classification)
    else if (actual !== classification.count) countDrift.push({ ...classification, actual })
  }

  return { classifiedSites, unclassified, countDrift, stale }
}

module.exports = {
  ATTENDANCE_RECORD_BASE_READ_CLASSIFICATIONS,
  classifyAttendanceRecordReadSites,
}
