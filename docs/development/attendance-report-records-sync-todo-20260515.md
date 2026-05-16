# 考勤 P2 attendance_report_records 同步层计划（定稿）

Date: 2026-05-15

## Summary

把考勤统计结果同步成插件私有多维表对象 `attendance_report_records`，让多维表承担二次公式 / 视图 / 筛选 / 权限 / 协作。3-PR 主线。内联公式编辑器后置（落地后很可能由多维表原生公式字段替代，届时再评估）。

**边界（硬，不可破）**：

- `attendance_*` 仍是唯一事实源。
- 多维表只存可重建的报表快照，不替代/不迁移 `attendance_*`。
- 不让多维表公式直读 `attendance_*`。
- 不裸写 `meta_*`，全程经 `context.api.multitable.provisioning` + `records.create/patchRecord`。
- 多维表公式用 `{fld_xxx}`（字段 id），考勤公式仍用 `{field_code}`（报表字段 code），两套 adapter 分离；底层 `FormulaService`/`FormulaEngine` 可共用，引用解析/权限/白名单/NOW-lookup 策略各自 adapter 管。

参见跨会话记忆 `project_attendance_multitable_report_boundary.md`。

## Orientation（离线坐实，无 DB/staging 凭据需求）

| 假设 | 来源 | 结果 |
| --- | --- | --- |
| `provisioning.ensureObject(descriptor)` 通用、可建第 2 个对象 | `ensureAttendanceReportFieldCatalog:1422→1440` | ✅ |
| descriptor 模式可镜像（`{id,fields,...}`） | `getAttendanceReportFieldCatalogDescriptor:951` + `ATTENDANCE_REPORT_FIELD_CATALOG_FIELDS:256` | ✅ |
| `records.patchRecord({sheetId,recordId,changes})` 存在且签名确切 | `plugin-after-sales/index.cjs:639` 等 10+ 处 | ✅ |
| `records.createRecord({sheetId,data})` | `seedAttendanceReportFieldCatalogRecords:1406` | ✅ |
| field-config fingerprint 可复用 | `buildAttendanceReportFieldConfigFingerprint:1830` | ✅ |
| daily 数据源 = 既有 export 路径（`loadAttendanceRecordReportFields` + subtype-aware `loadApprovedMinutesRange` + `buildAttendanceRecordReportExportItemAsync`，产含动态 subtype 的 `report_values`） | PR#1601 已坐实 | ✅ |
| period producer = `loadAttendanceSummary(db,orgId,userId,from,to)` | `:6545` | ✅（period 用，v1 不接） |

## 关键决策：Row Grain = daily-only v1

`workDate/period` 歧义在此钉死：**v1 只做 daily（每员工每工作日一行）**。

理由：daily 1:1 复用既有 export 路径（已产含动态 subtype 的 `report_values` + field-config fingerprint），零新聚合逻辑，幂等键自然稳定；period rollup 走另一个 producer（`loadAttendanceSummary`，range-keyed，shape 不同），强行并入 v1 会重犯 subtype slice 那个「多 producer 无 chokepoint」错误。**period 汇总行 = 显式 follow-up（下一条 slice，复用 `loadAttendanceSummary`）。**

## 幂等 upsert key（钉死）

逻辑 row key = `orgId : userId : workDate`（`workDate` 为 `YYYY-MM-DD`）。

- sync writer：`queryRecords` 按 `row_key` 查 → 命中 `patchRecord({sheetId,recordId,changes})`；未命中 `createRecord({sheetId,data})`。
- **不做「删旧建新」fallback**（制造 recordId churn；`patchRecord` 已确认可用，直接用）。
- 多维表对象内用稳定字段 `row_key`（= 拼接串）承载；`createRecord` 同时写 `row_key`，保证下次 `queryRecords` 命中。

### 物理 field id 规则（钉死，review 修正点 3）

`queryRecords` 的 filters / `createRecord` 的 data / `patchRecord` 的 changes **只接受真实物理 `fld_xxx` field id**，不接受逻辑字段名。所以：

- filter：`filters: { [fieldIds.rowKey]: rowKey }`（`fieldIds` 来自 `provisioning.resolveFieldIds`）
- create data / patch changes：同样全部用 resolved 物理 field id 作 key（沿用 catalog 的 `buildAttendanceReportFieldCatalogRecordData(field, fieldIds)` 那套 logical→physical 映射模式，新建 `buildAttendanceReportRecordData(stat, fieldIds)`）
- 逻辑字段名（`row_key`/`work_date`/统计 code）**只用于 descriptor 定义与 mapping 表**，绝不直接作为 record data / filter key

