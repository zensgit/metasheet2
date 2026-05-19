# 考勤报表记录多维表批量同步验证记录 2026-05-18

## Scope

验证 `attendance_report_records` 批量同步扩展：

- 单员工 `{ userId }` 兼容路径不变。
- 显式 `{ userIds }` 去重后逐员工同步。
- 全员 `{ allUsers, page, pageSize }` 通过活跃员工分页选择 userIds。
- 前端可以在单员工和全员分页模式间切换。

## Automated Checks

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts --reporter=dot` | PASS, 20 tests |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot` | PASS, 44 tests |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts --watch=false` | PASS, 21 tests |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 32 tests |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `pnpm --filter @metasheet/core-backend build` | PASS |
| `git diff --check` | PASS |

Frontend Vitest printed `WebSocket server error: Port is already in use`, but the target spec completed successfully.

## Assertions Covered

- Backend helper trims and deduplicates explicit user IDs.
- Backend page helper clamps page size to 100 and computes offset deterministically.
- Bulk explicit sync aggregates two users into one response and keeps second run idempotent.
- All-user page loader prefers active org users and falls back to `attendance_records` distinct user IDs when user-org schema is absent.
- Existing single-user frontend request body remains `{ from, to, userId }`.
- All-user frontend mode sends `{ from, to, allUsers: true, page, pageSize }`.
- Result details expose total users, page, page size, next-page flag, scanned users, synced users, and field fingerprint.

## Local Worktree Note

`pnpm install` in the isolated worktree rewrote tracked plugin/tool `node_modules` symlinks. They are intentionally left unstaged and must not be included in the PR. Stage only the seven source/doc/test files for this slice.
