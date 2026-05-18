# 考勤公式函数参考面板验证记录

## Summary

本轮验证覆盖公式参考面板的前端渲染、既有统计字段区域回归、TypeScript 类型检查与 diff hygiene。该 slice 不触碰后端公式计算、sync writer 或数据库迁移。

## Test Matrix

| Layer | Command | Result |
| --- | --- | --- |
| Frontend spec | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 20 tests (`AttendanceReportFieldsSection` 9 + admin regression 11) |
| Web type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Diff hygiene | `git diff --check` | PASS |

## Expected Assertions

- `AttendanceReportFieldsSection` 在字段加载后展示 `data-report-formula-reference`。
- 面板展示 record-scope 和 deterministic-only 提示。
- 面板展示 `{field_code}`、`{late_duration}`、`{leave_type_annual_duration}`。
- 面板展示代表函数：`IF`、`SUM`、`DATEDIF`、`CONCAT`。
- 面板展示示例公式：`={late_duration}+{early_leave_duration}`、`=IF({attendance_days}>0,{work_duration},0)`。
- 面板展示禁用项提示：`NOW`、`TODAY`、lookup、cell references、scripts。
- 既有字段分类、公式列、reserved-code warning、punch split、dynamic subtype、report-record sync 面板回归继续通过。

## Manual Review Notes

- 参考面板为只读 UI，不新增 API 或权限面。
- 函数白名单只作为用户参考展示；真实合法性仍以后端 validator 为准。
- 内联公式编辑器仍为独立 P2，避免在本 slice 中引入 multitable patch 写路径。

## Environment Notes

- 隔离 worktree 首次运行测试前执行了 `pnpm install` 以恢复 workspace bin；这会让仓库中已存在的 tracked `node_modules` symlink 产生噪音。
- 本 slice 提交边界必须显式 stage 5 个目标文件，不使用 `git add -A`，不纳入 `node_modules` 改动。