## 字段映射（descriptor `ATTENDANCE_REPORT_RECORDS_FIELDS`）

multitable provisioning contract 类型（review 修正点 4）：`string` / `date` / `dateTime` / `number` / `boolean`（**不是** `text`）。

| 逻辑字段 | descriptor 类型 | 来源 |
| --- | --- | --- |
| `row_key` | string | `orgId:userId:workDate`（幂等键） |
| `org_id` / `user_id` / `employee_name` / `department` / `attendance_group` | string | export item 固定字段 |
| `work_date` | date | 每日粒度 |
| 系统统计值（`work_duration`/`late_duration`/`early_leave_duration`/`leave_duration`/`overtime_approval_duration`/…） | number | export `report_values` |
| 动态 subtype 值（`leave_type_*_duration`/`overtime_rule_*_duration`） | number | export `report_values`（PR#1601） |
| 公式字段结果 | 按 output type 映射（见下） | export `report_values` |
| `field_fingerprint` | string | `reportFieldConfig.fieldsFingerprint.value`（本行用哪版字段配置算的） |
| `source_fingerprint` | string | 本行源数据 sha1（复算追溯 + 跳过未变行） |
| `synced_at` | dateTime | 同步时间戳 |

**公式/统计字段 → multitable 类型映射规则**（按 `formulaOutputType` / `unit`）：`number` / `duration_minutes` / `count` / `days` / `hours` → `number`；`date` → `date`；`boolean` → `boolean`；其余 → `string`。

descriptor 字段集**动态**：固定基础列 + 当前 enabled/reportVisible 的 report fields（含动态 subtype）。PR1 先定固定列 + 系统统计列；动态 subtype 列在 sync 时按当前 catalog 解析（provision 时补缺列，沿用 catalog 对象那套 `ensureObject` 补字段语义）。**`ensureFields` 只 upsert、不删除旧字段**——字段后来被隐藏/禁用、动态 subtype 消失时，多维表里旧列保留（known behavior）。v1 接受；orphan/stale columns cleanup = P2 follow-up。

**动态字段确定性（钉死，review 追加点）**：动态 subtype 列的 descriptor 顺序必须确定性排序，键 `sortOrder → code`；字段的物理 id 由逻辑 code 稳定生成（同一 code 永远映射同一 `fld_xxx`）。保证列顺序、`fld_xxx`、fingerprint 三者跨 sync 不抖。

**stale 值清空（钉死，review 修正点 2-补；PR2 必踩）**：`patchRecord` 是 **merge 语义**——某字段曾写过、后来隐藏/禁用/动态 subtype 消失，若 patch 时只是不再传该 key，旧值会留在 `meta_records.data` 里造成多维表残留旧统计。规则：patch 既有行时，**凡属 attendance-report-records 管理范围、但不在当前 active output fields 内的列，显式写 `null`/空值**（不是省略 key）。新建行不涉及（无旧值）。

## Fingerprint（钉死，特别盯的风险）

每行必写两个：

- `field_fingerprint` = 复用 `buildAttendanceReportFieldConfigFingerprint`，标识「这行结果是哪版考勤字段配置算出的」——后续多维表公式结果可追溯版本。
- `source_fingerprint` = 该行**要写入的稳定 payload** 的 sha1。构造规则（review 建议点 2，钉死）：取本次要落库的字段值 map，**排除 `synced_at` 与 fingerprint 字段自身**，对 key 做 sort 后再 hash —— 避免对象 key 顺序导致 fingerprint 抖动。

### skip 判定（review 修正点 2，钉死）

**不能只看 `source_fingerprint`**。字段配置变（`field_fingerprint` 变）但源数据没变时，只看 source 会跳过 patch，导致行里 `field_fingerprint` 留旧值、不可追溯。

正确判定：

```
skip  iff  existing.source_fingerprint === next.source_fingerprint
        && existing.field_fingerprint === next.field_fingerprint
否则     → patchRecord（两个 fingerprint 都重写）
```

两个 fingerprint 均已按字段映射逐行落库，**不引入第 3 个派生列 / schemaVersion**（v1 保持最小；`row_fingerprint = sha1(source+field+schemaVersion)` 方案考虑过但拒绝——多一列与 schemaVersion 簿记，收益不抵复杂度）。

## 失败降级（钉死，特别盯的风险）

