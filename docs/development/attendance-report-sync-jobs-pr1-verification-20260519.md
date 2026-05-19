# 考勤报表同步任务化 PR1 验证记录

Date: 2026-05-19

## Scope

验证 PR1 的 schema + helper skeleton。

不验证 runner、route、UI、live staging，因为本轮没有实现这些能力。

## Local Checks

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts --reporter=dot` | PASS, 27 tests |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot` | PASS, 51 tests |
| `pnpm --filter @metasheet/core-backend build` | PASS |
| `git diff --check` | 待最终执行 |
| staged secret scan | 待最终执行 |

`pnpm install --ignore-scripts` was run in the isolated worktree to hydrate local test dependencies. It produced unrelated tracked `node_modules` symlink noise under plugin/tool packages; those paths are intentionally left unstaged and excluded from this slice.

## Unit Coverage Added

- Migration source includes:
  - `plugin_attendance_report_sync_jobs`
  - `kind/status/mode` check constraints
  - `period_source/user_selection/cursor/totals` JSONB state
  - idempotency unique index
  - no accidental `attendance_report_sync_jobs` fact-like table name
- Create input normalization:
  - date range job
  - payroll cycle job
  - `pageSize` max clamp
  - `userIds` dedupe
  - invalid kind
  - cycleId plus from/to rejection
  - ambiguous user selection rejection
- Persistence helper skeleton:
  - build insert row
  - map DB row
  - create job inserts JSONB payloads
  - load job scopes by `org_id`
  - invalid job id returns validation error

## Deferred Checks

These belong to PR2 runner/routes:

- lock transition and stale-lock resume
- `run-next-page`
- daily writer delegation
- period writer delegation
- degraded writer marks job failed
- cancel/completed terminal behavior

## Boundary Verification

- No `meta_*` SQL writes added.
- No `attendance_*` fact schema migration added.
- No route / frontend / live script changed.
- Token and staging output are not committed.
