# 考勤报表记录多维表批量同步开发记录 2026-05-18

## Summary

本 slice 扩展 `attendance_report_records` 同步层，从原来的单员工 `{ from, to, userId }` 增加两种管理员批量入口：

- 显式员工列表：`{ from, to, userIds: [...] }`
- 全员分页：`{ from, to, allUsers: true, page, pageSize }`

原单员工请求保持兼容，仍走既有 `syncAttendanceReportRecords()` 路径。批量同步只做调度与汇总，每个员工仍复用 PR2 已合并的单员工 writer，不重写考勤聚合、不迁移 `attendance_*`，也不让多维表成为事实源。

## Backend

- `plugins/plugin-attendance/index.cjs`
  - 新增同步分页常量：默认 `pageSize=50`，最大 `100`。
  - 新增 `normalizeAttendanceReportRecordsSyncUserIds()`，对显式 `userId/userIds` 做 trim、去空、去重。
  - 新增 `normalizeAttendanceReportRecordsSyncPage()`，统一页码、页大小和 offset。
  - 新增 `loadAttendanceReportRecordsSyncUserPage()`：
    - 首选 `user_orgs + users` 中的活跃员工。
    - 如果租户或环境缺 schema，降级到 `attendance_records` 日期区间内的 distinct user。
  - 新增 `syncAttendanceReportRecordsForUsers()`：
    - 显式列表或全员分页得到 userIds 后，逐个调用既有 `syncAttendanceReportRecords()`。
    - 汇总 `usersScanned/usersSynced/usersFailed` 与行级 `synced/created/patched/skipped/failed/duplicateRowKeys`。
    - 单用户异常只记入 `failedUsers` 并继续下一用户。
  - 扩展 `POST /api/attendance/report-records/sync`：
    - 继续接受旧 body `{ from, to, userId }`。
    - 新增 `{ userIds }` 和 `{ allUsers, page, pageSize }`。
    - 拒绝同时传 `allUsers` 和显式员工。
    - 缺 `userId/userIds/allUsers` 仍返回 400。

## Frontend

- `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`
  - 在“报表记录同步”区域增加“全部活跃员工”开关。
  - 全员模式下禁用单员工输入，并启用 `page/pageSize` 控件。
  - 旧单员工模式仍发送 `{ from, to, userId }`。
  - 全员模式发送 `{ from, to, allUsers: true, page, pageSize }`。
  - 同步结果展示新增用户维度：总员工、页码、页大小、是否还有下一页、扫描员工、同步员工、失败员工。

## Boundaries

- 不新增 migration。
- 不直接写 `meta_*` 表。
- 不改变 `attendance_records` 或薪资/导出事实源。
- 不把 `attendance_report_records` 作为考勤查询事实源。
- 不实现 cursor 或后台任务队列。全员同步 v1 采用显式分页，由管理员分批触发。

## Follow-up

- 后台 job/cursor 化全员同步。
- 前端增加“下一页继续同步”便捷按钮。
- Live staging evidence：使用真实样本租户验证 allUsers page 与多维表记录数。
