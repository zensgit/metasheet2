# 考勤 multi-punch ingest-persist 验证记录

Date: 2026-05-17

## Verification Matrix

| Layer | Command | Result |
| --- | --- | --- |
| Plugin syntax | `node --check plugins/plugin-attendance/index.cjs` | PASS |
| Backend unit | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot` | PASS, 32 tests |
| Frontend unit | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 19 tests |
| Web type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Core backend build | `pnpm --filter @metasheet/core-backend build` | PASS |
| Diff hygiene | `git diff --check` | PASS |

## Evidence Targets

- Import helper maps `clockIn2/clockOut2/clockIn3/clockOut3` aliases into `attendance_records.meta`.
- Import helper maps `punchResultIn/Out1..3` aliases into `attendance_records.meta`.
- Time-only values such as `13:00` resolve against `workDate` and timezone.
- Override mode writes `null` for missing managed punch keys to clear stale values.
- Punch result fields do not reuse day-level `status`.
- Existing punch split report fields read the newly persisted meta values.
- Report-records sync path remains unchanged and benefits through the existing export/report field value path.

## Test Evidence

- `buildAttendanceImportMultiPunchMeta` maps time aliases and result aliases into the exact report-field meta keys.
- Time-only `13:00` with `workDate=2026-05-13` and `timezone=UTC` persists as `2026-05-13T13:00:00.000Z`.
- Override mode emits `null` for missing `clockOut3` / `punchResultOut3`, and `computeAttendanceRecordUpsertValues` serializes those nulls so old meta values are cleared.
- Report-field readback confirms:
  - `punch_in_2` reads persisted `clockIn2`.
  - `punch_result_in_1` reads persisted `punchResultIn1`.
  - `punch_result_out_2` reads persisted `punchResultOut2`.
  - missing result slot returns empty string, not day-level `status`.

## Worktree Hygiene

- `pnpm install` was required in the isolated worktree to run Vitest and type-check.
- It modified tracked plugin/tool `node_modules` symlink entries in the worktree; these are dependency-install noise and are intentionally not part of this slice.
- Stage/commit must explicitly list the six slice files and must not use `git add -A`.

## Boundaries Checked

- No new migration.
- No `attendance_*` schema change.
- No direct `meta_*` SQL write.
- No formula engine behavior change.
- No report-records writer behavior change.

## Staging Notes

- 8082 staging daily report-records sync evidence was completed before this slice and appended to PR #1609.
- This slice does not run a new live import against staging; targeted unit coverage locks the ingest-persist behavior. A staging import fixture can be run later if product wants UI-level evidence.