- sync 是**独立可选管理员动作**，失败**绝不**影响 `GET /records` / export / `/report-fields`（它们不依赖 report-records 对象）。
- multitable provisioning/records 不可用或 `isDatabaseSchemaError` → 返回 **`{ ok: true, data: { degraded: true, reason, synced: 0 } }`**（review 建议点 1：这是可选同步层，不应让前端按主流程失败处理）。**只有真正的参数错误（如缺 `userId`/非法 `from-to`）才 `400`**。
- 单行 write 失败 → 记 warn、计入 `failed`，继续下一行（不整批回滚；下次 sync 幂等重试）。
- **sync 层永不成为事实源**：只读考勤算好的结果写多维表；考勤查询/导出永远直接走 `attendance_*`，从不读 report-records 对象。

## 3-PR 主线

### PR1 设计 + descriptor

- TODO（本文件）/ development / verification MD
- `ATTENDANCE_REPORT_RECORDS_OBJECT_ID` + `ATTENDANCE_REPORT_RECORDS_FIELDS` + `getAttendanceReportRecordsDescriptor()`
- `ensureAttendanceReportRecords(context, orgId, logger)`（镜像 catalog ensure：`provisioning.ensureObject` + `resolveFieldIds`）
- **不写 writer、不加路由、不前端**（纯 provision + 蓝图）
- 单测：descriptor 字段稳定、ensure 幂等（二次不重复建）、provisioning 不可用 → degraded 不抛
- orientation 子项：实测 `ensureObject` 对已存在对象补新字段的行为（确认动态 subtype 列可后补）

### PR2 sync writer

- `POST /api/attendance/report-records/sync`（`attendance:admin`，body `{ from, to, userId }`——**`userId` v1 必填**，review 修正点 1；沿用既有 `CONFIRM_SYNC` live 纪律）
- 全员同步 / 分页 / batch cursor = follow-up（否则 PR2 从 medium 变 large：要解决跨员工 approvedMap、分页、超时、部分失败汇总）
- 取数：复用既有 per-target-user export 构建流程（**单一权威路径，不另写聚合**）
- 写入：per row 用物理 field id `queryRecords({ filters: { [fieldIds.rowKey]: rowKey } })` → `patchRecord`/`createRecord`；按上方 skip 判定（source+field fingerprint 双等才 skip）；patch 时清空 stale 列（写 null）
- **重复行保险丝**：多维表无 `row_key` 唯一约束。若 `queryRecords(row_key)` 返回多条（并发/历史脏数据）→ v1 **patch 第一条**、其余计 `duplicateRowKeys` warn、**不自动删重复**（dedup = cleanup follow-up）
- 返回 `{ ok:true, data: { synced, patched, created, skipped, failed, duplicateRowKeys, fieldFingerprint, syncedAt } }`
- 单测：见测试矩阵

### PR3 前端入口 + 验证

- 考勤管理中心「同步到多维表报表」按钮 + 最近 syncedAt/记录数/fingerprint 展示 + 「打开多维表」入口
- mock acceptance：catalog → records → multitable rows 一致性（fingerprint 链）
- 一个 Vue 文件 + 一个 spec
- 落地记录：
  - development: `docs/development/attendance-report-records-sync-pr3-development-20260516.md`
  - verification: `docs/development/attendance-report-records-sync-pr3-verification-20260516.md`

## 测试矩阵（钉死）

| 类别 | 用例 |
| --- | --- |
| descriptor (PR1) | 字段稳定；ensure 幂等（二次不重复建）；provisioning 不可用 → degraded 不抛 |
| upsert (PR2) | 首次 → createRecord；再次同 key → patchRecord（非新建，用物理 fld id filter）；source+field fingerprint 双等 → skip |
| skip 边界 (PR2) | **源数据不变但字段配置变（field_fingerprint 变）→ 必须 patch，不 skip**（review 修正点 2 的回归红线）；两者皆不变 → skip |
| 幂等 (PR2) | 同 (from,to,userId) 连跑两次，记录数不翻倍，第二次全 skip/patch；source_fingerprint 对 key-sorted payload 稳定（顺序无关） |
| 字段 (PR2) | 隐藏/禁用字段不进新 row；动态 subtype 字段值正确进 row 且类型按映射规则；**字段先写后被隐藏 → patch 既有行时该列被显式写 null（不残留旧值）**（review 修正点 2-补回归红线）；动态列顺序按 `sortOrder→code` 确定性、同 code 同 `fld_xxx` |
| 重复行保险丝 (PR2) | `queryRecords(row_key)` 返回多条 → v1 patch 第一条、计 `duplicateRowKeys` warn、不自动删重复（cleanup follow-up） |
| fingerprint (PR2) | 每行有 field_fingerprint(=当前 catalog) + source_fingerprint；字段配置变 → field_fingerprint 变且行被 patch |
| 降级 (PR2) | multitable 不可用 → `{ok:true,data:{degraded:true,reason,synced:0}}` 不抛、不影响 export；缺 userId/非法 from-to → 400；单行失败 → failed++ 继续 |
| 边界 (PR2) | sync 失败后 `GET /report-fields`/export 仍正常（无耦合）；report-records 对象不被任何考勤查询读取 |
| 前端 (PR3) | 按钮触发 sync、展示 syncedAt/数/fingerprint、打开多维表入口；数据驱动无新组件 |
| 命令 | `node --check` / core-backend catalog+formula+sync vitest / web spec vitest / web type-check / core-backend build / `git diff --check` / 显式 stage（无 `-A`、无 node_modules） |

