# 考勤 Period Rollup PR2 开发记录

Date: 2026-05-19

## Summary

本轮实现 `attendance_report_period_summaries` 的后端 writer 与同步接口。PR1 已提供 descriptor / ensure；PR2 在此基础上把每员工每周期一行的 summary 快照写入插件私有多维表对象。

边界保持不变：`attendance_*` 仍是事实源；period summaries 只是可重建报表层；写入只通过 `context.api.multitable.provisioning.ensureObject()` 与 `records.createRecord/patchRecord`，不裸写 `meta_*`，不新增 migration，不改前端。

## Files

- `plugins/plugin-attendance/index.cjs`
  - 新增 period summary writer helper、row key、source fingerprint、动态 subtype 周期汇总、cycle/date-range period resolver。
  - 新增 `POST /api/attendance/report-period-summaries/sync`。
  - 导出 PR2 helper 到 `__attendanceReportFieldCatalogForTests`。
- `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`
  - 新增 period helper / resolver / upsert / skip / duplicate / subtype / stale-null / bulk explicit users 单测。

## Public Interface

新增接口：

`POST /api/attendance/report-period-summaries/sync`

body 支持二选一 period source：

- `{ from, to, userId | userIds | allUsers, page?, pageSize? }`
- `{ cycleId, userId | userIds | allUsers, page?, pageSize? }`

互斥规则：

- `cycleId` 与 `from/to` 同传返回 400。
- 缺少 `cycleId` 且缺少 `from/to` 返回 400。
- `cycleId` 非 UUID 返回 400。
- `cycleId` 不存在返回 404。
- `allUsers` 与 `userId/userIds` 同传返回 400。
- 未选择用户返回 400。

row key：

- date range：`${orgId}:${userId}:range:${from}:${to}`
- payroll cycle：`${orgId}:${userId}:cycle:${cycleId}`

period type：

- date range：`date_range`
- payroll cycle：`payroll_cycle`

## Data Flow

1. route 解析 period：
   - date range 走 `resolveAttendanceDateRange()`。
   - payroll cycle 读取 `attendance_payroll_cycles` 并映射 `startDate/endDate/name`。
2. writer 确保 `attendance_report_period_summaries` 对象可用。
3. 读取字段配置：
   - summary 默认字段来自 `ATTENDANCE_SUMMARY_FORMULA_SOURCE_FIELDS`。
   - summary 公式字段来自字段 catalog。
   - 动态请假/加班 subtype 字段来自 `loadAttendanceReportDynamicSubtypeContext()`。
4. 生成 managed value columns：
   - summary 默认字段始终 managed。
   - summary-scope 公式字段作为 managed superset，即使 disabled / hidden 也保留列，用于 stale-null。
   - active dynamic subtype 字段进入 managed set。
5. 计算值：
   - 基础周期指标复用 `loadAttendanceSummary()`。
   - subtype 周期值复用 `loadApprovedMinutesRange()` 的 `reportSubtypeMinutes`，按周期求和。
   - summary 公式复用 `enrichAttendanceSummaryWithFormulaValues()`。
6. upsert：
   - 按物理 `fld_row_key` query。
   - 无记录则 create。
   - 有记录且 `source_fingerprint` + `field_fingerprint` 双等则 skip。
   - 否则 patch。
   - 多条同 row_key 只 patch 第一条，计 `duplicateRowKeys`，不自动删除。
   - managed 但非 active 的值列显式写 `null`，防止停用字段残留脏值。

## Notes

- PR2 不实现前端入口；前端入口与 live evidence 留 PR3。
- `allUsers` 分页复用 daily report-records 的 user page helper，优先 active org users，schema 缺失时 fallback 到 attendance_records owners。
- period summary 可以在无 daily record 的周期写出 0 值 summary 行；员工名称来自 `users`，部门/考勤组来自周期内最近一条 attendance record meta，缺失则为空。
- 动态 subtype schema 缺失时降级为空 subtype set，不阻断基础 summary。
