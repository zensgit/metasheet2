# 考勤周期汇总级公式验证记录

Date: 2026-05-18

## Local Evidence

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-formula-engine.test.ts tests/unit/attendance-report-field-catalog.test.ts --reporter=dot` | PASS, 41 tests |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 24 tests; Vite reported a non-fatal WebSocket port-in-use warning |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `pnpm --filter @metasheet/core-backend build` | PASS |
| `git diff --check` | PASS |

## Coverage Notes

- summary-scope formula `={work_duration}-{leave_duration}+{overtime_minutes}` validates against summary metric sources.
- summary-scope formula is excluded from `resolveAttendanceRecordReportFields()`, so daily report/export/sync surfaces do not receive period-only formula columns.
- summary formula execution resolves aliases from a `loadAttendanceSummary()` shaped object and returns `formula_values`.
- payroll summary CSV appends summary formula metric rows without changing existing fixed metrics.
- preview supports `formulaScope=summary` and validates against summary metric sources, not sample keys.
- record-scope behavior remains covered by existing formula wrapper tests.

## Boundaries Verified

- No migration files added.
- No `attendance_*` fact source migration.
- No direct `meta_*` write path.
- Formula-to-formula remains rejected in v1.
- Summary formula code cannot shadow summary metric aliases such as `total_minutes`.

## Pending

- Full workspace CI after PR creation.
- Optional live staging evidence can be added later by seeding a summary-scope formula and calling payroll cycle summary / summary export against a real cycle.
