# 考勤内联公式编辑器开发记录

## Summary

本 slice 完成考勤统计字段 P2 的内联公式编辑器：管理员可在“统计字段”区域直接创建 custom formula 字段，也可对已有 custom formula 字段进行行内编辑、预览和保存。

事实源边界不变：`attendance_*` 仍是考勤事实源；公式配置仍落在插件私有多维表 `attendance_report_field_catalog`；本轮不新增 migration，不直接写 `meta_*` 表。

## Public Interface

新增接口：

`PATCH /api/attendance/report-fields/:code/formula`

权限：`attendance:admin`

Body：

```json
{
  "name": "异常净时长",
  "category": "anomaly",
  "unit": "minutes",
  "enabled": true,
  "reportVisible": true,
  "sortOrder": 4500,
  "dingtalkFieldName": "异常净时长",
  "description": "自定义公式字段",
  "internalKey": "formula.net_anomaly_minutes",
  "formulaEnabled": true,
  "formulaExpression": "={late_duration}+{early_leave_duration}",
  "formulaScope": "record",
  "formulaOutputType": "duration_minutes"
}
```

Response：

```json
{
  "ok": true,
  "data": {
    "operation": "created",
    "field": {},
    "catalog": {},
    "duplicateRowKeys": 0
  }
}
```

## Backend Changes

- 新增 `saveAttendanceReportFormulaField()`：
  - 只允许 custom formula code：`^[a-z][a-z0-9_]{1,79}$`。
  - 拒绝系统字段、动态 subtype 字段、raw alias reserved code、非法 code。
  - 自动 ensure `attendance_report_field_catalog`，但不直接写 `meta_*`。
  - 全量 `queryRecords` 后按 code 在内存定位记录，避免 filters physical/logical id 误用。
  - 构造保存后的候选 catalog，再复用 `mergeAttendanceReportFieldDefinitions()` 与 `validateAttendanceReportFormulaExpression()`。
  - 校验通过后，对既有记录走 `records.patchRecord({ sheetId, recordId, changes })`；无记录走 `records.createRecord({ sheetId, data })`。
  - `changes/data` 使用 resolved physical `fld_*` id。
  - 保存后重建 catalog response，返回最新 field 与 catalog。

- 新增 `PATCH /api/attendance/report-fields/:code/formula` route：
  - 复用 `attendance:admin`。
  - 用 zod 校验 body shape。
  - 保存成功后 emit `attendance.report_fields.formula_saved`。
  - 失败时返回 `{ ok:false, error:{ code, message } }`，不写记录。

## Frontend Changes

- `AttendanceReportFieldsSection.vue`：
  - 公式列中对 `systemDefined === false && formulaEnabled === true` 的字段展示 `Edit`。
  - 行内编辑支持表达式 textarea、输出类型 select、Preview、Save、Cancel。
  - Preview 复用既有 `POST /api/attendance/report-fields/formula/preview`。
  - Save 调用新增 PATCH 接口，并用返回 catalog 刷新本地 payload。
  - 函数参考面板新增“Create formula field”表单，用同一 PATCH 接口创建新的 custom formula 字段。
  - 系统字段、动态 subtype 字段、reserved code 不展示编辑入口。

## Design Notes

- 本轮采用 `PATCH` 而不是早期草案里的 `PUT`，因为插件上下文实际提供的是 `records.patchRecord()`，语义也是更新 catalog record 的公式配置片段。
- 前端不复制后端 validator；前端 preview/save 都走后端校验，避免函数白名单、raw alias gate、reserved code、dynamic subtype 等规则漂移。
- 新建字段本质仍是 multitable catalog record，不引入新存储，也不让多维表成为考勤事实源。

## Out Of Scope

- 不做函数参数面板、autocomplete、字段 picker。
- 不做删除公式字段。
- 不允许系统字段或动态 subtype 字段叠加 formula overlay。
- 不实现公式依赖图、循环检测或周期汇总级公式。
