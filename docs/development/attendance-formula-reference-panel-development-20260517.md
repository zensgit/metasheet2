# 考勤公式函数参考面板开发记录

## Summary

本 slice 落地“内联公式编辑器与函数参考面板”中的低风险前半段：在考勤管理中心“统计字段”区域新增公式函数参考面板，帮助管理员查看 v1 record-scope 公式的字段引用语法、允许函数分组和示例表达式。

本轮不新增后端写接口，不改变公式 validator，不改变记录/导出计算语义，不迁移 `attendance_*`，不直接写 `meta_*`。

## Scope

- 新增前端只读参考面板：`Formula reference / 公式参考`。
- 展示字段引用语法：`{field_code}`、系统字段示例、动态子类型字段示例。
- 展示 v1 允许函数白名单分组：
  - Condition: `IF`
  - Logical: `AND`、`OR`、`NOT`
  - Math: `ROUND`、`CEILING`、`FLOOR`、`ABS`、`MIN`、`MAX`
  - Aggregate: `SUM`、`AVERAGE`、`COUNT`、`COUNTA`
  - Date: `DATEDIF`、`DATEDIFF`、`DATE`、`YEAR`、`MONTH`、`DAY`
  - Text: `CONCAT`、`CONCATENATE`、`LEFT`、`RIGHT`、`MID`、`LEN`、`TRIM`、`UPPER`、`LOWER`
- 展示示例表达式：
  - `={late_duration}+{early_leave_duration}`
  - `=IF({attendance_days}>0,{work_duration},0)`
- 明示禁用项：`NOW`、`TODAY`、lookup、spreadsheet cell references、scripts。
- 更新 TODO：函数参考面板标记完成；内联公式编辑器继续作为独立 P2。

## Files

- `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`
  - 增加 `formulaReferenceGroups` 与 `formulaReferenceExamples`。
  - 在字段筛选区之后、底座状态区之前新增 `data-report-formula-reference` 面板。
  - 增加响应式布局与 chip 样式。
- `apps/web/tests/AttendanceReportFieldsSection.spec.ts`
  - 新增公式参考面板渲染测试。
- `docs/development/attendance-dingtalk-formula-todo-20260515.md`
  - 拆分并勾选“函数参考面板”，保留“内联公式编辑器”待后续。
- `docs/development/attendance-formula-reference-panel-development-20260517.md`
  - 本开发记录。
- `docs/development/attendance-formula-reference-panel-verification-20260517.md`
  - 本验证记录。

## Design Notes

- 参考面板是纯前端只读信息，不复制后端 validator 逻辑执行校验；真实校验仍以 `POST /api/attendance/report-fields/formula/preview` 和后端运行时 validator 为准。
- 面板内容对齐当前 P1/P2 已落地的公式契约：record scope、确定性函数、`{field_code}` 引用、动态子类型字段可作为系统字段参与引用。
- 本 slice 先解决“用户不知道能写什么”的断点；公式存盘和 inline editing 涉及 `PUT /api/attendance/report-fields/:code/formula`、multitable patch、权限与系统/动态字段编辑边界，保留为后续独立实现。

## Out Of Scope

- 不新增公式保存接口。
- 不做自动补全、函数参数文档或函数搜索。
- 不做公式依赖图、循环检测或周期汇总公式。
- 不改变 `formula.allowRawAliases`、reserved-code shadow、dynamic subtype、multi-punch 相关契约。

## Follow-up

- 内联公式编辑器：新增后端 PUT 存盘接口，复用 preview validator，限制只编辑 custom formula 字段。
- 函数参考面板增强：可加入函数参数帮助、搜索、常用模板和字段 picker。
