# 考勤薪资周期汇总字段模板联动开发记录

Date: 2026-05-18

## Summary

本轮完成薪资周期字段模板联动的后端 PR1。薪资模板继续使用既有 `attendance_payroll_templates.config` JSONB，不新增 migration；周期 summary/export 在读取关联薪资模板后，可按模板配置筛选和排序汇总字段。

## Scope

- 支持模板配置 `config.summaryFieldCodes` 或 `config.summaryFields`。
- 字段来源限定为周期汇总基础指标与 `formula_scope=summary` 的公式字段。
- 未配置字段模板时保持兼容：CSV 仍输出默认汇总指标，并追加可见的 summary 公式字段。
- 模板引用未知字段、record-scope 公式或 disabled/hidden summary 公式时忽略并在 `summaryFieldTemplate.droppedFieldCodes` 中返回。
- 不修改 `attendance_*` 事实源，不把薪资周期 summary 存入多维表，不改多维表公式语法。

## Implementation

- `plugins/plugin-attendance/index.cjs`
  - 新增 `ATTENDANCE_PAYROLL_SUMMARY_DEFAULT_FIELD_CODES`，显式保留既有 CSV 默认字段顺序。
  - 新增 `normalizeAttendancePayrollSummaryFieldTemplateConfig()`，从薪资模板 config 读取 `summaryFieldCodes` / `summaryFields` 并去重，支持 `{ code }` / `{ fieldCode }` 对象。
  - 新增 `buildAttendancePayrollSummaryFieldTemplate()`，按模板解析可输出字段、字段值与 dropped codes。
  - `GET /api/attendance/payroll-cycles/:id/summary` 返回 `summaryFieldTemplate`，用于前端后续展示。
  - `GET /api/attendance/payroll-cycles/:id/summary/export` 与 `/export` 使用同一 `summaryFieldTemplate.fields` 生成 CSV。
- `packages/core-backend/tests/unit/attendance-report-field-formula-engine.test.ts`
  - 覆盖模板字段排序、去重、disabled object、未知字段 drop、CSV 输出顺序与未配置 fallback。
- `docs/development/attendance-dingtalk-formula-todo-20260515.md`
  - 将“与薪资周期字段模板联动”标记为完成，并指向本开发/验证记录。

## Contract

薪资模板字段模板只影响薪资周期 summary/export 的展示和导出顺序，不改变 summary 计算本身。`summaryFieldTemplate.fields[].value` 来自当前 summary payload 或 `summary.formula_values`；模板配置不能让 record-scope 字段进入 period summary。

## Follow-up

- 前端 PR2：在薪资模板区域提供汇总字段模板配置 UI。
- 可选 live evidence：在 staging 创建带 `summaryFields` 的薪资模板和周期后，验证 summary/export 字段顺序。
