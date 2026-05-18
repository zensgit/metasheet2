# 考勤 Custom 非公式字段作为公式源开发记录

## Summary

本 slice 落地 P2：允许多维表字段目录中的 custom 非公式字段以显式 opt-in 方式成为考勤 record-scope 公式源。默认仍保持 Round 5 的安全语义：`systemDefined=false` 且 `formulaEnabled=false` 的字段如果没有配置 `formula_source_mode`，仍会被 validator 拒绝，避免旧租户 catalog 记录突然进入公式计算。

## Scope

- 不迁移 `attendance_*` 事实表。
- 不直接读写 `meta_*` 表。
- 不允许公式字段引用公式字段。
- 不扩展 `formulaScope=period`。
- 不实现 hard delete / disable lifecycle。
- 继续让 `attendance_*` 生成系统统计，多维表只承载字段目录和公式源配置。

## Key Changes

### Catalog Descriptor

`attendance_report_field_catalog` 新增字段：

- `formula_source_mode`
- 类型：`select`
- 选项：`none` / `meta` / `internal_key` / `alias`
- 默认归一为 `none`

语义：

- `none`：默认值，不作为公式源。
- `meta`：按字段编码读取 `row.meta[code]`。
- `internal_key`：按 `internalKey` dotted path 从 record row 根对象读取，例如 `meta.adjustments.pathMinutes`。
- `alias`：按 `internalKey` 作为 alias，从 `row.meta.attendanceFormulaSources`、`row.meta.formulaSources`、`row.meta.formula_sources`、`row.meta.aliases` 读取。

### Validator 与 Source Resolver

`resolveAttendanceFormulaSourceFields()` 继续放行系统非公式字段，并新增 custom opt-in 路径：

- `field.systemDefined === false`
- `field.formulaEnabled !== true`
- `field.enabled !== false`
- `formulaSourceMode !== 'none'`

`getAttendanceReportFormulaReferenceCodes()` 复用同一判定，保证 preview、save、record/export runtime 使用同一合法字段集合。

### Guard

- `internal_key` dotted path 每段必须匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`。
- 禁止 root 为 `report_values` / `reportValues` / `formula` / `formulas`，避免读取当前公式输出或公式对象。
- `alias` 必须是单段安全标识符。
- disabled custom source 不进入合法引用集合。
- custom formula 字段仍不进入公式源集合，继续禁止 formula-to-formula。

### Runtime Value Resolution

`buildAttendanceReportFormulaValueMap()` 对公式源字段分两类取值：

- 系统字段：继续走 `getAttendanceRecordReportFieldValue(row, code)`。
- custom opt-in 字段：按 `formulaSourceMode` 从 `row.meta` / dotted path / alias bucket 读取。

缺失值沿用现有 `attendanceFormulaLiteral()` 语义，在表达式替换时落为 `0`，不变成 `#ERROR!`。

### Fingerprint

`buildAttendanceReportFieldConfigFingerprint()` 现在额外接收 `formulaSourceFields`，并把 custom source 的 `code` / `internalKey` / `formulaSourceMode` 纳入 hash。这样 custom source 配置变化会让 report-records sync 的 field fingerprint 变化；但 `fieldCount` / `codes` 仍只代表实际输出字段，保持 CSV/header 语义稳定。

为降低部署扰动，只有存在 custom opt-in source 时才会把 `formulaSourceFields` 放进 hash payload；没有 custom source 的租户保持旧 fingerprint payload 形态，避免无意义全量 resync。

### Frontend

`AttendanceReportFieldsSection.vue` 增加 `formulaSourceMode` 类型字段，并在 custom 非公式字段的 Mapping 区域展示“Formula source”行。搜索也会匹配 source mode。

## Compatibility

- 老 catalog 缺少 `formula_source_mode` 时自动归一为 `none`。
- 旧 custom 非公式字段继续被 validator 拒绝。
- 系统字段、动态 subtype 字段、raw alias gate、reserved-code shadow 行为不变。

## Files

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`
- `packages/core-backend/tests/unit/attendance-report-field-formula-engine.test.ts`
- `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`
- `apps/web/tests/AttendanceReportFieldsSection.spec.ts`
- `docs/development/attendance-dingtalk-formula-todo-20260515.md`
- `docs/development/attendance-custom-formula-sources-development-20260517.md`
- `docs/development/attendance-custom-formula-sources-verification-20260517.md`

## Follow-up

- 周期汇总级公式仍独立排期。
- 公式字段依赖图/循环检测仍独立排期，当前 formula-to-formula 仍被拒绝。
- 可在后续 UI 中给 custom source mode 增加更完整的内联编辑入口；本 slice 只展示已配置 source mode。
