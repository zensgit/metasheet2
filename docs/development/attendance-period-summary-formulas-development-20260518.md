# 考勤周期汇总级公式开发记录

Date: 2026-05-18

## Summary

本 slice 落地 P2「周期汇总级公式」的最小安全版本：在既有考勤统计字段目录中允许 `formula_scope=summary`，并把 summary-scope 自定义公式接入 `/api/attendance/summary`、薪资周期 summary 响应和薪资周期 summary CSV。日明细 record 公式、导出、`attendance_report_records` 同步仍只接 `formula_scope=record`，没有改变事实源、没有新增 migration、没有直接写 `meta_*`。

## Scope

- 扩展公式范围选项：`record` / `summary`，默认仍为 `record`。
- 新增 summary-scope 源指标白名单，包含 `total_minutes`、`leave_minutes`、`overtime_minutes` 等现有 `loadAttendanceSummary()` snake_case 指标，以及常用报表字段别名如 `work_duration`、`late_duration`、`leave_duration`。
- summary-scope validator 使用独立源集合，不复用 record-scope 的行级字段取值，也不允许引用公式字段。
- summary-scope 公式失败时只返回 `#ERROR!`，不阻断整份汇总。
- 前端内联公式编辑器增加 scope 下拉；公式参考面板增加周期汇总提示和示例。

## Backend Changes

- `plugins/plugin-attendance/index.cjs`
  - `ATTENDANCE_REPORT_FIELD_FORMULA_SCOPE_OPTIONS` 增加 `summary`。
  - 新增 `ATTENDANCE_SUMMARY_FORMULA_SOURCE_FIELDS` 与 summary 源 code guard。
  - `validateAttendanceReportFormulaExpression()` 按 `scope` 选择 record 或 summary 引用集合。
  - `resolveAttendanceRecordReportFields()` 排除 `formulaScope=summary`，防止周期公式进入日明细导出和 report-records sync。
  - 新增 `resolveAttendanceSummaryFormulaFields()`、`buildAttendanceSummaryFormulaValueMap()`、`buildAttendanceSummaryFormulaValues()`、`enrichAttendanceSummaryWithFormulaValues()`。
  - `/api/attendance/summary` 返回追加 `formula_values` / `formula_fields`。
  - `/api/attendance/payroll-cycles/:id/summary` 返回追加 summary 公式结果。
  - `buildPayrollSummaryCsv()` 支持将 summary 公式作为追加 metric 行输出。

## Frontend Changes

- `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`
  - 创建/编辑公式字段时可选择 `Record scope` 或 `Summary scope`。
  - 公式预览请求附带 `formulaScope`，让后端用同一套 validator 校验 summary 引用。
  - 公式参考面板更新为 record + summary 双范围说明，并补充 `{total_minutes}` 示例。

## Guardrails

- 不迁移 `attendance_*`，不新增 DB migration。
- 不让多维表或 summary 公式成为事实源。
- 不让 summary formula 进入 daily record report fields / JSON export / CSV export / `attendance_report_records` sync。
- 不放开 formula-to-formula 引用；依赖图仍只做诊断。
- summary source aliases（如 `total_minutes`）作为保留 code，避免被自定义公式字段 shadow。

## Follow-up

- 与薪资周期字段模板联动仍保留为下一条 P2。
- 如需把 summary 公式同步成独立 period report-records 行，需要另开 period-grain writer，不复用 daily row key。
