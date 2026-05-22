# Attendance Advanced Scheduling Scope Foundation Verification

Date: 2026-05-22
Branch: `codex/attendance-schedule-groups-scope-20260522`

## Scope Verification

| Area | Result |
| --- | --- |
| Runtime domain | Attendance only |
| Data Factory / Bridge Agent | Not touched |
| Frontend UI | Not touched |
| Multitable | Not touched |
| Existing `attendance_groups` | Not altered |
| Existing `attendance_group_members` | Not altered |
| New migration | Adds only advanced scheduling foundation tables |
| Direct `meta_*` writes | None |
| Secrets / tokens | None |

## Boundary Evidence

| Boundary | Evidence |
| --- | --- |
| Separate schedule group model | Migration creates `attendance_schedule_groups` instead of altering `attendance_groups`. |
| Date-aware membership | Migration creates `attendance_schedule_group_members` with `effective_from` / `effective_to` and a date-window check constraint. |
| `attendance_group_members` untouched | Tests assert the migration does not contain `ALTER TABLE attendance_group_members` or a drop of that table. |
| Admin-only setup routes | Tests assert every new route path is wired through `withPermission('attendance:admin', ...)`. |
| Empty scheduler scopes fail closed | Tests assert `normalizeAttendanceSchedulerScopeInput(... scope: {})` throws instead of creating a global non-admin scope. |
| Scope matching is all-targets | Tests assert a scope covering `sg-1` + `u-1/u-2` allows `sg-1/u-1` but rejects `sg-2` or `u-3`. |
| Membership overlap is not silent | Tests assert inclusive overlapping windows are detected and adjacent non-overlap is allowed. |
| Membership overlap is concurrency-guarded | Tests assert the member-create path takes `pg_advisory_xact_lock` before querying existing membership windows and maps exact duplicate `23505` to `409 MEMBERSHIP_OVERLAP`. |

## Test Commands

```bash
node --check plugins/plugin-attendance/index.cjs

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-advanced-scheduling-scope.test.ts \
  tests/unit/attendance-effective-calendar-role-context.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-import-permission.test.ts \
  tests/unit/attendance-scheduling-assignment-conflict.test.ts \
  tests/unit/attendance-advanced-scheduling-scope.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend build

git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax | PASS |
| Advanced scheduling + effective-calendar unit tests | PASS, 12 tests |
| Import permission + conflict + advanced scheduling unit tests | PASS, 13 tests |
| Core backend build | PASS |
| Secret scan on changed code/docs | PASS, no token/private key/JWT literal matches |

## Notes

- The isolated worktree needed `pnpm install --ignore-scripts` to restore local
  `node_modules` links before running the package build. This produced unrelated
  node_modules symlink noise in the worktree; commit staging must explicitly list
  the slice files and must not use `git add -A`.
- This slice does not prove live staging behavior because it does not operate on
  staging/prod. Runtime evidence should start with the next read-only workbench
  or API smoke slice.
