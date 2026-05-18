# 考勤内联公式编辑器验证记录

## Summary

本轮验证覆盖后端保存接口 helper、公式 validator 回归、前端行内编辑/创建、TypeScript 类型检查和 diff hygiene。

## Test Matrix

| Layer | Command | Result |
| --- | --- | --- |
| Plugin syntax | `node --check plugins/plugin-attendance/index.cjs` | PASS |
| Backend unit | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot` | PASS, 35 tests (`catalog` 17 + `formula` 18) |
| Frontend spec | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 22 tests (`AttendanceReportFieldsSection` 11 + admin regression 11) |
| Web type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Core backend build | `pnpm --filter @metasheet/core-backend build` | PASS |
| Diff hygiene | `git diff --check` | PASS |

## Backend Assertions

- 创建 custom formula 字段时，`records.createRecord()` 接收 resolved physical `fld_*` 字段 id。
- 修改既有 custom formula 字段时，`records.patchRecord({ sheetId, recordId, changes })` 接收 physical `fld_*` 字段 id。
- 保存前用候选 catalog 复用后端 validator；未知引用返回 `INVALID_FORMULA` 且不写记录。
- 系统字段、动态 subtype 字段、raw alias reserved code、非法 code 均在 ensure/provision 前被拒绝。

## Frontend Assertions

- 系统公式字段不展示编辑按钮。
- custom formula 字段展示行内 `Edit`。
- Preview 调用 `POST /api/attendance/report-fields/formula/preview` 并展示 value/references。
- Save 调用 `PATCH /api/attendance/report-fields/:code/formula`，返回 catalog 后刷新表达式并退出编辑态。
- 函数参考面板的新建表单可创建 custom formula 字段，并刷新本地 catalog。

## Environment Notes

- 隔离 worktree 首次运行 Vitest 前执行了 `pnpm install` 以恢复 workspace bin。
- `pnpm install` 会产生 tracked `node_modules` symlink 噪音；提交时必须显式 stage 本 slice 文件，不使用 `git add -A`。
