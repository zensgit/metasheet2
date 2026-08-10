'use strict'

// #4556 W4C-0 follow-up — owner ruling on the report-sync job control-plane writes:
//
//   "#4835 四处 report-sync job 写入按 migrations-derived 域和 exact-site 方式纳管为 operational
//   control plane，不删除、不作宽泛债务豁免。"
//
// The exact tuple the owner specified: (file, symbol, table, verb, fingerprint, multiplicity).
// Precision is the point — this is NOT a per-file or per-table exemption (the broad debt waiver
// the ruling rejects). Each entry approves exactly one (relPath, symbol, table, verb) identity,
// to occur exactly `multiplicity` times, with the exact statement fingerprint below. Changing any
// field of the identity, changing the observed count, or changing the statement text all RED
// against operational-control-plane-classify.cjs — see that module and the collector test file's
// mutation legs for the executed proof.
//
// Why these four, and why "control plane" not "facts/results" (the owner's condition this
// registration is contingent on — discharged here, not assumed):
//   - the table's own migration docblock
//     (packages/core-backend/src/db/migrations/zzzz20260519070000_create_plugin_attendance_report_sync_jobs.ts)
//     states: "Operational cursor/progress state ... not an attendance fact source ... not read
//     by attendance query/export paths."
//   - the table's columns are job-lifecycle bookkeeping only: status/mode/cursor/totals/
//     last_result/locked_at/started_at/finished_at/error/idempotency_key — no user/date/hours
//     rows.
//   - `sanitizeAttendanceReportSyncJobLastResult` (index.cjs) writes `last_result` through an
//     explicit allowlist of counters and scope metadata (periodType/from/to/usersScanned/
//     synced/created/patched/skipped/failed/duplicateRowKeys/fieldFingerprint/syncedAt/...) plus
//     `failedUsers: {userId, failedRows}[]` — counts and identifiers, never a per-user attendance
//     value (clock time, hours, status).
//   - `mergeAttendanceReportSyncJobTotals` sums numeric counters only.
//   - `executeAttendanceReportSyncJobPage` (index.cjs, same section) delegates the ACTUAL report
//     row writes to the existing canonical writers, `syncAttendanceReportRecordsForUsers` /
//     `syncAttendanceReportPeriodSummariesForUsers` — the writer the ruling cites at
//     plugins/plugin-attendance/index.cjs:3177's docblock. These four sites never touch a report
//     row directly.
// None of the four writes attendance facts or results; all four discharge the owner's condition.
// (If a future site here were found to write facts/results, the ruling requires STOPPING and
// reporting it, not registering it — see the ruling text above.)
//
// A REAL fifth write to this table exists in the repository today, outside the owner's named
// four: `scripts/ops/staging-attendance-report-sync-a2-smoke.mjs:724`, a `DELETE FROM
// ${REPORT_SYNC_JOB_TABLE} ...` inside that staging smoke tool's own `cleanup()` routine. It is
// NOT registered here — the owner named exactly four, and adding a fifth on this module's own
// authority would be exactly the "broad debt waiver" the ruling forbids. It is intentionally left
// to classify as `unclaimed` by operational-control-plane-classify.cjs against the real repo, so
// it stays visible rather than silently absorbed or silently dropped. See the collector test
// file's own assertion of this fact, and the handoff note for the disposition question this
// leaves open for the owner.

const OPERATIONAL_CONTROL_PLANE_REGISTRY = Object.freeze([
  Object.freeze({
    relPath: 'plugins/plugin-attendance/index.cjs',
    symbol: 'createAttendanceReportSyncJob',
    table: 'plugin_attendance_report_sync_jobs',
    verb: 'insert',
    fingerprint: 'e0bfa2fb11744560503e01beb53553e5f4a8cb7f7a0fb16580fb0dce53315525',
    multiplicity: 1,
  }),
  Object.freeze({
    relPath: 'plugins/plugin-attendance/index.cjs',
    symbol: 'lockAttendanceReportSyncJobForRun',
    table: 'plugin_attendance_report_sync_jobs',
    verb: 'update',
    fingerprint: 'b010260a86f28f5d8546655c60bfeeac84eb159d1dc706e8588defac2a802c3f',
    multiplicity: 1,
  }),
  Object.freeze({
    relPath: 'plugins/plugin-attendance/index.cjs',
    symbol: 'persistAttendanceReportSyncJobPageState',
    table: 'plugin_attendance_report_sync_jobs',
    verb: 'update',
    fingerprint: 'ed8a4ce9737348121ae1998270c918040b5a9948837e6a3f9be483b6ed464410',
    multiplicity: 1,
  }),
  Object.freeze({
    relPath: 'plugins/plugin-attendance/index.cjs',
    symbol: 'cancelAttendanceReportSyncJob',
    table: 'plugin_attendance_report_sync_jobs',
    verb: 'update',
    fingerprint: '47f3fb30d961b1176079315457afd26dc34fefc2197451a988f5030847afda01',
    multiplicity: 1,
  }),
])

module.exports = { OPERATIONAL_CONTROL_PLANE_REGISTRY }
