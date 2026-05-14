# 考勤统计字段多维表底座开发说明

日期：2026-05-13（2026-05-14 收口于 `codex/attendance-report-fields-foundation-20260514`）

## 背景

本次实现采用“考勤领域表为事实源，多维表作为报表字段配置层”的方案。`attendance_*` 继续承载打卡、排班、导入、回滚、审批和计薪周期等事务数据；多维表只承载统计字段目录、展示开关、字段说明和后续自定义字段入口。

## 后端实现

- `plugins/plugin-attendance/index.cjs` 新增 `attendance_report_field_catalog` 对象 descriptor。
- 插件通过 `context.api.multitable.provisioning.ensureObject()` 创建对象，`projectId` 固定为 `${orgId}:attendance`。
- 首次 provision 后通过插件作用域内的 `records.createRecord()` 补齐内置字段目录记录，不直接操作 `meta_*` 表。
- 新增只读接口：
  - `GET /api/attendance/report-fields`
  - 权限：`attendance:admin`
  - 返回：内置系统字段、字段分类、多维表配置合并结果，以及 multitable 对象入口信息。
- 新增同步接口：
  - `POST /api/attendance/report-fields/sync`
  - 权限：`attendance:admin`
  - 用于显式 provision / seed 字段目录，便于部署后或配置漂移后人工触发。
- 记录查询、JSON 导出和 CSV 导出复用同一份字段配置 envelope，并通过 `X-Attendance-Report-Fields-*` 响应头输出字段指纹、字段数量、字段编码和多维表 backing 信息。
- 多维表不可用或配置读取失败时，接口降级返回内置系统字段，并在 `multitable.degraded` 中标记原因。

## 字段范围

首版字段目录覆盖钉钉《考勤统计字段说明》的六类：

- 固定字段
- 基础字段
- 出勤统计字段
- 异常统计字段
- 请假统计字段
- 加班统计字段

每条目录记录包含：字段编码、字段名称、分类、来源、单位、是否启用、报表可见、排序、钉钉原字段名、说明、内部计算键。

## 前端实现

- 新增 `AttendanceReportFieldsSection.vue`，在考勤管理中心展示统计字段目录。
- `useAttendanceAdminRail.ts` 新增 `attendance-admin-report-fields` 导航项，归入“数据与计薪”分组。
- `AttendanceView.vue` 将统计字段区块接入管理中心，并提供跳转到对应多维表对象的入口。
- 记录表从固定列改为按字段配置渲染，配置不可用时回退到原有核心列。
- CSV 导出新增字段名称 / 字段编码两种表头模式，并在导出后展示本次使用的字段指纹和 backing 信息。

## 非目标

- 不迁移 `attendance_records` 或其他考勤主表到 `meta_records`。
- 不让考勤插件直接写 `meta_bases/meta_sheets/meta_fields/meta_records`。
- 不实现钉钉专业版“专家模式”的自定义公式执行；后续应接入统一公式引擎。
