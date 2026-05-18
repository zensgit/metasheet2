# 考勤 multi-punch ingest-persist 开发记录

Date: 2026-05-17

## Summary

本 slice 补齐钉钉打卡时间/结果拆字段的数据来源：导入路径把多段打卡字段持久化到 `attendance_records.meta`，让已存在的 `punch_in_2/3`、`punch_out_2/3`、`punch_result_in/out_1..3` 报表字段从 placeholder 变成可被真实导入数据点亮。

边界不变：

- 不新增 `attendance_*` migration。
- 不迁移事实源；`attendance_records` 仍是事实源。
- 不裸写 `meta_*`。
- 不重写考勤聚合、规则引擎或 report-records sync。
- 不让日级 `status` 伪装成单次打卡结果。

## Key Changes

### 1. 导入映射补齐

`IMPORT_MAPPING_COLUMNS` 新增：

- `3_on_duty_user_check_time` / `上班3打卡时间` → `clockIn3`
- `3_off_duty_user_check_time` / `下班3打卡时间` → `clockOut3`
- `上班/下班 1/2/3 打卡结果` → `punchResultIn/Out1..3`

`IMPORT_REQUIRED_FIELD_ALIASES` 同步补齐上班/下班 3 的别名，保持校验语义与导入映射一致。

### 2. 共享 meta helper

新增共享 helper：

- `buildAttendanceImportMultiPunchMeta(options)`
- `attachAttendanceImportMultiPunchMeta(meta, options)`

helper 从导入侧 `valueFor()` 读取多段打卡时间/结果，写入顶层 `attendance_records.meta` keys：

- `clockIn2`
- `clockOut2`
- `clockIn3`
- `clockOut3`
- `punchResultIn1`
- `punchResultOut1`
- `punchResultIn2`
- `punchResultOut2`
- `punchResultIn3`
- `punchResultOut3`

时间值会经过 `parseImportedDateTime(value, workDate, timezone)` 规整，支持 `13:00` 这类 time-only 值按工作日补全。

### 3. 三类写入路径接入

helper 接入现有 meta 组装点后继续走既有 upsert：

- buffered/batch import writer → `enqueueRecordUpsert(...)`
- commit writer → `enqueueRecordUpsert(...)`
- direct/legacy import writer → `upsertAttendanceRecord(...)`
- integration import writer → `upsertAttendanceRecord(...)`

最终仍由 `computeAttendanceRecordUpsertValues()` 合并 existing meta 并序列化写入 `attendance_records.meta`。

### 4. Stale 清空语义

override 模式下，helper 会对全部受管 punch key 写 `null`，用于清空旧导入留下的 slot-2/3 或 result 值。这样重新导入一条没有第二/第三段打卡的记录时，多维表和报表不会保留旧值。

非 override 模式不写缺失 key，保留既有 merge 语义。

### 5. 报表描述收口

已拆字段的描述从“待 ingest-persist P2”更新为“由导入持久化多段打卡字段时点亮，缺失为空”。字段 code、排序、类型、DingTalk 名称不变。

## Design Notes

- 多段打卡结果只读专用 meta key，不从 `status` 回填。
- `punch_in_1` / `punch_out_1` 继续来自 `first_in_at` / `last_out_at`。
- `punch_result_in_1` / `punch_result_out_1` 即使是第一段，也只来自 `meta`，避免日级结果污染单次结果。
- report-records sync 不需要额外改动：它复用 export/report field value path，meta 被点亮后会自然同步。

## Files Changed

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`
- `docs/development/attendance-dingtalk-formula-todo-20260515.md`
- `docs/development/attendance-report-records-sync-pr3-verification-20260516.md`
- `docs/development/attendance-multipunch-ingest-development-20260517.md`
- `docs/development/attendance-multipunch-ingest-verification-20260517.md`
