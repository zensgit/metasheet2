# 考勤 attendance_report_records 同步层验证记录 — PR1

Date: 2026-05-15

## Commands Run

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-report-field-catalog.test.ts \
  tests/unit/attendance-report-field-formula-engine.test.ts \
  --reporter=dot
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/core-backend build
git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax (`plugin-attendance/index.cjs`) | PASS |
| Backend catalog + formula unit tests | **PASS, 28 tests** (13 catalog + 15 formula; catalog +1 vs prior 12) |
| Frontend report fields + admin regression specs | PASS（无前端改动；回归确认 PR1 不影响既有 UI） |
| Web type-check (`vue-tsc -b`) | PASS |
| core-backend build (`tsc`) | PASS |
| `git diff --check` whitespace | PASS |

## PR1 Hardening Evidence

新增单测 `attendance_report_records: stable descriptor + idempotent ensure + degraded fallback`：

1. `getAttendanceReportRecordsDescriptor()` 两次调用 `JSON.stringify` 全等 → descriptor 稳定
2. `ATTENDANCE_REPORT_RECORDS_OBJECT_ID === 'attendance_report_records'`
3. 字段 id 顺序锁定（10 列固定骨架），`row_key.property.validation.required === true`
4. **类型契约**：`row_key`→`string`、`work_date`→`date`、`synced_at`→`dateTime`；**无任何 `text` 类型字段**（review 修正点 4 回归）
5. 幂等 ensure：两次 `ensureAttendanceReportRecords` 结果 `JSON.stringify` 全等；两次传入 `ensureObject` 的 descriptor 全等
6. fieldIds 解析：`fieldIds.row_key === 'fld_row_key'`、`fieldIds.synced_at === 'fld_synced_at'`
7. degraded #1：`{api:{multitable:null}}` → `{available:false, reason:'MULTITABLE_API_UNAVAILABLE', sheetId:null, fieldIds:{}}`，**不抛**
8. degraded #2：`ensureObject` 抛 `Error` → catch → `{available:false, reason:'PROVISIONING_FAILED', sheetId:null}`，**不抛**

## Orientation 验证（ensureObject 补字段行为）

读 `packages/core-backend/src/multitable/provisioning.ts`，坐实：

- `ensureObject` → `ensureFields`，物理 id = `stableMetaId('fld',projectId,objectId,logicalId)`（确定性）
- `ensureFields` = `INSERT ... ON CONFLICT (id) DO UPDATE`，**无 DELETE** → 补字段 upsert 幂等、移除字段 orphan 保留（known behavior）
- 结论写进 `attendance-report-records-sync-development-20260515.md`，并据此精化 PR1 范围（骨架在 PR1，value 列在 PR2 sync 时按 live catalog upsert，避免硬编码漂移）

## Acceptance Criteria（PR1）

- descriptor 稳定、object id 固定、10 列骨架字段 id/类型/order 锁定
- 类型用 provisioning contract（string/date/dateTime），无 `text`
- ensure 幂等（同 descriptor、结果等价）
- provisioning 不可用 / ensureObject 抛错两条路径均 degraded 不抛
- 无 writer/路由/前端；无 migration；无 `attendance_*`/`meta_*` 裸写
- 28 backend 单测全绿无回归；type-check + build + diff clean

## Live Status

PR1 无 records 写入，无 live 依赖。真实多维表 provision + sync evidence 属 PR2/PR3 + staging 凭据后补强（无凭据不伪造）。
