# 考勤 attendance_report_records 同步层开发记录 — PR2 (sync writer)

Date: 2026-05-16

## Scope（PR2 only）

PR2 = `POST /api/attendance/report-records/sync` writer。复用既有 per-user export 构建路径，不重写聚合。**不碰前端**（PR3）。边界（硬，未破）：`attendance_*` 仍是唯一事实源；report-records 只存可重建快照；全程经 multitable 插件 API，不裸写 `meta_*`；无 migration。

## Backend 改动

`plugins/plugin-attendance/index.cjs`（接在 `ensureAttendanceReportRecords` 之后 + route block）：

- `mapReportFieldToMultitableType(field)`：`number/duration_minutes/count/days/hours/minutes→number`、`date→date`、`dateTime→dateTime`、`boolean→boolean`、其余 `string`（formulaEnabled 取 `formulaOutputType`，否则 `unit`）
- `buildAttendanceReportRecordsValueColumns(catalogItems)`：value 列 = **全 catalog（含 disabled）稳定超集**，跳过 raw alias reserved code，order 确定（catalog 上游已 `sortOrder→code` 排序，此处保序）
- `attendanceReportRecordRowKey(orgId,userId,workDate)` = `orgId:userId:workDate`
- `buildAttendanceReportRecordSourceFingerprint(logicalPayload)`：sha1，**排除 `synced_at`+两 fingerprint 自身**，key-sort 后 hash（顺序无关、确定性）
- `syncAttendanceReportRecords(context,db,orgId,logger,{from,to,userId})`：
  1. `ensureAttendanceReportRecords` → 不可用 `{degraded:true,reason}` 不抛
  2. records API（query/create/patch）或 provisioning 缺 → `{degraded:true,reason:'MULTITABLE_RECORDS_API_UNAVAILABLE'}`
  3. 复用 export build：`getAttendanceFormulaRuntimeOptions` + `buildAttendanceReportFieldCatalogResponse`(full items 超集) + `loadAttendanceRecordReportFields` + `buildAttendanceReportFieldConfig.fieldsFingerprint.value`=`field_fingerprint`
  4. value 列经**同一 `ensureObject` upsert**补列（skeleton+valueColumns；ensureFields=INSERT ON CONFLICT DO UPDATE，幂等、不删——PR1 已坐实）
  5. `resolveFieldIds` 解析 skeleton+value 全部逻辑 id→物理 `fld_xxx`
  6. 复用 export 完全相同 SQL（`FROM attendance_records ar LEFT JOIN users u … user_id/org_id/work_date BETWEEN`）+ `loadApprovedMinutesRange`（subtype-aware）
  7. per row：enrich meta（leave/overtime/reportSubtypeMinutes）→ `buildAttendanceRecordReportExportItemAsync` → logical payload（skeleton + 每个 value 列：active 取 exportItem 值 / managed 但非 active 写 `null`=stale 清空）→ `source_fingerprint` → 物理 fld 化 data（+field/source fp+synced_at）
  8. `queryRecords({filters:{[physical rowKey]:rowKey}})` → 0 条 `createRecord` / ≥1 条：`>1` 计 `duplicateRowKeys`、patch 第一条；`existing.source==next.source && existing.field==next.field` → skip，否则 `patchRecord(changes=full data)`
  9. 单行异常 → `failed++` warn 继续，不整批回滚
  10. 返回 `{synced,patched,created,skipped,failed,duplicateRowKeys,fieldFingerprint,syncedAt}`
- 路由 `POST /api/attendance/report-records/sync`（`attendance:admin`）：body `z.object({from,to,userId}).min(1)` 全必填，非法 → `400 VALIDATION_ERROR`；`result.degraded` → `{ok:true,data:{degraded:true,reason,synced:0}}`；否则 `emitEvent('attendance.report_records.synced',...)` + `{ok:true,data:result}`
- test surface 导出 6 项（syncAttendanceReportRecords + 4 helpers + 已有常量）

## 与钉死 todo MD 的对齐

| todo 钉死项 | 落地 |
| --- | --- |
| userId v1 必填 | route zod `userId: string().min(1)`，缺 → 400 |
| 复用 export 不重写聚合 | 完全复用 export endpoint 同款 SQL + loadApprovedMinutesRange + buildAttendanceRecordReportExportItemAsync |
| 物理 fld id（filter/data/changes） | `resolveFieldIds` → `physical()`，queryRecords filter / create data / patch changes 全物理 id |
| skip 仅 source+field 双等 | `existingSource===next && existingField===next` 才 skip |
| stale managed 列写 null | value 列来自**全 catalog 超集**；active→exportItem 值，非 active→`null` |
| 重复 row_key 保险丝 | `>1` → `duplicateRowKeys += len-1`、patch 第一条、不自动删 |
| 降级 `{ok:true,data:{degraded:true}}` | route 对 `result.degraded` 返回该 shape；仅参数错误 400 |

