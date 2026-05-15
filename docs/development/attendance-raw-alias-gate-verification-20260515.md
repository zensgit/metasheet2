# 考勤公式 Raw Alias 全局门控验证记录

Date: 2026-05-15

## 验收标准

- 默认不破坏既有 raw alias 行为。
- settings 与 env 可解析 raw alias gate，且 env 优先。
- raw alias gate 关闭后，catalog merge / validator 标记公式无效。
- raw alias gate 关闭后，记录/导出运行时返回 `#ERROR!`，不调用 formula API。
- preview API 在 gate 关闭后拒绝 raw alias，不因 sample 中存在同名 key 而放行。
- 不改变 `attendance_*` 事实源和多维表 catalog 读写边界。

## 新增测试覆盖

- `can globally disable raw alias references without touching field enabled state`
  - `ATTENDANCE_FORMULA_ALLOW_RAW_ALIASES=off` 解析为 `false`。
  - settings=false 且 env=true 时最终允许，证明 env 优先。
  - `mergeAttendanceReportFieldDefinitions(..., { rawAliasesAllowed: false })` 将 `={late_minutes}+1` 标记为 invalid。
  - `buildAttendanceRecordReportExportItemAsync(..., { rawAliasesAllowed: false })` 返回 `#ERROR!`，`calculateFormula` 未被调用。
- `preview rejects raw alias references when the global gate is disabled`
  - `previewAttendanceReportFormula(..., { rawAliasesAllowed: false })` 返回 `ok=false`。
  - sample 中的 `late_minutes` 不扩展合法引用集。

## 推荐验证命令

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-report-field-catalog.test.ts \
  tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/AttendanceReportFieldsSection.spec.ts \
  tests/attendance-admin-regressions.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
git diff --check
```

## Staging 备注

本 slice 默认保持 `allowRawAliases=true`，因此没有强制要求 staging 改配置。若要做运行时 smoke，可在非生产环境临时设置 `ATTENDANCE_FORMULA_ALLOW_RAW_ALIASES=false` 或通过 `PUT /api/attendance/settings` 写入 `{ "formula": { "allowRawAliases": false } }`，再用包含 `{late_minutes}` 的公式字段确认 catalog/records/export 都返回 invalid 或 `#ERROR!`。
