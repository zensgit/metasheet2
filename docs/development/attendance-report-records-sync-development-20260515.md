# 考勤 attendance_report_records 同步层开发记录 — PR1

Date: 2026-05-15

## Scope（PR1 only）

PR1 = descriptor + ensure helper + 字段 id 解析 + degraded fallback + 单测 + ensureObject 补字段行为 orientation 实测。**不碰 writer / 路由 / 前端**（PR2 做 writer，PR3 做前端）。

边界（硬，未破）：`attendance_*` 仍是唯一事实源；本对象只存可重建报表快照；不裸写 `meta_*`，全程经 `context.api.multitable.provisioning`；PR1 无 records 写入。

## Backend 改动

`plugins/plugin-attendance/index.cjs`（接在 `ensureAttendanceReportFieldCatalog` 之后）：

- `ATTENDANCE_REPORT_RECORDS_OBJECT_ID = 'attendance_report_records'`
- `ATTENDANCE_REPORT_RECORDS_FIELDS`（10 个固定逻辑字段：`row_key/org_id/user_id/employee_name/department/attendance_group/work_date/field_fingerprint/source_fingerprint/synced_at`）
- `getAttendanceReportRecordsDescriptor()`：镜像 catalog descriptor 模式；类型用 provisioning contract `string/date/dateTime`（**无 `text`**）；`row_key` `validation.required`
- `ensureAttendanceReportRecords(context,orgId,logger)`：镜像 `ensureAttendanceReportFieldCatalog`——`provisioning.ensureObject({projectId,descriptor})` + `resolveFieldIds`/`getFieldId` 解析物理 id；`!provisioning?.ensureObject` → `{available:false,reason:'MULTITABLE_API_UNAVAILABLE'}` 不抛；`ensureObject` 抛 → catch → `{available:false,reason:'PROVISIONING_FAILED'}` 不抛
- test surface 导出 4 个：`getAttendanceReportRecordsDescriptor` / `ensureAttendanceReportRecords` / `ATTENDANCE_REPORT_RECORDS_OBJECT_ID` / `ATTENDANCE_REPORT_RECORDS_FIELDS`

## Orientation 实测结论（ensureObject 补字段行为，钉死）

读 `packages/core-backend/src/multitable/provisioning.ts`：

- `ensureObject({projectId,descriptor})` → `ensureSheet` + `ensureFields`，每个 descriptor field 的物理 id = `stableMetaId('fld', projectId, descriptor.id, field.id)`——**确定性**：同一逻辑 code 永远映射同一 `fld_xxx`（坐实 MD「同 code 稳定映射同 fld_xxx」）。
- `ensureFields`：对每个 descriptor field 执行 `INSERT INTO meta_fields ... ON CONFLICT (id) DO UPDATE SET name/type/property/order`——**纯 upsert，从不 DELETE 不在 descriptor 里的字段**。
- 推论 1（坐实 MD「ensureObject 补缺列」）：PR2 在 sync 时把 value 列（静态统计/动态 subtype/公式）加进 descriptor 再调 `ensureObject`，新列会被 INSERT 补上，已存在列被 UPDATE，**幂等**。
- 推论 2（坐实 MD「orphan/stale columns known behavior」）：字段从 descriptor 移除后 `meta_fields` 旧列**不会被删**——orphan 列保留是已知行为，cleanup = P2 follow-up。

**PR1 范围精化（基于上述结论）**：PR1 descriptor 只发固定 identity/provenance 骨架（10 列）。value 列（静态统计/动态 subtype/公式）改为 **PR2 在 sync 时按 live catalog 解析后经同一 `ensureObject` upsert 补列**——而非 PR1 硬编码一份静态统计列。理由：驱动 value 列来自 sync 时的 live catalog，避免 PR1 硬编码列表与 catalog 漂移，且让 列集/fld id/fingerprint 跨 sync 确定性。此为对 MD「PR1 先定固定列 + 系统统计列」的小幅强化（更强的 no-drift 性质），非矛盾；已在代码注释 + 本记录写明。

## Compatibility

- 无新 migration、无 `attendance_*` 改动、无 `meta_*` 裸写。
- PR1 无路由、无 records 写入、无前端；纯 provision 蓝图 + ensure helper。
- 既有 catalog/formula/subtype 路径零触碰（28 backend 单测全绿，无回归）。

## Changed files (PR1)

| 文件 | 改动 |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | +OBJECT_ID/FIELDS 常量、+`getAttendanceReportRecordsDescriptor`、+`ensureAttendanceReportRecords`、+test surface 导出 4 项 |
| `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts` | +1 test（descriptor 稳定 / 类型契约 / 幂等 ensure / 两条 degraded 不抛） |
| `docs/development/attendance-report-records-sync-{todo,development,verification}-20260515.md` | 计划（前轮已 review 钉死）+ 本记录 + 验证 |

## Out of scope（PR2/PR3，已在 todo MD 钉死）

- PR2：`POST /api/attendance/report-records/sync` writer（复用 export 路径、物理 fld id upsert、source+field fingerprint 双等 skip、stale 列写 null、重复 row_key 保险丝）
- PR3：前端同步入口 + fingerprint 链 mock acceptance
- period 汇总行 / 全员同步分页 / orphan 列 dedup 清理 / 内联公式编辑器 = 各自 follow-up
- staging 真实 sync evidence（P1 补强，无凭据不伪造）
