# 考勤节假日同步与规则模板更新（开发记录）

日期：2026-02-03

## 目标
1. 节假日同步仅按“当前年 + 下一年”动态执行。
2. 调整自动同步时段并明确时区（Asia/Shanghai）。
3. 提供“节假日首日 8 小时”规则模板导出，供用户自定义。

## 变更内容
- **自动同步配置**
  - `holidaySync.years` 设为空数组，触发默认逻辑（当前年 + 下一年）。
  - `holidaySync.auto.enabled=true`，`runAt=02:30`，`timezone=Asia/Shanghai`。
- **规则模板**
  - 新增系统模板 `Holiday First Day Base Hours (CN)`，规则名 `holiday-default-8h`，命中节假日首日时设置 8 小时。
  - 当 Holiday Policy 启用时，会自动跳过该规则（避免与 Settings 冲突）。
- **模板导出**
  - 新增可导入模板文件：`docs/attendance-rule-template-holiday-first-day.json`。

## 变更文件
- `plugins/plugin-attendance/engine/template-library.cjs`
- `docs/attendance-rule-template-holiday-first-day.json`
- `docs/attendance-template-changelog.md`

