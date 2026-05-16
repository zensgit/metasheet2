# 考勤 P2 请假/加班子类型拆分字段计划（定稿）

Date: 2026-05-15

## Summary

Medium slice：动态 subtype 字段触及 report field 输出集、公式源、validator、运行时 value map。报表字段层实现：不迁移 `attendance_records`，不直接写 `meta_*`，旧 aggregate 字段保持不变。动态字段来自 active `attendance_leave_types` / `attendance_overtime_rules`，不硬编码钉钉内置假期列表。

## Orientation 结果（已离线坐实，无偏差）

| 假设 | 来源 | 结果 |
| --- | --- | --- |
| `attendance_leave_types`: `id uuid`, `org_id`, `code text`(unique org_id,code), `name`, `is_active`, `paid` | migration `..111000` + `..093000` | ✅ |
| `attendance_overtime_rules`: `id uuid`, `org_id`, `name`(unique org_id,name), `is_active`，**无 `code`** | migration `..112000` | ✅ 用 rule id |
| `attendance_requests`: `request_type` 含 `leave`/`overtime`、`status`∈`pending/approved/rejected/cancelled`、有 `org_id`、`metadata jsonb` | migration `..090000`+`..110000`+`..100000` | ✅ |
| metadata 嵌套 `metadata.leaveType.{id,code}` / `metadata.overtimeRule.{id,name}` / `metadata.minutes` | 现有 `loadApprovedMinutesRange` + fingerprint code（读真实 request 行）| ✅ **确认嵌套，非扁平** |

Orientation 推论：
- **metadata 形状确定为嵌套**，原计划"若扁平先扩 fallback"那段**删除**（无用复杂度）。SQL 取值用 `metadata->'leaveType'->>'code'`、`metadata->'overtimeRule'->>'id'`。
- 若目标环境无 approved leave/overtime request 样本，live subtype evidence 记为待补，不伪造通过；schema 已离线坐实无需 DB/staging 凭据。

## Watch-point 决议（单一权威路径）

存在三处 approved-minutes 聚合：`loadAttendanceSummary`（summary 端点）、`loadApprovedMinutes`（单日）、`loadApprovedMinutesRange`（日期区间，3 callers 喂 records/export/sync）。

**本 slice 只扩 `loadApprovedMinutesRange`**（报表字段/导出路径）。`loadApprovedMinutes` 与 `loadAttendanceSummary` 服务不同 surface（单日 calc / summary 统计），显式 out-of-scope，保持现有 aggregate-only 行为。避免 punch-split「多 site 无 chokepoint」陷阱。后续若 summary/单日 surface 需要 subtype 拆分，单独 follow-up。

## Key Changes

### Dynamic Code Contract

谓词：
- `isAttendanceLeaveSubtypeCode(code)` → `/^leave_type_[a-z0-9_]+_duration$/`
- `isAttendanceOvertimeSubtypeCode(code)` → `/^overtime_rule_[a-z0-9]+_duration$/`
- `isAttendanceDynamicSubtypeCode(code)` 聚合二者

生成：
- 请假 `leave_type_${normalizedLeaveTypeCode}_duration`；`normalizedLeaveTypeCode`：小写、非 `[a-z0-9]` 折叠为 `_`、去首尾 `_`；空值用 `id_${shortId}`（shortId = uuid 去 `-` 前 8 位）
- 加班 `overtime_rule_${compactRuleId}_duration`；`compactRuleId` = rule id 去非 `[a-z0-9]` 后小写
- 名称 / DingTalk name：请假 `${leaveType.name}时长`，加班 `${overtimeRule.name}加班时长`
- category：请假 `leave`，加班 `overtime`；unit `minutes`；`systemDefined: true`
- internalKey：`requests.leaveType.${leaveType.code}.minutes` / `requests.overtimeRule.${overtimeRule.id}.minutes`

碰撞 guard：`usedCodes` 初始含静态 report code + raw alias reserved code；主 code 冲突→追加 `_${shortId}`；仍冲突→追加完整 compact id。动态源固定排序：leave by `name,code,id`；overtime by `name,id`（fingerprint 稳定）。同 code 的 catalog config 视为对系统动态字段的配置覆盖，非冲突。

### Refinement 1：谓词只接两个真 gap（核心简化）

动态 def 作为**一等 `systemDefined:true` 字段 merge 进 items 数组**。则：
- `resolveAttendanceFormulaSourceFields`（现有 `systemDefined!==false` filter）**自动放行，不加谓词**
- `getAttendanceReportFormulaReferenceCodes`（现有 `reserved→skip / enabled===false→skip / systemDefined===false→skip / codes.add` 链）**自动正确，不加谓词**

谓词**只**落两处真 gap：
1. `resolveAttendanceRecordReportFields`：门是 `ATTENDANCE_RECORD_REPORT_FIELD_CODE_SET.has(code) || formulaEnabled`，不看 systemDefined → **必须**加 `|| isAttendanceDynamicSubtypeCode(code)`
2. `getAttendanceRecordReportFieldValue`：字面 switch 无法匹配动态 code → **必须**前置正则拦截，读 query-time subtype minutes，缺失返回 `0`（非 `#ERROR!`）

