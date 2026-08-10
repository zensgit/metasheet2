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
//   - `last_result` itself, EXACTLY (corrected — this previously overstated allowlist coverage):
//     `persistAttendanceReportSyncJobPageState` (index.cjs ~L3611/~L3615) writes
//     `last_result = $6::jsonb` from `JSON.stringify(state.lastResult ?? {})` (index.cjs ~L3628)
//     UNCONDITIONALLY — it does not itself sanitize; whatever `state.lastResult` its caller
//     passes is what lands in the column. Of `runAttendanceReportSyncJobNextPage`'s FOUR call
//     sites (index.cjs, same function, ~L3706/~L3717/~L3733/~L3744): TWO pass
//     `sanitizeAttendanceReportSyncJobLastResult(pageResult)` (index.cjs ~L3475) — an explicit
//     allowlist of counters/scope metadata plus `failedUsers` (see below) — but the OTHER TWO
//     (the `page.ok === false` branch, ~L3706, and the outer `catch` block, ~L3744) pass a raw
//     `{ error: <message> }` / `{ error: <message>, code: <code> }` object straight through,
//     bypassing the sanitizer entirely. `<message>` there is `page.message` or
//     `error instanceof Error ? error.message : String(error)` — an ARBITRARY upstream exception
//     string from whatever failed inside `executeAttendanceReportSyncJobPage`'s call chain
//     (which reaches the real per-user writer, `syncAttendanceReportRecords`, which itself reads
//     real attendance-fact columns — work_minutes/late_minutes/first_in_at/etc. — before ever
//     calling the multitable write API). This module did NOT audit every throw site in that call
//     chain for whether an exception message could ever echo a fact value; the honest claim is
//     "unbounded upstream error text, not allowlisted," not "covered by the allowlist."
//   - `failedUsers`'s shape is NOT uniformly `{userId, failedRows}[]` either: that shape is only
//     what the SUCCESS-path per-user loop pushes when `result.failed > 0`
//     (`aggregate.failedUsers.push({ userId, failedRows: ... })`). The loop's OWN `catch` block —
//     same function, both `syncAttendanceReportRecordsForUsers` (index.cjs ~L3163) and
//     `syncAttendanceReportPeriodSummariesForUsers` (index.cjs ~L4451) — pushes
//     `{ userId, error: error instanceof Error ? error.message : String(error) }` instead: same
//     unbounded-upstream-message caveat as above, for HALF of what actually produces this array.
//   - `mergeAttendanceReportSyncJobTotals` sums numeric counters only (this claim holds — it only
//     ever adds `Number(...)`-coerced values from the fixed `ATTENDANCE_REPORT_SYNC_JOB_TOTAL_KEYS`
//     set, plus the `failedUsers` array handled above).
//   - `executeAttendanceReportSyncJobPage` (index.cjs, same section) delegates the ACTUAL report
//     row writes to the existing canonical writers, `syncAttendanceReportRecordsForUsers` /
//     `syncAttendanceReportPeriodSummariesForUsers` — the writer the ruling cites at
//     plugins/plugin-attendance/index.cjs:3177's docblock. These four sites never touch a report
//     row directly.
// CONCLUSION UNCHANGED, basis corrected: none of the four sites issues DML against a report row —
// diagnostics (an error string, a per-user failure count) are not attendance facts or results
// even when their CONTENT is not allowlist-bounded, and this registration was never contingent on
// `last_result`'s contents being allowlist-pure — only on these four not writing report rows. That
// narrower, correct claim is what discharges the owner's condition; the broader allowlist claim
// above it was simply wrong and is corrected here, not retracted-and-reasoned-around.
// (If a future site here were found to write facts/results, the ruling requires STOPPING and
// reporting it, not registering it — see the ruling text above.)
//
// A REAL fifth write to this table exists in the repository today, outside the owner's named
// four: `scripts/ops/staging-attendance-report-sync-a2-smoke.mjs:724`, a `DELETE FROM
// ${REPORT_SYNC_JOB_TABLE} WHERE org_id = ANY($1::text[])` inside that staging smoke tool's own
// `cleanup()` routine. The evidence read for this fifth site is WEAKER and of a DIFFERENT KIND
// than the owner's four (which were checked against sanitizeAttendanceReportSyncJobLastResult's
// explicit allowlist and executeAttendanceReportSyncJobPage's delegation, above): all that was
// read here is the enclosing `cleanup()` function and the `WHERE org_id = ANY(...)` scoping —
// enough to say it deletes job-cursor rows the smoke test itself created, scoped by org, and
// nothing more. It is NOT registered here — the owner named exactly four, and adding a fifth on
// this module's own authority would be exactly the "broad debt waiver" the ruling forbids, and
// this thinner evidence read would not support that claim on its own even if scope allowed it.
// It is intentionally left to classify as `unclaimed` by operational-control-plane-classify.cjs
// against the real repo, so it stays visible rather than silently absorbed or silently dropped.
// See the collector test file's own assertion of this fact — an open disposition question for
// the owner, not resolved by this module.

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
