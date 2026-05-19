# 考勤 Period Rollup PR3 设计记录

Date: 2026-05-19

## Summary

本轮为 `attendance_report_period_summaries` 增加前端同步入口。PR1 已 provision 周期汇总对象，PR2 已提供 `POST /api/attendance/report-period-summaries/sync` writer；PR3 只在考勤统计字段区域接入 UI，不改后端计算、不改事实源、不新增 migration。

边界保持不变：`attendance_*` 仍是事实源；周期汇总多维表只是可重建报表快照；前端只调用插件 API，不直接读写 `meta_*`。

## Files

- `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`
  - 新增「Period summaries sync」面板。
  - 支持 date range 与 payroll cycle 两种 period source。
  - 支持 single user、userIds list、all active users + page/pageSize。
  - 展示 synced / created / patched / skipped / failed / duplicate row keys / users counters / field fingerprint / syncedAt。
  - 成功后提供打开 `attendance_report_period_summaries` 多维表 view 的入口。
- `apps/web/tests/AttendanceReportFieldsSection.spec.ts`
  - 增加 period sync UI 与请求 body、结果展示、degraded、error 路径测试。
- `docs/development/attendance-report-period-rollup-sync-todo-20260519.md`
  - 补充 PR3 落地指针。

## UI Contract

新增面板使用独立 `data-report-period-summary-sync-*` selector，不复用 daily sync selector，避免测试与行为互相污染。

请求 body 由 UI 模式确定：

- date range + single user：
  - `{ from, to, userId }`
- payroll cycle + userIds：
  - `{ cycleId, userIds }`
- date range / payroll cycle + all users：
  - `{ from, to, allUsers, page, pageSize }` 或 `{ cycleId, allUsers, page, pageSize }`

禁用规则：

- date range 模式必须填写 `from` 与 `to`。
- payroll cycle 模式必须填写 `cycleId`。
- user scope 必须三选一：single user、userIds list、all users。
- all users 模式才启用 `page` / `pageSize`。

## Status Semantics

- `data.degraded === true` 显示 warn 状态，不清空字段面板。
- HTTP 非 2xx 或 `{ ok:false }` 显示 error 状态，不清空字段面板。
- 成功结果展示 multitable object / sheet / view IDs，并生成 `/multitable/:sheetId/:viewId?baseId=...` 链接。

## Boundary Notes

- 不触 `plugins/plugin-attendance/index.cjs`。
- 不新增后端 route、schema、migration。
- 不让前端重写 period rollup 参数校验；最终校验仍在 PR2 后端 route。
- staging live evidence 需要 PR3 合并并部署到 staging 后再补；本轮只做前端 mock/contract 验证。
