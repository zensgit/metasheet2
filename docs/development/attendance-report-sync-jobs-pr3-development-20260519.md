# 考勤报表同步任务化 PR3 开发记录

Date: 2026-05-19

## Summary

本轮落地 PR3：在统计字段管理区域新增 “Report sync jobs / 报表同步任务” 面板，让管理员能从前端创建、查看、逐页运行和取消 PR2 的同步任务。

范围保持前端控制面：

- 新增 job create 表单，支持 `daily_records` / `period_summaries`。
- 支持 date range 与 payroll cycle 周期来源。
- 支持 single user / userIds / all active users。
- 支持手动加载 job list、run next page、cancel。
- 显示 status、period、user selection、cursor、totals、error、updatedAt。
- 当 job `lastResult.multitable` 带 sheet/view 时展示打开多维表入口。

本轮不改后端 writer / route、不实现 scheduler、不新增 live acceptance。

## Files

| File | Change |
| --- | --- |
| `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue` | 新增 report sync job UI、请求 body 构造、列表渲染与 run/cancel action |
| `apps/web/tests/AttendanceReportFieldsSection.spec.ts` | 增加 create+run、load+cancel 两个 UI 回归测试 |
| `docs/development/attendance-report-sync-jobs-todo-20260519.md` | PR3 勾选并指向本轮开发 / 验证 MD |
| `docs/development/attendance-report-sync-jobs-pr3-*.md` | 本轮开发与验证记录 |

## UI Contract

新增面板不替换既有 immediate sync 面板：

- 上方 `Report records sync` 与 `Period summaries sync` 继续可直接同步。
- 新面板只调用 PR2 job API：
  - `GET /api/attendance/report-sync-jobs`
  - `POST /api/attendance/report-sync-jobs`
  - `POST /api/attendance/report-sync-jobs/:id/run-next-page`
  - `POST /api/attendance/report-sync-jobs/:id/cancel`

## Request Mapping

Daily job:

```json
{
  "kind": "daily_records",
  "mode": "manual_step",
  "pageSize": 50,
  "periodSource": { "from": "2026-05-01", "to": "2026-05-31" },
  "userSelection": { "allUsers": true }
}
```

Period job:

```json
{
  "kind": "period_summaries",
  "mode": "manual_step",
  "pageSize": 50,
  "periodSource": { "cycleId": "..." },
  "userSelection": { "userIds": ["u-1", "u-2"] }
}
```

## State Handling

- `completed` / `canceled` rows disable run and cancel actions.
- `running` rows disable run but can still be canceled.
- Updated job payloads are merged into the local list by `id`.
- Errors are shown in the job panel status area without clearing report field data.

## Boundaries

- No backend code changes.
- No migration changes.
- No `attendance_*` fact changes.
- No direct `meta_*` writes.
- No scheduler or background queue.
- No staging / production writes.

## Claude

本轮由 Codex 实现。若需要二审，Claude 适合按 PR3 frontend contract review：确认 UI 只调用 PR2 routes、保留 immediate sync fallback、没有客户端重写 writer 逻辑、错误状态不清空字段列表。
