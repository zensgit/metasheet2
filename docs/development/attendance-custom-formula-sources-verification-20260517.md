# 考勤 Custom 非公式字段作为公式源验证记录

## Verification Scope

验证本 slice 的 P2 opt-in 公式源能力：

- descriptor 新增 `formula_source_mode`。
- 默认 custom 非公式字段仍被拒绝。
- opt-in custom source 可被 validator、preview/save 合法集合和 records/export runtime 共同识别。
- `meta` / `internal_key` / `alias` 三种取值路径可计算。
- disabled/unsafe custom source 被拒绝。
- source mode 变化进入 field fingerprint。
- 前端可展示 custom source mode 元数据。

## Automated Tests

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot` | PASS, 37 tests (17 catalog + 20 formula) |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 23 tests (12 report fields + 11 admin regression); Vite printed a non-fatal WebSocket port-in-use warning |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `pnpm --filter @metasheet/core-backend build` | PASS |
| `git diff --check` | PASS |

## Backend Coverage

- Descriptor includes `formula_source_mode`.
- `buildAttendanceReportFieldConfigFingerprint()` changes when output formula metadata changes.
- `buildAttendanceReportFieldConfigFingerprint()` also changes when non-output formula source metadata changes.
- `buildAttendanceReportFieldConfigFingerprint()` keeps the old payload shape when no custom opt-in source exists, avoiding unnecessary resync churn.
- Default custom non-formula field remains invalid as formula reference.
- `formula_source_mode=meta` reads `row.meta[code]`.
- `formula_source_mode=internal_key` reads a safe dotted path such as `meta.adjustments.pathMinutes`.
- `formula_source_mode=alias` reads named buckets such as `row.meta.formulaSources[alias]`.
- disabled custom source does not enter `formulaSourceFields`.
- unsafe path roots such as `report_values.*` do not enter `formulaSourceFields`.

## Frontend Coverage

- `AttendanceReportFieldsSection.vue` accepts `formulaSourceMode`.
- Mapping rows display `Formula source` for custom non-formula source fields.
- Search haystack includes `formulaSourceMode`.

## Manual / Live

No live staging mutation was required for this slice. Existing staging formula acceptance remains valid; a future live pass can seed a custom non-formula source field and a formula field referencing it, then compare catalog / records / export / CSV fingerprints.

## Constraints

- No `attendance_*` migration.
- No direct `meta_*` writes.
- No token or private key material in committed files.
- No formula-to-formula enablement.
- No period-scope formula enablement.
