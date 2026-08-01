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
  entry('plugins/plugin-attendance/index.cjs', 'loadAttendanceRecordForUpdate', 1, 'write_lock'),
  entry('plugins/plugin-attendance/index.cjs', 'applyAttendanceResultEdit', 1, 'correction_write_lock'),
  entry('plugins/plugin-attendance/index.cjs', 'generateAbsenceRecords', 1, 'uniqueness_guard'),
  entry('plugins/plugin-attendance/index.cjs', 'flushRecordUpserts', 2, 'import_write_precondition'),
  entry('plugins/plugin-attendance/index.cjs', 'enqueueManualMissedPunchReminderTransaction', 1, 'current_row_lock_with_explicit_visibility'),
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
