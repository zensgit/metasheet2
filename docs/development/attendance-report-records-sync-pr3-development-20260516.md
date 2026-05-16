# 考勤 report-records 同步层 PR3 开发记录

## Summary

本 slice 完成 `attendance_report_records` 同步层的管理入口与可见证据链：管理员可在统计字段区域输入 `from/to/userId`，触发 `POST /api/attendance/report-records/sync`，并在同一页面看到同步计数、字段指纹、同步时间和打开报表多维表的入口。

## Scope

- 前端：`AttendanceReportFieldsSection.vue` 新增「Report records sync / 报表记录同步」面板。
- 后端：`ensureAttendanceReportRecords()` 同步确保 report-records grid view，并把 `multitable` 定位信息返回给 sync 结果。
- 测试：补 report-records sync 前端用例、degraded warning 用例、stale-null 负路径单测。
- 文档：补 PR3 development / verification，并更新 TODO 状态。

## Key Decisions

- 保持 daily-only v1：表单仍要求 `from`、`to`、`userId`，不做全员、分页、period 汇总。
- `attendance_*` 仍是事实源；sync 只把可重建快照写入插件私有多维表。
- 前端不重写聚合逻辑，只调用 PR2 已落地 writer。
- 打开多维表入口依赖后端返回 `sheetId + viewId`；若 degraded 或 view 不可用，不展示入口。
- `patchRecord` stale-null 规则继续由 writer 执行；PR3 只补一个禁用字段旧值被写 `null` 的完整回归用例。

## Implementation

- `plugins/plugin-attendance/index.cjs`
  - 新增 `ATTENDANCE_REPORT_RECORDS_VIEW_ID = records_by_date`。
  - 新增 `getAttendanceReportRecordsViewDescriptor()`，按 `work_date desc`、`user_id asc`、`synced_at desc` 排序。
  - `ensureAttendanceReportRecords()` 在 `ensureObject + resolveFieldIds` 后尝试 `ensureView`，失败只 warn，不阻断 sync。
  - `syncAttendanceReportRecords()` 返回 `multitable`：`projectId/objectId/baseId/sheetId/viewId`。

- `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`
  - 新增报表记录同步表单：`from/to/userId`。
  - 成功后展示 `synced/created/patched/skipped/failed/duplicateRowKeys`。
  - 展示 `fieldFingerprint/syncedAt` 和 report-records 多维表定位信息。
  - `degraded:true` 显示 warning，不影响统计字段区继续使用。

- `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`
  - 扩展 ensure 测试，锁定 report-records view descriptor。
  - 补 stale-null 负路径：禁用的 managed 字段旧值必须被 patch 为 `null`。

- `apps/web/tests/AttendanceReportFieldsSection.spec.ts`
  - 新增成功同步用例，锁定 POST body、fingerprint 展示和多维表 href。
  - 新增 degraded warning 用例。

## Out Of Scope

- 不做 period/周期汇总。
- 不做全员同步、分页、batch cursor。
- 不做 report-records 多维表公式/视图模板预置。
- 不把 report-records 作为考勤查询/导出的事实源。
- 不做 staging live evidence；缺凭据时只记录为待补。

## Handoff

PR3 合并后，`attendance_report_records` 三段主线闭合：

1. PR1：descriptor + ensure。
2. PR2：sync writer + 幂等/fingerprint/stale-null。
3. PR3：管理员入口 + 可见验证链。

后续建议按产品优先级选择 period 汇总或全员分页同步；两者都应单独 slice。