## Out of scope（显式 follow-up）

- period / 周期汇总行（复用 `loadAttendanceSummary`，下一条 slice）
- **全员同步 / 分页 / batch cursor**（v1 `userId` 必填；全员需解决跨员工 approvedMap、分页、超时、部分失败汇总——单独 slice）
- **orphan / stale columns cleanup**（`ensureFields` 只 upsert 不删；字段隐藏/禁用/动态 subtype 消失后旧列保留——P2 cleanup follow-up）
- **重复 row_key 行 dedup**（多维表无唯一约束；v1 只 patch 第一条 + warn，自动删重复 = cleanup follow-up）
- 多维表侧公式/视图模板预置（归多维表配置，非本线）
- 内联公式编辑器（后置；落地后很可能由多维表原生公式字段替代，届时再评估。已归档修正：`patchRecord` 非 `updateRecord`、PUT body 加 name/category/unit/sortOrder、严格 code 正则 + 三类拒编辑、存盘前复用 validator、成功重建 catalog+fingerprint、不做删旧建新）
- staging 真实 sync evidence（同既有，P1 补强，无凭据不伪造）

## Assumptions / 红线

- `provisioning.ensureObject` 支持给已存在对象补新字段（沿用 catalog 对象同语义；PR1 orientation 子项实测确认），但**只 upsert 不删**——orphan 列是 known behavior（P2 cleanup）
- sync 永不成为事实源；考勤查询/导出永不读 report-records 对象
- 不裸 SQL 写 `meta_*`；全程 multitable 插件 API；**所有 filter/data/changes key 用物理 `fld_xxx`（`resolveFieldIds`），逻辑名只用于 descriptor/mapping**
- 幂等键 `orgId:userId:workDate` 稳定；`row_key` 字段落行；`userId` v1 必填
- skip 仅当 `source_fingerprint` 与 `field_fingerprint` 双等；`source_fingerprint` 基于排除 `synced_at`+fingerprint 自身、key-sorted 的稳定 payload
- patch 既有行时，管理范围内但非 active output 的列显式写 `null`（patchRecord 是 merge 语义，不传 key 会残留旧值）
- 动态列确定性：descriptor 顺序 `sortOrder→code`，同 code 稳定映射同 `fld_xxx`，列顺序/fld_id/fingerprint 跨 sync 不抖
- `row_key` 无唯一约束：重复行 v1 patch 第一条 + `duplicateRowKeys` warn，自动 dedup = follow-up
- 降级返回 `{ok:true,data:{degraded:true}}`（可选层，非主流程失败）；仅参数错误 400
- 多维表公式 `{fld_xxx}` 与考勤公式 `{field_code}` adapter 分离，不混用

## Claude Code TODO

### PR1
- [x] 本 TODO MD + development + verification MD
- [x] `ATTENDANCE_REPORT_RECORDS_OBJECT_ID` + `ATTENDANCE_REPORT_RECORDS_FIELDS` + `getAttendanceReportRecordsDescriptor()`
- [x] `ensureAttendanceReportRecords(context,orgId,logger)` + test surface 导出
- [x] 单测：descriptor 稳定 / ensure 幂等 / provisioning 不可用降级
- [x] orientation 子项：实测 ensureObject 补字段行为，结论写进 development MD

### PR2（待 PR1 合并后）
- [x] `POST /api/attendance/report-records/sync` 路由 + writer（复用 export 路径）
- [x] upsert（queryRecords→patch/create）+ skip 仅当 source_fingerprint && field_fingerprint 双等
- [x] 单测矩阵（upsert/幂等/字段/fingerprint/降级/边界）

### PR3（待 PR2 合并后）
- [x] 前端同步入口 + syncedAt/数/fingerprint 展示 + 打开多维表
- [x] mock acceptance fingerprint 链一致性
