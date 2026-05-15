# 考勤打卡时间/结果拆字段验证记录

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
| Backend catalog + formula unit tests | **PASS, 24 tests** (9 catalog + 15 formula; catalog +1 vs prior 8) |
| Frontend report fields + admin regression specs | **PASS, 16 tests** (5 report fields + 11 admin regression; report fields +1 vs prior 4) |
| Web type-check (`vue-tsc -b`) | PASS |
| `git diff --check` whitespace check | PASS |

## Hardening Evidence

### Backend — `splits DingTalk punch time/result into 12 catalog fields without polluting result slots with day status`

`packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`

1. 全 12 个新 code 出现在 `cloneAttendanceReportFieldDefinitions()`;`punch_in_1` matchObject `{ dingtalkFieldName: '上班1打卡时间', unit: 'dateTime', source: 'system' }`;`punch_result_out_3` `{ dingtalkFieldName: '下班3打卡结果', unit: 'text' }`
2. 旧 `punch_times` / `punch_result` 仍在(additive 保留)
3. row(`first_in_at`/`last_out_at` 设值,`meta.clockIn2` 设值,`status: 'late'`):
   - `punch_in_1` / `punch_out_1` 含 `2026-05-13`(slot-1 真值)
   - `punch_in_2` 含 `2026-05-13`(slot-2 读 meta)
   - `punch_out_2` / `punch_in_3` / `punch_out_3` === `''`(缺失非 `#ERROR!`)
   - **硬不变量**:6 个 `punch_result_*` 全部 === `''` 且 `!== 'late'`(绝不回显日级 status)
   - 提供 `meta.punchResultIn1: '正常'` 时 `punch_result_in_1` === `'正常'`(future ingest-persist 即点亮)
4. `resolveAttendanceFormulaSourceFields` 含 `punch_in_1`;`validateAttendanceReportFormulaExpression('={punch_in_1}', ...)` → `valid: true`(注册进 `ATTENDANCE_RECORD_REPORT_FIELD_CODES` 生效)
5. `buildAttendanceRecordReportExportItem` 含 `punch_in_1` / `punch_result_out_3` key;CSV 表头含 `上班1打卡时间` / `下班3打卡结果`(DingTalk 显示名)

### Frontend — `renders the DingTalk punch split fields in the grid`

`apps/web/tests/AttendanceReportFieldsSection.spec.ts`：payload 带 `punch_in_1`/`punch_out_3`/`punch_result_in_1` → grid 文本含三者中文名,`<code>` 节点含三者 code。无新 UI 行为(纯数据驱动渲染)。

## Acceptance Criteria

- 12 个 DingTalk 拆字段全部进 catalog,带正确 `dingtalkFieldName`,category `basic`
- slot-1 时间字段接 `row.first_in_at` / `last_out_at` 真实值
- slot-2/3 时间读 `row.meta` 多键 fallback,缺失返回 `''`(非 `#ERROR!`)
- **`punch_result_*` 任何情况都不回显 `row.status`**(硬不变量,测试显式断言 `!== 'late'`)
- result 字段读各自 `row.meta` 专用 key,future ingest-persist 提供时自动点亮
- 新 code 注册进 `ATTENDANCE_RECORD_REPORT_FIELD_CODES`,可作公式源(`={punch_in_1}` 通过 validator)
- export JSON + CSV 含 12 新列,CSV 表头用 DingTalk 显示名
- 旧 `punch_times`/`punch_result` 保留,additive 无破坏
- 不改 `attendance_*` 事实源 schema、不动 ingest、不直接写 `meta_*`、不改公式语义
- backend 24 + frontend 16 全绿,type-check 无新 TS 错误,`git diff --check` 干净

## Out of scope

- multi-punch ingest-persist(独立 P2,见 development MD follow-up)
- `punch_times`/`punch_result` 聚合字段 deprecation
