# Attendance Scheduling Conflict Save Guard Verification (2026-05-21)

## Verification Matrix

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| Backend unit: scheduling conflict guard + catalog + formula | PASS, 61 tests |
| Backend integration targeted scheduling routes | PASS command completed, 3 selected tests entered, local DB-backed server path guarded by existing `baseUrl` checks |
| Frontend scheduling specs | PASS, 35 tests |
| `pnpm --filter @metasheet/core-backend build` | PASS |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `git diff --check` | PASS |

## Commands

```bash
node --check plugins/plugin-attendance/index.cjs
```

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-scheduling-assignment-conflict.test.ts \
  tests/unit/attendance-report-field-catalog.test.ts \
  tests/unit/attendance-report-field-formula-engine.test.ts \
  --reporter=dot
```

Result:

```text
3 files passed
61 tests passed
```

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/attendance-plugin.test.ts \
  -t "rejects overlapping active shift and rotation assignments at save time|registers attendance routes and lists plugin|accepts legacy snake_case payload aliases" \
  --reporter=dot
```

Result:

```text
1 file passed
3 tests passed, 72 skipped/filtered
```

Note: the local integration harness keeps its existing `baseUrl`/database guard. This command verifies collection and targeted test wiring in the current worktree; the pure conflict logic is covered by the new unit test without requiring a live integration database.

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendanceScheduleConflictDiagnostics.spec.ts \
  tests/useAttendanceAdminScheduling.spec.ts \
  tests/AttendanceSchedulingAdminSection.spec.ts \
  --watch=false \
  --reporter=dot
```

Result:

```text
3 files passed
35 tests passed
```

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
git diff --check
```

Result:

```text
PASS
```

## Unit Coverage Added

`attendance-scheduling-assignment-conflict.test.ts` covers:

- same-kind shift overlap returns `shift_assignment_overlap`;
- cross-kind shift/rotation overlap returns `rotation_overrides_shift`;
- update paths use `excludeId`;
- inactive drafts short-circuit before querying;
- explicit `endDate: null` clears an existing end date instead of falling back;
- transactional save helper takes the expected per-org/user advisory lock;
- conflict type names stay aligned with frontend diagnostics.

## Integration Coverage Added

`attendance-plugin.test.ts` now includes a route-level scenario for:

- fixed shift assignment overlap -> 409;
- different user overlap -> allowed;
- rotation over fixed shift -> 409;
- inactive rotation overlap -> allowed;
- rotation over rotation -> 409;
- fixed shift update into rotation range -> 409;
- rotation `endDate < startDate` -> 400.

## Boundary Checks

- No `attendance_*` migration added.
- No direct `meta_*` write added.
- No frontend validator added.
- Existing frontend conflict preview remains advisory; backend save routes now enforce the same conflict names.
