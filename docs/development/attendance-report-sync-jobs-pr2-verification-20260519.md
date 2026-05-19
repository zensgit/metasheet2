# 考勤报表同步任务化 PR2 验证记录

Date: 2026-05-19

## Scope

验证 PR2 的 job route + one-page runner。

不验证前端 UI、scheduler、自动跨页 loop、live staging job harness，因为这些属于后续 PR3/PR4。

## Local Checks

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts --reporter=dot` | PASS, 32 tests |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot` | PASS, 56 tests |
| `pnpm --filter @metasheet/core-backend build` | PASS |
| `git diff --check` | PASS |
| staged secret scan | PASS |

`pnpm install --ignore-scripts` was run in the isolated PR2 worktree to hydrate local test dependencies. It produced unrelated tracked `node_modules` symlink noise; those paths are intentionally left unstaged and excluded from this slice.

## Unit Coverage Added

- Daily `allUsers` job:
  - first page runs existing daily writer
  - `cursor.nextPage` advances from 1 to 2 when `hasNextPage=true`
  - second page completes when `hasNextPage=false`
  - totals accumulate deterministically across pages
- Period cycle job:
  - resolves `cycleId` through the period resolver
  - delegates to existing period writer
  - explicit `userIds` selection completes in one page even if writer returns `hasNextPage=true`
- Degraded writer:
  - `degraded:true` marks job `failed`
  - cursor is not advanced
  - totals remain trusted only up to the previous completed page
- Lock / terminal guard:
  - fresh running lock returns 409
  - completed job returns 409 on rerun
- List / cancel:
  - status-filtered list returns scoped jobs
  - cancel sets `canceled`, clears lock, sets `finishedAt`
  - canceling a terminal job returns 409

## Route Coverage

Routes are thin wrappers over tested helpers:

- create route calls `createAttendanceReportSyncJob()`
- list route calls `listAttendanceReportSyncJobs()`
- get route calls `loadAttendanceReportSyncJob()`
- run-next-page route calls `runAttendanceReportSyncJobNextPage()`
- cancel route calls `cancelAttendanceReportSyncJob()`

The route layer adds only permission wrapping, HTTP status mapping, DB schema degraded handling, and event emission.

## Boundary Verification

- No direct `meta_*` SQL writes added.
- No new `attendance_*` fact migration added.
- Existing immediate daily / period sync endpoints remain unchanged.
- Job runner delegates to existing writer functions; it does not duplicate report statistics or multitable upsert logic.
- Token and staging output are not committed.

## Deferred Checks

These belong to PR3/PR4:

- Frontend job list and action UI.
- Live acceptance harness with `JOB_MODE=1`.
- Staging run after explicit authorization and file-based JWT.
- Optional queue launcher for `mode=enqueue`.
