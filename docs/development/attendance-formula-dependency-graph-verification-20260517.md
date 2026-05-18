# 考勤公式依赖图与循环检测验证记录

## Verification Scope

验证本 slice 的只读公式依赖图能力：

- catalog response 在 `reportFieldConfig.formulaDependencyGraph` 返回 graph。
- fallback / multitable unavailable 时返回空 graph。
- 正常公式生成字段依赖边。
- v1 仍拒绝 formula-to-formula，但 graph 能展示 blocked formula edge。
- 纯 graph helper 能检测手工构造的公式字段循环。
- 前端展示 graph 摘要与 blocked formula references。
- 前端过滤时隐藏 graph，避免全局摘要污染过滤结果。

## Automated Tests

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot` | PASS, 39 tests (18 catalog + 21 formula) |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 24 tests (13 report fields + 11 admin regression); Vite printed a non-fatal WebSocket port-in-use warning |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `pnpm --filter @metasheet/core-backend build` | PASS |
| `git diff --check` | PASS |

## Backend Coverage

- `formula_a -> late_duration` produces a normal `field` edge.
- `formula_b -> formula_a` remains `formulaValid=false` with `Formula field reference formula_a is not supported in v1.`
- The same rejected formula-to-formula reference appears in `blockedFormulaReferences`.
- A manually constructed `formula_a -> formula_b -> formula_a` graph reports `hasCycles=true` and one canonical cycle.
- `buildAttendanceReportFieldCatalogResponse()` includes graph under `reportFieldConfig`.
- fallback catalog response includes an empty graph.

## Frontend Coverage

- Formula dependency graph panel renders formula field count, edge count, blocked formula-ref count, and cycle status.
- Blocked formula reference edges are displayed as readable `from -> to` pairs.
- Active field filters hide the graph panel, preserving existing field filtering assertions.

## Constraints

- No `attendance_*` migration.
- No direct `meta_*` writes.
- No change to formula runtime execution.
- No formula-to-formula enablement.
- No period-scope formula enablement.
