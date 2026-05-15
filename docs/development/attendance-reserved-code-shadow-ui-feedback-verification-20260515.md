# 考勤 reserved-code shadow UI feedback 验证记录

Date: 2026-05-15

## Commands Run

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-report-field-catalog.test.ts \
  tests/unit/attendance-report-field-formula-engine.test.ts \
  --reporter=dot
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/AttendanceReportFieldsSection.spec.ts \
  tests/attendance-admin-regressions.spec.ts \
  --watch=false
pnpm --filter @metasheet/web type-check
git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax (`plugin-attendance/index.cjs`) | PASS |
| Backend catalog + formula unit tests | **PASS, 21 tests** (8 catalog + 13 formula; catalog +1 vs prior 7) |
| Frontend report fields + admin regression specs | **PASS, 15 tests** (4 report fields + 11 admin regression; report fields +1 vs prior 3) |
| Web type-check (`vue-tsc -b`) | PASS |
| `git diff --check` whitespace check | PASS |

## Hardening Evidence

### Backend — `reports dropped reserved-code shadow fields`

`packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`

1. 构造 3 条 config 记录：`late_minutes`（公式自定义，撞保留字）、`work_minutes`（非公式自定义，撞保留字）、`ok_custom_metric`（正常自定义）
2. `getAttendanceReportFieldDroppedReservedCodes(records, fieldIds)` → `['late_minutes', 'work_minutes']`（去重 + 排序）
3. `mergeAttendanceReportFieldDefinitions(records, fieldIds)`：`late_minutes` / `work_minutes` 不在 merged（merge 层丢弃，Round 6 行为不变），`ok_custom_metric` 在 merged
4. `getAttendanceReportFieldDroppedReservedCodes([], {})` → `[]`（空输入）
5. `buildAttendanceReportFieldCatalogResponse({ api: { multitable: null } }, ...)` 的 fallback 路径 → `droppedReservedCodes` `toEqual([])`（shape 一致性闭环）

### Frontend — `shows a warning banner when droppedReservedCodes is present and hides it otherwise`

`apps/web/tests/AttendanceReportFieldsSection.spec.ts`

1. payload `droppedReservedCodes: ['late_minutes', 'work_minutes']` → `[data-report-field-dropped-reserved]` banner 存在
2. banner `role="alert"`
3. banner 文案含 `late_minutes, work_minutes`（实际 codes）
4. banner 文案含 `Rename them in the multitable catalog`（补救动作）
5. 换用 `populatedCatalogPayload()`（无 `droppedReservedCodes`）重挂载 → banner `toBeNull()`

## Acceptance Criteria

- catalog merge 丢弃 raw alias 保留字字段时，`buildAttendanceReportFieldCatalogResponse` 响应暴露 `droppedReservedCodes: string[]`（去重排序）
- fallback 路径同样返回 `droppedReservedCodes: []`，响应 shape 一致
- 前端在 `droppedReservedCodes.length > 0` 时展示独立 warning banner，列出 codes + 补救动作
- 无 `droppedReservedCodes` 时 banner 不渲染
- Round 6 的 merge 丢弃行为原样保留（test #12 + 本 slice merge cross-check 双重确认）
- 公式计算语义无变更
- 未改 `attendance_*` 事实源、未直接写 `meta_*`
- 后端 21 + 前端 15 单测全绿，type-check 无新 TS 错误，`git diff --check` 干净

## Out of scope (future)

- Banner 上加"一键定位/编辑该 catalog 记录"的深链（需要前端路由 + 多维表 record 编辑入口，非本 slice）
- 把 dropped 原因细分（reserved vs 其它未来丢弃类别）——目前只有 reserved 一种丢弃来源