## 关于 CONFIRM_SYNC（todo MD 措辞精化）

todo MD 写"沿用既有 `CONFIRM_SYNC` live 纪律"。orientation 实查：插件路由层**无** `CONFIRM_SYNC`——它是 ops live-acceptance 脚本（`scripts/ops/*`）的纪律，不是路由 gate。既有 `POST /report-fields/sync` 即「admin POST 即 gate，无额外 confirm」。PR2 `report-records/sync` **镜像 report-fields/sync**（admin POST gate，无路由层 CONFIRM_SYNC）。`CONFIRM_SYNC` 纪律归 PR3 的 mock/live acceptance 脚本。此为对 MD 措辞的精化，非行为偏移。

## stale-null 负路径测试说明（诚实标注，不伪造）

stale-null 正路径（active value 列取 exportItem 值、无 spurious null）由 writer 单测覆盖。负路径（field 曾 active 后被 disable → 该列 patch 写 null）是 writer loop 内联逻辑（`hasOwnProperty(exportItem,col.id) ? value : null`），其触发需「带 disabled 字段的 catalog config 记录」fixture——与单测用的 built-in fallback（全字段 active）冲突，强行双 mock 会大幅膨胀测试面。本轮**不伪造该负路径覆盖**：以代码引用 + 本说明 + verification MD 标注为「inline 逻辑 + reasoned guarantee」，完整负路径单测随 PR3 mock acceptance（用真实 catalog config fixture）或 staging 补。

## Changed files (PR2)

| 文件 | 改动 |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | +4 helper、+`syncAttendanceReportRecords`、+`POST /report-records/sync` route、+test surface 6 导出 |
| `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts` | +2 test（纯 helper；writer upsert/skip/skip-boundary/duplicate/degraded/export-decoupling）|
| `docs/development/attendance-report-records-sync-pr2-{development,verification}-20260516.md` | 本记录 + 验证 |

## Out of scope（PR3 / follow-up，todo MD 已钉死）

- PR3 前端同步入口 + fingerprint 链 mock acceptance（含 stale-null 负路径完整单测、disabled 字段 fixture）
- period 汇总行 / 全员同步分页 / orphan 列 + 重复行 dedup cleanup / 内联公式编辑器
- staging 真实 sync evidence（P1 补强，无凭据不伪造）

## Patch addendum (review round, 2026-05-16)

Review 抓到 2 个具体问题，已小补丁修复（同 PR2 分支新 commit）：

1. **valueColumns × fixed skeleton 碰撞（真 schema 覆盖 bug）**：`buildAttendanceReportRecordsValueColumns(catalog.items)` 原会把 `work_date`/`employee_name`/`department`/`attendance_group`（catalog 里也有这些 code）加成 value column。固定骨架 `work_date` 是 `date`，value column 会是 `string`；`[...skeleton, ...valueColumns]` 传给 `ensureObject`→`ensureFields`（INSERT ON CONFLICT DO UPDATE，同 logical id→同 stableMetaId 物理 id），后出现的 value column 会把 `work_date` 类型从 `date` 覆盖成 `string`。修法：`buildAttendanceReportRecordsValueColumns` 过滤掉 `Object.values(ATTENDANCE_REPORT_RECORDS_FIELDS)`（骨架已承载这 4 个 identity 值，value 列不应重复）。
2. **路由未用 `resolveAttendanceDateRange`（契约/实现不一致）**：原路由仅 `z.string().min(1)`，TODO 要求非法 from-to → 400。修法：路由调 `resolveAttendanceDateRange(from,to)`，`!ok`→`400 VALIDATION_ERROR`，writer 用 normalized `from/to`，emitEvent 用 normalized 值。镜像既有 export-endpoint 同款 idiom（8 处在用、`resolveAttendanceDateRange` 久经验证），故不为该 pre-existing helper 补冗余单测。

新增回归断言（catalog test）：value columns 与 skeleton 零交集；`[skeleton,...valueColumns]` 组合后 `work_date` 仅一次且 `type:'date'`、`employee_name/department/attendance_group` 各仅一次；writer 实测捕获传给 `ensureObject` 的 descriptor，`work_date` 仅一次且 `type:'date'`、`row_key` 等 skeleton 无重复。
