# 考勤请假/加班子类型拆分字段开发记录

Date: 2026-05-15

## Summary

Medium slice：动态 subtype 报表字段。来自 active `attendance_leave_types` / `attendance_overtime_rules`，不硬编码钉钉假期列表。不迁移 `attendance_records`，不直接写 `meta_*`，旧 aggregate（`leave_duration` / `overtime_approval_duration` / workday/restday/holiday overtime）行为与总量不变。subtype map 查询期派生，不持久化。

Orientation 全部假设已离线坐实（schema 由 migration 源、metadata 嵌套形状由生产 `loadApprovedMinutesRange`+fingerprint 代码反推），无偏差。详见 `attendance-leave-overtime-subtype-todo-20260515.md`。

## Dynamic Code Contract

谓词：
- `isAttendanceLeaveSubtypeCode` → `/^leave_type_[a-z0-9_]+_duration$/`
- `isAttendanceOvertimeSubtypeCode` → `/^overtime_rule_[a-z0-9]+_duration$/`
- `isAttendanceDynamicSubtypeCode` 聚合

生成（`buildAttendanceLeave/OvertimeSubtypeReportFieldDefinitions`）：
- 请假 `leave_type_${normalize(code)}_duration`；normalize = 小写、非 `[a-z0-9]`→`_`、去首尾 `_`；空→`id_${shortId}`
- 加班 `overtime_rule_${compact(ruleId)}_duration`；compact = 去非 `[a-z0-9]` 小写
- 碰撞 guard：`usedCodes` 初始 = raw alias reserved + 全部静态 def code；主 code 冲突→ `_${shortId}`→ 仍冲突→ full compact id
- 确定性排序：leave by `name,code,id`；overtime by `name,id`（fingerprint 稳定）
- 名称/DingTalk name：`${leaveType.name}时长` / `${overtimeRule.name}加班时长`；category leave/overtime；unit minutes；`systemDefined:true`

## Refinement 1 落地（谓词只接两真 gap）

动态 def 作为一等 `systemDefined:true` 字段经 `options.extraSystemDefinitions` merge 进 items：
- `resolveAttendanceFormulaSourceFields`（既有 `systemDefined!==false`）**自动放行，未加谓词**
- `getAttendanceReportFormulaReferenceCodes`（既有 reserved/enabled/systemDefined 链）**自动正确，未加谓词**

谓词只落两真 gap：
1. `resolveAttendanceRecordReportFields`：`|| (field.systemDefined !== false && isAttendanceDynamicSubtypeCode(code))`——带 systemDefined 守卫（INVARIANT #3：custom 撞正则但 systemDefined:false 不被提升）
2. `getAttendanceRecordReportFieldValue`：switch 前拦截，读 `row.meta.reportSubtypeMinutes[code]`，缺失/非有限 → `0`（非 `#ERROR!`）

## Catalog / Sync

- `loadAttendanceReportDynamicSubtypeContext(db, orgId, logger)`：查 active leave types/overtime rules → `{ definitions, leaveTypeCodeToFieldCode, overtimeRuleIdToFieldCode, degraded }`。db 缺失/`isDatabaseSchemaError` → 空 + degraded warning，不阻断内置字段
- `mergeAttendanceReportFieldDefinitions(..., { extraSystemDefinitions })`：静态 def + 动态 def 一起进 system 合并流程（同 code catalog config 仍可覆盖 name/enabled/visible/sort）
- `buildAttendanceReportFieldCatalogResponse` 顶部计算 dynamic context，注入主路径 + 3 个 fallback 路径（PROVISIONING_FAILED / MULTITABLE_UNAVAILABLE / READ_FAILED）保持响应 shape 一致

## Runtime Data Flow（单一权威路径）

Watch-point 决议：仅扩 `loadApprovedMinutesRange`（报表/导出路径，3 callers）。`loadApprovedMinutes`（单日）、`loadAttendanceSummary`（summary 端点）显式 out-of-scope，保持 aggregate-only。

`loadApprovedMinutesRange` 扩展：
- 原 base 聚合查询**不变**（`leaveMinutes`/`overtimeMinutes` 总量 INVARIANT #4 不动）
- 新增第 2 查询：`GROUP BY work_date, request_type, subtype_key`，`subtype_key` = `metadata->'leaveType'->>'code'`（leave）/ `metadata->'overtimeRule'->>'id'`（overtime）
- 经 dynamic context map 把 subtype_key → fieldCode，累加进 `entry.reportSubtypeMinutes`
- `subtype_key` 为 null（缺 metadata）或未匹配 active type/rule → 不计入任何 subtype（INVARIANT #2：aggregate ≥ Σsubtypes，未分类只进 aggregate）
- 无 active type/rule（map 空）→ 跳过第 2 查询

注入：records report_values 路径（site1）+ JSON/CSV export 路径（site3）的 `meta` 加 `reportSubtypeMinutes`；records-list summary（site2）不产 report_values，未触（out-of-scope）。

## Invariants（已测）

1. 缺 metadata/未匹配 subtype → `0`，非 `#ERROR!`
2. `aggregate ≥ Σ(subtypes)`；null/未知 subtype_key 只进 aggregate
3. custom 撞动态正则但 `systemDefined:false` → 不进 report output / formula source
4. 旧 `leave_duration`/`overtime_approval_duration` 总量不变（base 查询独立保留）

## Changed files

| 文件 | 改动 |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | 谓词×3 + 生成器×2 + 碰撞 guard；`loadAttendanceReportDynamicSubtypeContext`；merge `extraSystemDefinitions`；catalog 主+3 fallback 注入；`resolveAttendanceRecordReportFields` gap-1；`getAttendanceRecordReportFieldValue` gap-2；`loadApprovedMinutesRange` subtype 第 2 查询；records(site1)+export(site3) 注入；test surface 导出 |
| `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts` | +3 test（生成器/碰撞、报表门+公式源+值解析+INV#3、loadApprovedMinutesRange INV#2/#4）|
| `apps/web/tests/AttendanceReportFieldsSection.spec.ts` | +1 test（grid 渲染动态字段）|
| `docs/development/attendance-leave-overtime-subtype-{todo,development,verification}-20260515.md` | 计划/记录/验证 |
| `docs/development/attendance-dingtalk-formula-todo-20260515.md` | 请假/加班子类型 P2 → `[x]` |

## Out of scope（未来 follow-up）

- `loadApprovedMinutes`/`loadAttendanceSummary` subtype 拆分
- inactive type/rule 的 orphan catalog 记录 surfacing（`inactiveDynamicSubtypeCodes` warning）
- 加班三段独立规则 / 加班转调休余额 / 请假额度过期
- 加班规则 `code` 列（届时另做兼容）
