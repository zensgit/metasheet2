'use strict'

// #4556 W4C-4 §12.7: every calculation/segment SELECT is either an active-current
// projection or an explicitly historical/internal read. The collector supplies the generated
// census; this closed table is the reviewable owner for every runtime direct read.

function entry(relPath, enclosingSymbol, table, count, posture, role, requiredPredicateFingerprint = null) {
  return Object.freeze({
    relPath,
    enclosingSymbol,
    table,
    count,
    posture,
    role,
    requiredPredicateFingerprint,
  })
}

const ATTENDANCE_CALCULATION_READ_CLASSIFICATIONS = Object.freeze([
  entry('packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', 'nextCalculationVersion', 'attendance_record_calculations', 1, 'history', 'version_allocation'),
  entry('packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', 'nextCalculationVersion', 'attendance_record_calculations', 1, 'history', 'version_allocation'),
  entry('packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', 'appendLegacyBaselineIfRequired', 'attendance_record_calculations', 1, 'history', 'legacy_baseline_precondition'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts', 'legacyDeleteEligible', 'attendance_record_calculations', 1, 'history', 'rollback_precondition'),
  entry('packages/core-backend/src/attendance/w4c3a-import-rollback.ts', 'buildAuthorizationInput', 'attendance_record_calculations', 1, 'history', 'rollback_history'),
  entry('packages/core-backend/src/attendance/w4c3a-rollout-control.ts', 'loadBatchReferenceState', 'attendance_record_calculations', 3, 'history', 'rollout_precondition'),
  entry('packages/core-backend/src/attendance/w4c3b-approved-leave-cancellation.ts', 'appendApprovedLeaveCancellationCalculationV1', 'attendance_record_calculations', 2, 'history', 'approval_reversal_precondition'),
  entry('packages/core-backend/src/attendance/w4c3b-approved-leave-cancellation.ts', 'appendApprovedLeaveCancellationCalculationV1', 'attendance_record_segments', 1, 'history', 'approval_reversal_precondition'),
  entry('packages/core-backend/src/attendance/w4c3c-active-current.ts', '(module-scope)', 'attendance_record_calculations', 2, 'current', 'active_current_projection', 'current_relation=attendance_current_records'),
  entry('packages/core-backend/src/attendance/w4c3c-manual-edit-apply.ts', 'appendManualOverrideCalculationV1', 'attendance_record_calculations', 3, 'history', 'manual_override_precondition'),
  entry('packages/core-backend/src/attendance/w4c3c-manual-edit-apply.ts', 'appendManualOverrideCalculationV1', 'attendance_record_segments', 2, 'history', 'manual_override_precondition'),
  entry('packages/core-backend/src/attendance/w4c3c-ops-retirement.ts', 'appendOperatorRetirementCalculationV1', 'attendance_record_calculations', 2, 'history', 'operator_retirement_precondition'),
  entry('packages/core-backend/src/attendance/w4c3c-recompute.ts', 'appendRecomputeCalculationV1', 'attendance_record_calculations', 3, 'history', 'recompute_precondition'),
  entry('packages/core-backend/src/attendance/w4c3c-recompute.ts', 'appendRecomputeCalculationV1', 'attendance_record_segments', 1, 'history', 'recompute_precondition'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readAttendanceCalculationDetail', 'attendance_record_calculations', 2, 'history', 'authorized_current_or_history_detail'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readAttendanceCalculationDetail', 'attendance_record_segments', 1, 'history', 'authorized_current_or_history_detail'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readAttendanceW4ShadowBacklog', 'attendance_record_calculations', 1, 'history', 'values_free_shadow_backlog'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readAuthoritativeTraceCalculation', 'attendance_record_calculations', 1, 'current', 'immutable_current_trace', 'visibility_state=active'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readShadowTraceCalculation', 'attendance_record_calculations', 1, 'history', 'immutable_shadow_trace'),
  entry('packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', 'readTraceSegments', 'attendance_record_segments', 1, 'history', 'immutable_authorized_trace_segments'),
  entry('plugins/plugin-attendance/index.cjs', 'loadW4c3cRecordSubjectForOperation', 'attendance_record_calculations', 2, 'history', 'operation_subject_precondition'),
])

function keyOf(site) {
  return `${site.relPath} :: ${site.enclosingSymbol} :: ${site.table}`
}

function classifyAttendanceCalculationReadSites(
  sites,
  classifications = ATTENDANCE_CALCULATION_READ_CLASSIFICATIONS,
) {
  const expected = new Map(classifications.map((classification) => [keyOf(classification), classification]))
  const actualCounts = new Map()
  const classifiedSites = []
  const unclassified = []
  const predicateDrift = []

  for (const site of sites) {
    if (site.relPath.startsWith('scripts/')) {
      classifiedSites.push({ ...site, posture: 'history', role: 'operator_fixture_or_audit' })
      continue
    }
    if (site.relPath.includes('/migrations/')) {
      classifiedSites.push({ ...site, posture: 'history', role: 'schema_migration' })
      continue
    }
    const key = keyOf(site)
    const classification = expected.get(key)
    if (!classification) {
      unclassified.push(site)
      continue
    }
    actualCounts.set(key, (actualCounts.get(key) || 0) + 1)
    classifiedSites.push({ ...site, posture: classification.posture, role: classification.role })
    if (classification.requiredPredicateFingerprint !== null
      && site.requiredPredicateFingerprint !== classification.requiredPredicateFingerprint) {
      predicateDrift.push({
        ...classification,
        actual: site.requiredPredicateFingerprint,
      })
    }
  }

  const countDrift = []
  const stale = []
  for (const [key, classification] of expected) {
    const actual = actualCounts.get(key) || 0
    if (actual === 0) stale.push(classification)
    else if (actual !== classification.count) countDrift.push({ ...classification, actual })
  }

  return { classifiedSites, unclassified, countDrift, stale, predicateDrift }
}

module.exports = {
  ATTENDANCE_CALCULATION_READ_CLASSIFICATIONS,
  classifyAttendanceCalculationReadSites,
}
