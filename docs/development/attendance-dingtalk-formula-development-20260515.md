# 考勤字段公式能力开发记录

Date: 2026-05-15

## Summary

本轮实现 P1：在既有考勤统计字段多维表底座上增加受限版公式字段能力。`attendance_*` 仍是事实源，多维表继续作为字段目录/配置层，公式字段作为报表字段参与记录展示、JSON 导出、CSV 导出和 evidence fingerprint。

## Backend

- `plugins/plugin-attendance/index.cjs`
  - 字段目录 descriptor 新增公式配置字段：启用公式、公式表达式、公式范围、公式输出类型。
  - 字段合并逻辑读取多维表公式配置，缺失配置时保持内置字段回退。
  - 新增考勤公式包装层：
    - 公式引用语法：`{field_code}`。
    - v1 范围：`record`。
    - 允许确定性函数白名单：`IF`、`AND`、`OR`、`NOT`、`ROUND`、`CEILING`、`FLOOR`、`ABS`、`MIN`、`MAX`、`SUM`、`AVERAGE`、`COUNT`、`COUNTA`、`DATEDIF`、`DATEDIFF`、`DATE`、`YEAR`、`MONTH`、`DAY`、`CONCAT`、`CONCATENATE`、`LEFT`、`RIGHT`、`MID`、`LEN`、`TRIM`、`UPPER`、`LOWER`。
    - 禁止 `NOW`、`TODAY`、lookup 和跨公式字段引用。
    - 公式错误返回 `#ERROR!`，不阻断整行报表。
  - 新增 `POST /api/attendance/report-fields/formula/preview`。
  - 记录接口为每条记录补充 `report_values`，供前端读取公式/custom 字段值。
  - 导出接口改为异步构建报表行，公式字段进入 JSON/CSV。
  - field fingerprint 纳入公式启用状态、表达式、范围、输出类型和校验状态。
- `packages/core-backend/src/services/FormulaService.ts`
  - 将原空实现接到后端 `FormulaEngine`。
  - 支持 `calculateFormula(expression, resolver?)`，保留 `{key}` resolver 注入能力。

## Frontend

- `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`
  - 表格增加“Formula/公式”列。
  - 顶部展示公式字段数和公式错误数。
  - 筛选器增加“公式字段”和“公式错误”。
  - 公式字段展示表达式、record scope、输出类型、引用字段和错误。
- `apps/web/src/views/AttendanceView.vue`
  - 记录表支持读取后端 `report_values` 中的公式字段值。
  - 系统字段仍按既有前端格式化逻辑展示，避免改变老字段的零值显示。

## Live Acceptance

- `scripts/ops/attendance-report-fields-live-acceptance.mjs`
  - 新增 `EXPECT_FORMULA_CODE`。
  - 检查 catalog、records、export 三处公式字段一致性。
  - 报告 metadata 增加公式字段 codes 与 invalid codes。
- `scripts/ops/attendance-report-fields-live-acceptance.test.mjs`
  - mock catalog/records/export 增加 `net_work_minutes` 公式字段。
  - CSV label/code header 覆盖公式字段。

## Compatibility

- 未新增考勤事实表 migration。
- 未改变 `attendance_records` 主存储。
- 未直接操作 `meta_bases/meta_sheets/meta_fields/meta_records`。
- 老字段配置没有公式字段时，接口继续返回内置字段和 `formulaEnabled: false`。

## Known Limits

- v1 不支持公式字段引用公式字段。
- v1 不支持跨记录/跨周期聚合公式。
- v1 不提供内联公式编辑器，编辑入口仍是多维表字段目录。
- v1 将钉钉“打卡时间”和“打卡结果”按单字段聚合展示；上班 1/2/3、下班 1/2/3 六字段拆分列入 P2。
- 当前测试覆盖公式字段主路径、未知字段、`NOW()` 禁用、公式字段引用公式字段禁用，并已按条件/数学/聚合/日期/文本大类覆盖白名单代表函数。
