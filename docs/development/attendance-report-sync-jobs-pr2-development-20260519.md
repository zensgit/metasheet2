# 考勤报表同步任务化 PR2 开发记录

Date: 2026-05-19

## Summary

本轮落地 PR2：在 PR1 的 `plugin_attendance_report_sync_jobs` 表与 helper skeleton 之上，增加管理员 job 控制面和单页 runner。

范围保持在 orchestration 层：

- 新增 create / list / get / run-next-page / cancel 五个 admin API。
- 新增 lock、cursor、totals、lastResult、cancel 与 terminal guard helper。
- `run-next-page` 每次只执行一页，daily 委托 `syncAttendanceReportRecordsForUsers()`，period 委托 `syncAttendanceReportPeriodSummariesForUsers()`。
- 不复制 daily / period 的统计、fingerprint、stale-null、duplicate row_key、多维表 upsert 逻辑。

本轮不做前端 UI、不做后台自动 loop、不做 scheduler、不新增 live staging 脚本。

## Files

| File | Change |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | 增加 job list/run/cancel helper、五个 admin route、runner 委托 daily/period writer |
| `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts` | 增加 runner 状态机、分页、period delegation、degraded、fresh lock、cancel/list 单测 |
| `docs/development/attendance-report-sync-jobs-todo-20260519.md` | PR2 勾选并指向本轮开发 / 验证 MD |
| `docs/development/attendance-report-sync-jobs-pr2-*.md` | 本轮开发与验证记录 |

## API

所有路由都要求 `attendance:admin`：

```text
POST /api/attendance/report-sync-jobs
GET  /api/attendance/report-sync-jobs
GET  /api/attendance/report-sync-jobs/:id
POST /api/attendance/report-sync-jobs/:id/run-next-page
POST /api/attendance/report-sync-jobs/:id/cancel
```

`POST /api/attendance/report-sync-jobs` 复用 PR1 的 create input normalize：

- `kind`: `daily_records` / `period_summaries`
- `periodSource`: `{ from, to }` 或 `{ cycleId }`
- `userSelection`: `{ userId }` / `{ userIds }` / `{ allUsers: true }`
- `mode`: `manual_step` / `enqueue`
- `pageSize`: clamp 到现有单页上限

## Runner Design

### Lock

`run-next-page` 先用单条 `UPDATE ... RETURNING *` 获取运行锁：

- `completed` / `canceled` 不可运行，返回 409。
- `running` 且 `locked_at` 未超过 10 分钟 TTL，返回 409。
- stale running lock 可被下一次 run 接管。

### Delegation

daily job：

```js
syncAttendanceReportRecordsForUsers(context, db, orgId, logger, {
  from,
  to,
  allUsers: true,
  page: cursor.nextPage,
  pageSize: cursor.pageSize,
})
```

period job：

```js
syncAttendanceReportPeriodSummariesForUsers(context, db, orgId, logger, {
  period,
  allUsers: true,
  page: cursor.nextPage,
  pageSize: cursor.pageSize,
})
```

显式 `userId` / `userIds` job 一页完成；`allUsers` job 依赖 writer 返回的 `hasNextPage` 推进 `cursor.nextPage`。

### Totals

累计字段：

- `usersScanned`
- `usersSynced`
- `usersFailed`
- `synced`
- `rowsSynced`
- `created`
- `patched`
- `skipped`
- `failed`
- `duplicateRowKeys`

`last_result` 只保存 bounded summary，不持久化大 payload 或敏感值。

### Failure

- writer 返回 `degraded:true`：job 标记 `failed`，cursor 不前进。
- page 内存在 row/user 失败但不是整页失败：累计到 totals，job 可继续。
- 整页 users 全失败：job 标记 `failed`，cursor 不前进。
- unexpected error：job 标记 `failed` 并释放 lock。

## Boundaries

- 不把 job row 当作 report/fact source。
- 不修改 daily / period sync writer 的统计口径。
- 不直接写 `meta_*`。
- 不新增 `attendance_*` fact migration。
- 不删除重复 row_key。
- 不移除 existing immediate sync endpoints。
- 不写 staging / production。

## Claude

本轮由 Codex 实现。PR 打开后 Claude 适合按 report sync governance 做 independent review，重点看 writer delegation、lock/status transition、degraded handling 与边界合同。
