# 考勤请假/加班子类型拆分字段验证记录

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
pnpm --filter @metasheet/core-backend build
git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax (`plugin-attendance/index.cjs`) | PASS |
| Backend catalog + formula unit tests | **PASS, 27 tests** (12 catalog + 15 formula; catalog +3 vs prior 9) |
| Frontend report fields + admin regression specs | **PASS, 17 tests** (6 report fields + 11 admin regression; report fields +1 vs prior 5) |
| Web type-check (`vue-tsc -b`) | PASS |
| core-backend build (`tsc`) | PASS |
| `git diff --check` whitespace check | PASS |

## Orientation Evidence（离线坐实，无 DB/staging 凭据需求）

| 假设 | 来源 | 结果 |
| --- | --- | --- |
| `attendance_leave_types` id/org_id/code(unique org_id,code)/name/is_active/paid | migration `..111000`+`..093000` | ✅ |
| `attendance_overtime_rules` id/org_id/name(unique org_id,name)/is_active，无 code | migration `..112000` | ✅ |
| `attendance_requests` request_type 含 leave/overtime、status pending/approved/rejected/cancelled、有 org_id、metadata jsonb | migration `..090000`+`..110000`+`..100000` | ✅ |
| metadata 嵌套 `leaveType.{id,code}`/`overtimeRule.{id,name}`/`minutes` | 生产 `loadApprovedMinutesRange`+fingerprint 代码 | ✅ 确认嵌套 |

## Hardening Evidence（4 不变量 + 关键路径）

### `generates dynamic leave/overtime subtype fields with collision-safe stable codes`
- inactive type/rule 不生成
- `annual` 撞预置 used code → deterministic suffix（不丢弃）
- `annual-1` 归一化为 `annual_1`，与 `annual` 区分
- overtime `OT-Rule-A` → `overtime_rule_otrulea_duration`
- 生成 code 全部匹配谓词、互不重复、不撞静态 code 与 raw alias reserved code

### `dynamic subtype fields: report-field gate, formula source, value resolution, and invariants`
- gap-1：动态 def 进 `resolveAttendanceRecordReportFields` 输出
- 公式源经既有 systemDefined 路径放行（未 over-thread 谓词）；`={leave_type_annual_duration}+1` validator 通过
- **INVARIANT #3**：custom `leave_type_fake_duration`（systemDefined:false）既不进 report fields 也不进 formula source
- gap-2：`meta.reportSubtypeMinutes` 命中返回值；未命中 / 缺 meta → `0`（非 `#ERROR!`）

### `loadApprovedMinutesRange aggregates subtypes while keeping aggregate totals unchanged`
- mock db：base 查询 leave=300/overtime=120；subtype 查询 annual=240、null=60、ot-1=120
- **INVARIANT #4**：`entry.leaveMinutes===300`、`overtimeMinutes===120`（base 值，非 subtype 和）
- subtype map：`leave_type_annual_duration=240`、`overtime_rule_ot1_duration=120`
- **INVARIANT #2**：null subtype_key（60 分钟）不进任何 subtype；`leaveMinutes(300) >= ΣleaveSubtypes(240)`

### Frontend `renders dynamic leave/overtime subtype fields in the grid`
- payload 含 `leave_type_annual_duration`/`overtime_rule_ota_duration` → grid 渲染中文名 + code（数据驱动，组件逻辑未改）

## Acceptance Criteria

- 动态字段来自 active leave types/overtime rules，inactive 不生成；不硬编码假期列表
- code 生成确定性 + 碰撞 guard（含撞 reserved/静态 code）
- 谓词只接两真 gap；formula source/validator 走既有 systemDefined 路径
- 4 不变量全部测试通过
- schema 缺失 → 空 + degraded，不阻断内置字段（fallback 3 路径一致注入）
- 旧 aggregate 总量与行为不变；不迁移 `attendance_*`；不直接写 `meta_*`；subtype 查询期派生不持久化
- 仅扩 `loadApprovedMinutesRange`；另两个聚合 fn out-of-scope 未触
- backend 27 + frontend 17 全绿，type-check + build pass，`git diff --check` 干净

## Live Status

本地 mock 全绿。真实 staging 上的 active leave types / overtime rules + approved request 样本下的 live subtype evaluation evidence 记为**待补**（无 staging 凭据时不伪造通过）。拿到凭据后跑 `verify:attendance-report-fields:live` 并补 PR comment。
