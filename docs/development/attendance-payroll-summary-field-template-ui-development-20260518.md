# 考勤薪资周期汇总字段模板前端配置器开发记录

Date: 2026-05-18

## Summary

本轮完成薪资周期字段模板联动的前端 PR2。管理员现在可以在计薪模板表单中直接选择并排序周期汇总字段，保存后写入薪资模板 `config.summaryFields`，由已合并的后端 summary/export 字段模板逻辑消费。

## Scope

- 在真实管理页 `AttendanceView.vue` 的“计薪模板”区域新增“汇总字段模板”配置器。
- 同步扩展抽出的 `AttendancePayrollAdminSection.vue` 和 `useAttendanceAdminPayroll()`，保持后续组件化路径一致。
- 字段选项包含后端默认周期汇总源字段，并从 `/api/attendance/report-fields` 追加 `formula_scope=summary`、启用且报表可见的公式字段。
- 保存模板时把 UI 选择的顺序写入 `config.summaryFields`，同时清理旧别名键 `summaryFieldCodes` / `payrollSummaryFields` / snake_case variants。
- 未选择字段时不写 `summaryFields`，继续使用后端默认字段顺序。

## Implementation

- `apps/web/src/views/attendance/useAttendanceAdminPayroll.ts`
  - 新增 `AttendancePayrollSummaryFieldOption`、基础字段选项常量和字段模板 helper。
  - 新增 `extractPayrollSummaryFieldCodes()`：兼容读取 `summaryFields`、`summaryFieldCodes`、对象 `{ code }` / `{ fieldCode }` 形式，并跳过 `{ enabled:false }`。
  - 新增 `applyPayrollSummaryFieldsToConfig()`：以 UI 选择作为权威配置写回 `summaryFields`。
  - 新增 `loadPayrollSummaryFieldOptions()`：复用统计字段目录接口，只接纳 summary-scope 公式字段。
- `apps/web/src/views/AttendanceView.vue`
  - 在现用计薪模板表单中加入字段模板选择、已选顺序、上移/下移和重载字段入口。
  - `loadAdminData()` 同步加载 summary 字段选项，失败只显示状态错误，不阻断模板表单基础字段。
- `apps/web/src/views/attendance/AttendancePayrollAdminSection.vue`
  - 补齐同款 UI 与绑定接口，避免未来切回抽出组件时功能退化。
- `apps/web/tests/useAttendanceAdminPayroll.spec.ts`
  - 覆盖 summary 公式字段选项加载、保存 `summaryFields` 顺序、编辑已有模板时回填选择。
- `apps/web/tests/AttendancePayrollAdminSection.spec.ts`
  - 覆盖字段选项渲染、选择回调和排序回调。
- `docs/development/attendance-dingtalk-formula-todo-20260515.md`
  - 更新薪资周期字段模板联动项，指向前端 PR2 记录。

## Contract

前端配置器只写薪资模板 JSONB config，不新增迁移，不改变 summary 计算。最终可输出字段仍由后端 PR1 决定：只允许周期汇总基础字段与 `formula_scope=summary` 公式字段；未知字段和 record-scope 公式继续由后端 dropped 机制处理。

## Follow-up

- live evidence：在 staging 创建含 `summaryFields` 的模板和周期，验证 summary/export 字段顺序与 UI 选择一致。
- 若 payroll section 完全组件化，可删除 `AttendanceView.vue` 中的旧内联 payroll 表单重复实现。