不 over-thread 进另两处 = 少碰已加固表面 = 降回归风险。

### Catalog / Sync

- `loadAttendanceReportDynamicSubtypeContext(db, orgId, logger)` → `{ definitions, leaveTypeCodeToFieldCode, overtimeRuleIdToFieldCode }`；schema 缺失返回空 definitions + degraded warning，不阻断内置字段（复用既有 `isDatabaseSchemaError`/catalog fallback 模式）
- `mergeAttendanceReportFieldDefinitions(..., { extraSystemDefinitions })` 合并静态 + 动态
- `POST /sync` seed 静态 + 当前 active 动态字段；`GET` 只读生成动态字段不写 catalog
- inactive type/rule 的旧 catalog 记录 v1 不删；无 active dynamic definition 时不进 report output/formula source。orphan 记录 surfacing（`inactiveDynamicSubtypeCodes` warning）= documented follow-up

### Runtime Data Flow

- `loadApprovedMinutesRange()` 扩展：保留 `leaveMinutes`/`overtimeMinutes` 总量；按 `metadata->'leaveType'->>'code'` 与 `metadata->'overtimeRule'->>'id'` 聚合 subtype；输出 `reportSubtypeMinutes: { [fieldCode]: minutes }`
- records/export 构造行注入 `meta.reportSubtypeMinutes`
- 旧 `leave_duration` / `overtime_approval_duration` / workday/restday/holiday overtime 行为与总量不变

## 不变量（必测，Round 5/6 同类）

1. **空值返回 `0` 非 `#ERROR!`**：metadata 缺失/subtype 未匹配 → `0`
2. **对账语义**：`aggregate ≥ Σ(subtypes)`；未知/缺 metadata 的 approved request 只进 aggregate 不进任何 subtype。documented invariant + 回归测试（客户否则会报"子类型加起来≠总数"为 bug）
3. **custom 撞正则但 `systemDefined:false` 仍被排除**：reserved-code-shadow 同类边界，`systemDefined!==false` clause 防的就是这个，必测
4. **旧 aggregate 总量不变**：`leave_duration`/`overtime_approval_duration`

## Test Plan

- Catalog 单测：active 生成稳定字段 / inactive 不生成 / `annual-1`vs`annual_1` 归一化碰撞 deterministic 加 suffix / 不撞静态+reserved code / config 隐藏禁用 / disabled 动态字段非 formula source / **custom 撞正则但 systemDefined:false 不被当系统源**
- Runtime 单测：approved leave 按 `metadata.leaveType.code` 聚合 / approved overtime 按 `metadata.overtimeRule.id` 聚合 / pending+rejected+cancelled 不参与 / 缺 metadata 或未匹配 →`0` / **旧 aggregate 总量不变** / **aggregate≥Σ(subtypes) 对账**
- Formula 单测：`{leave_type_xxx_duration}` 可计算 / disabled subtype reference 被 validator 拒 / 动态字段 metadata 参与 fingerprint
- Frontend：`AttendanceReportFieldsSection` 渲染动态字段名/code/启用可见态（数据驱动，组件逻辑不改）
- 命令：`node --check` / core-backend catalog+formula vitest / web AttendanceReportFieldsSection+admin-regression vitest / web type-check / core-backend build / `git diff --check` / commit 前显式 stage（无 `-A`、无 node_modules、secret/home-path scan）

## Assumptions / Out of scope

- 加班规则无 code，字段 code 用 rule id；未来加 `code` 另做兼容计划
- 不实现加班三段独立规则、加班转调休余额、请假额度/过期管理
- 不持久化 subtype map 到 `attendance_records.meta`（查询期派生）
- 租户无 leave types/overtime rules → 不新增动态字段，旧 aggregate 照常
- `loadApprovedMinutes`/`loadAttendanceSummary` 的 subtype 拆分 = 未来 follow-up
- orphan inactive catalog 记录 surfacing = 未来 follow-up

## Claude Code TODO

- [ ] 动态 code 谓词 + 生成器 + 碰撞 guard + 确定性排序
- [ ] `loadAttendanceReportDynamicSubtypeContext` + merge `extraSystemDefinitions` + sync seed / GET 只读
- [ ] 仅两真 gap 接入（`resolveAttendanceRecordReportFields` + `getAttendanceRecordReportFieldValue`）；formula source/validator 走既有 systemDefined 路径
- [ ] `loadApprovedMinutesRange` 扩 `reportSubtypeMinutes` + records/export 注入 `meta.reportSubtypeMinutes`
- [ ] backend catalog + runtime + formula 单测（含 4 条不变量）
- [ ] frontend spec
- [ ] dev / verification MD + tick `attendance-dingtalk-formula-todo` 请假/加班子类型项
