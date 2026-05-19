# 考勤报表同步任务化 PR1 开发记录

Date: 2026-05-19

## Summary

本轮落地 PR1：为 daily `attendance_report_records` 与 period `attendance_report_period_summaries` 的后续任务化 runner 增加运营状态表和 helper skeleton。

范围保持最小：

- 新增 `plugin_attendance_report_sync_jobs` 运营状态表 migration。
- 在考勤插件新增纯/薄 DB helper，用于 normalize create body、构建 insert row、map DB row、create job、load job。
- 更新 TODO 指针与本开发 / 验证记录。

本轮不做 runner、不加 route、不改前端、不触碰现有 sync writer 行为。

## Files

| File | Change |
| --- | --- |
| `packages/core-backend/src/db/migrations/zzzz20260519070000_create_plugin_attendance_report_sync_jobs.ts` | 新增现代 Kysely migration，创建运营状态表、check constraints、索引与 idempotency unique index |
| `plugins/plugin-attendance/index.cjs` | 新增 report sync job helper skeleton，并导出到 `__attendanceReportFieldCatalogForTests` |
| `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts` | 增加 migration source / normalize / insert-load helper 单测 |
| `docs/development/attendance-report-sync-jobs-todo-20260519.md` | PR1 勾选并指向开发 / 验证 MD |
| `docs/development/attendance-report-sync-jobs-pr1-*.md` | 本轮开发与验证记录 |

## Design

### Storage

表名：`plugin_attendance_report_sync_jobs`。

它是控制面 / 运营状态表，不是考勤事实表，不被查询 / 导出读取。表内只保存：

- `kind`: `daily_records` / `period_summaries`
- `status`: `queued` / `running` / `paused` / `completed` / `failed` / `canceled`
- `mode`: `manual_step` / `enqueue`
- `period_source`: `{ from, to }` 或 `{ cycleId }`
- `user_selection`: `{ userId }` / `{ userIds }` / `{ allUsers: true }`
- `cursor`, `totals`, `last_result`, `error`, lock 与时间戳

### Helpers

新增 helper 只做三件事：

- Normalize: 校验 `kind`、`periodSource`、`userSelection`、`mode`、`pageSize`。
- Projection: DB row 映射成 API-friendly job object。
- Persistence skeleton: `createAttendanceReportSyncJob()` / `loadAttendanceReportSyncJob()`。

PR2 runner 会在这些 helper 之上增加 route、lock transition、run-next-page，并委托现有 writer：

- daily: `syncAttendanceReportRecordsForUsers()`
- period: `syncAttendanceReportPeriodSummariesForUsers()`

## Boundaries

- 不直接写 `meta_*`。
- 不新增 `attendance_*` fact migration。
- 不把 job row 当作 report/fact source。
- 不复写 daily / period report statistics。
- 不移除 immediate sync endpoints / UI。
- 不写 staging / production。

## Claude

本轮无需 Claude 开发。若 PR1 需要二审，Claude 适合按 report sync governance 做 independent review。
