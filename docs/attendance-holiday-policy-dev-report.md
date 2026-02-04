# 考勤节假日策略与规则引擎 - 开发报告

日期：2026-02-04

## 范围
- 合并 `feat/attendance-framework-20260128` 到 `main`。
- 增加节假日首日基准工时模板规则，避免硬编码到业务规则里。
- 支持节假日策略「按节日名称覆盖」：为指定节日配置首日基准工时与加班叠加策略。
- 引擎上下文补充 `holiday_policy_enabled`，支持“全局节假日策略”与“规则模板”互斥生效。
- 调整班次时间优先级：当班次名称包含时间段时，优先使用班次时间而非 `shiftMappings`。
- 文档更新：规则模板库与变更记录。

## 关键改动
- 新增模板规则：`节假日首日基准工时`（规则 ID：`holiday-default-8h`）
  - 条件：节假日首日 + 全局节假日策略未启用
  - 动作：将应出勤/实出勤置为可配置小时数（默认 8 小时）
- 规则引擎上下文：新增 `holiday_policy_enabled` 字段
  - 用于在规则层判断是否应跳过模板
- 班次时间优先级：
  - 当 `shiftName` 中包含时间段（如 `08:00-12:00`）时，优先使用该时间段计算工时
  - 仅在班次名称不包含时间段时，才应用 `policies.shiftMappings`
- 文档更新：
  - `docs/attendance-rule-template-holiday-first-day.json`
  - `docs/attendance-holiday-sync-update-development.md`
  - `docs/attendance-template-changelog.md`

## 配置建议（默认）
- 全局节假日策略：
  - `firstDayEnabled = true`
  - `firstDayBaseHours = 8`
  - `overtimeAdds = true`
  - `overtimeSource = approval`
  - `overrides = []`（可选：例如 `{ name: 春节, match: contains, firstDayBaseHours: 8 }`）
- 节假日同步：
  - 来源 `holiday-cn`
  - `dayIndexHolidays = [春节, 国庆]`
  - `dayIndexMaxDays = 7`
  - `dayIndexFormat = name-1`
  - `auto.enabled = true`
  - `auto.runAt = 02:30`
  - `auto.timezone = Asia/Shanghai`

## 影响说明
- 当“节假日策略”启用时，模板规则会自动跳过，避免重复叠加。
- 当“节假日策略”关闭时，模板规则生效，保证节假日首日默认工时。

## 相关文件
- `plugins/plugin-attendance/index.cjs`
- `plugins/plugin-attendance/engine/template-library.cjs`
- `docs/attendance-rule-template-holiday-first-day.json`
- `docs/attendance-holiday-sync-update-development.md`
- `docs/attendance-template-changelog.md`
