# 考勤报表同步任务化 PR3 验证记录

Date: 2026-05-19

## Scope

验证 PR3 的前端 job UI。

不验证后端 route/writer，因为 PR2 已覆盖；不验证 live staging job mode，因为那属于 PR4 live acceptance。

## Local Checks

| Check | Result |
| --- | --- |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts --watch=false` | PASS, 28 tests |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 39 tests |
| `pnpm --filter @metasheet/web build` | PASS |
| `git diff --check` | PASS |
| staged secret scan | PASS |

`pnpm install --ignore-scripts` was run in the isolated PR3 worktree to hydrate local test dependencies. It produced unrelated tracked `node_modules` symlink noise; those paths are intentionally left unstaged and excluded from this slice.

## Unit Coverage Added

- Create daily job:
  - builds `POST /api/attendance/report-sync-jobs` body with `kind=daily_records`
  - maps date range and single user selection into `periodSource` / `userSelection`
  - shows queued job row after create
- Run next page:
  - calls `POST /api/attendance/report-sync-jobs/:id/run-next-page`
  - merges returned job into list
  - shows completed status, totals, and multitable link from `lastResult.multitable`
- Load jobs:
  - calls `GET /api/attendance/report-sync-jobs`
  - renders period cycle job, all-users selection, cursor, totals
- Cancel:
  - calls `POST /api/attendance/report-sync-jobs/:id/cancel`
  - merges canceled job into list
  - disables run/cancel buttons for terminal status

## Boundary Verification

- Existing immediate daily and period sync UI remains in place.
- New UI only calls PR2 job routes.
- No backend code changed in this PR.
- No migration changed in this PR.
- No token or staging output is committed.

## Deferred Checks

These belong to PR4:

- Live acceptance with `JOB_MODE=1`.
- Staging create job -> run pages -> completed evidence.
- Completed job rerun rejection evidence.
