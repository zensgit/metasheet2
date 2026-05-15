# 考勤公式 Raw Alias 全局门控开发记录

Date: 2026-05-15

## 背景

PR #1579 明确 `{work_minutes}`、`{late_minutes}`、`{early_leave_minutes}`、`{leave_minutes}`、`{overtime_minutes}` 是底层 raw alias，不受统计字段 `enabled` 控制；PR #1591 又补了 reserved-code shadow UI 反馈。本 slice 补齐 P2 中的全局门控：当部署或配置需要禁止 raw alias 时，使用独立开关，而不是复用任一统计字段启停状态。

## 设计

- 默认兼容：`formula.allowRawAliases` 默认 `true`，未配置环境变量时现有公式行为不变。
- 配置入口：考勤 settings 增加 `formula.allowRawAliases: boolean`，`PUT /api/attendance/settings` 可写入。
- 运维覆盖：环境变量 `ATTENDANCE_FORMULA_ALLOW_RAW_ALIASES=false|0|no|off|disabled` 可强制关闭；`true|1|yes|on|enabled` 可强制打开。环境变量优先于 settings。
- 校验入口：`validateAttendanceReportFormulaExpression()` 在 raw alias 关闭时返回 `Raw alias reference <code> is disabled by attendance formula settings.`。
- 运行时防御：`buildAttendanceReportFormulaValueMap()` 在 raw alias 关闭时不注入 raw values；`evaluateAttendanceReportFormulaField()` 也会拒绝带 raw alias reference 的字段，避免旧缓存或直接 helper 调用静默算成 0。
- API 数据流：report-fields catalog、formula preview、records `report_values`、JSON/CSV export 均读取同一 runtime options。

## 保持不变

- 不迁移 `attendance_*` 事实表。
- 不直接读写 `meta_*` 表。
- 不改变 reserved-code shadow 的 merge 丢弃语义。
- 不实现自定义非公式字段解析层；该能力仍留在 P2 自定义 source 设计。

## 字段语义

| 引用类型 | 默认 | raw alias gate 关闭 |
| --- | --- | --- |
| 系统统计字段 `{late_duration}` | 受 catalog `enabled` 控制 | 不变 |
| 隐藏但启用字段 | 可参与计算 | 不变 |
| 停用字段 | validator 拒绝 | 不变 |
| 自定义非公式字段 | v1 拒绝 | 不变 |
| 公式字段引用公式字段 | v1 拒绝 | 不变 |
| Raw alias `{late_minutes}` | 可引用底层 row 值 | validator 拒绝，运行时返回 `#ERROR!` |

## 影响面

- 后端插件：`plugins/plugin-attendance/index.cjs`
- 单测：`packages/core-backend/tests/unit/attendance-report-field-formula-engine.test.ts`
- TODO：`docs/development/attendance-dingtalk-formula-todo-20260515.md`
