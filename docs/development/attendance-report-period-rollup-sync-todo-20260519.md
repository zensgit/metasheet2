# 考勤 Period Rollup 多维表同步计划（定稿）

Date: 2026-05-19

## Governance

默认由 **Codex 驱动实现**；Claude 只做 independent review 或 docs-only merge/cleanup。本文件本身即 docs-only 落地——把先前散落的本地计划版本化为仓库内 NAMED artifact，供 Codex 实现对照、供后续每个 PR 的 boundary 合同 review pin 引用。参见跨会话记忆 `project_attendance_multitable_report_boundary.md`（Codex-driven 主题，Claude review-only，不注入 parallel scope-gate、不自启、不 re-scope）。

## Summary

在已完成的 daily `attendance_report_records` 之上，新增「周期汇总报表层」多维表对象：每个员工每个周期一行。周期可来自手动 `from/to` 日期范围，也可来自 `attendance_payroll_cycles`。考勤事实源仍是 `attendance_*`；多维表只存可重建的汇总快照，用于月报、薪资周期、二次公式、视图与协作。

`attendance_report_period_summaries` 是 daily `attendance_report_records` 的**同级独立对象**：独立 descriptor、独立 writer、独立 UI 入口；daily sync 不改。

## 边界（硬，不可破）

- 不新增 `attendance_*` migration，不迁移事实源。
- 不让多维表公式直读 `attendance_*`。
- `attendance_report_period_summaries` 是可重建报表层，不作为查询 / 导出事实源。
- 不裸写 `meta_*`，全程经 `context.api.multitable.provisioning.ensureObject()` + `records.create/patchRecord`。
- summary 动态 subtype 字段在周期层按 approved request 汇总，不默默返回全 0。
- daily `attendance_report_records` 不改。
- v1 支持 date range 与 payroll cycle 两种模式；后台任务队列、自动跨页全量跑批、period dedup cleanup 留后续。

## Public Interfaces

- 新增插件私有多维表对象：`attendance_report_period_summaries`
  - `projectId` 仍为 `${orgId}:attendance`
  - 固定字段：`row_key`、`org_id`、`user_id`、`employee_name`、`department`、`attendance_group`、`period_type`、`period_key`、`cycle_id`、`period_name`、`period_start`、`period_end`、`field_fingerprint`、`source_fingerprint`、`synced_at`
  - 动态值列：summary 基础字段、summary 公式字段、leave/overtime subtype 周期汇总字段
- 新增接口：`POST /api/attendance/report-period-summaries/sync`
  - 权限：`attendance:admin`
  - body 必须二选一：
    - `{ from, to, userId | userIds | allUsers, page?, pageSize? }`
    - `{ cycleId, userId | userIds | allUsers, page?, pageSize? }`
  - 禁止同时传 `cycleId` 和 `from/to`
  - 返回 `{ ok:true, data:{ periodType, from, to, cycleId?, totalUsers?, page?, pageSize?, usersScanned, usersSynced, synced, created, patched, skipped, failed, duplicateRowKeys, fieldFingerprint, syncedAt, multitable } }`
- row key 固定：
  - date range：`${orgId}:${userId}:range:${from}:${to}`
  - payroll cycle：`${orgId}:${userId}:cycle:${cycleId}`

## Key Changes

### PR1：descriptor + ensure

- 新增 `ATTENDANCE_REPORT_PERIOD_SUMMARIES_OBJECT_ID`、固定字段 descriptor、默认 view descriptor。
- `ensureAttendanceReportPeriodSummaries()` 只通过 `context.api.multitable.provisioning.ensureObject()` provision，不裸写 `meta_*`。
- 不加 writer、不加路由、不改前端。

### PR2：writer + route

- 复用 `loadAttendanceSummary(db, orgId, userId, from, to)` 作为周期基础指标 producer。
- payroll cycle 模式先读取 `attendance_payroll_cycles`，解析 `startDate/endDate/name/templateId`，再走同一 summary producer。
- summary 公式复用现有 summary-scope 公式路径；动态 subtype 周期值由 `loadApprovedMinutesRange()` 汇总 `reportSubtypeMinutes` 后注入 summary value map。
- value columns 由「summary 默认字段 + summary 公式字段 + active dynamic subtype 字段」确定性生成，排序按 `sortOrder/code`，同 code 映射稳定 `fld_xxx`。
- upsert 规则沿用 daily sync：按物理 `fld_xxx` 的 `row_key` query，命中 patch，未命中 create；source + field fingerprint 双等才 skip；patch 时非 active managed 列显式写 `null`。
- 多条相同 `row_key`：patch 第一条，计 `duplicateRowKeys`，不自动删重复。

### PR3：前端入口 + live evidence

- 在考勤统计字段区域增加「同步周期汇总到多维表」入口。
- 支持 date range 与 payroll cycle 两种模式，支持单员工、`userIds`、`allUsers` 分页。
- 展示 synced/created/patched/skipped/failed、`fieldFingerprint`、`syncedAt`、打开多维表入口。
- staging live evidence 只在明确授权后执行，不写 production。

## Test Plan

- 后端单测：
  - descriptor 稳定、字段类型合法、ensure degraded 不抛。
  - date range 与 payroll cycle 参数校验：缺 user selection、同时传 `cycleId`/`from`/`to`、非法日期均返回 400。
  - `cycleId` 能解析到正确 `from/to`；不存在 cycle 返回 404。
  - 首次 sync create，重跑 skip，字段配置变化 patch。
  - source fingerprint 排除 `synced_at` 与 fingerprint 字段，key 排序稳定。
  - 动态 subtype 周期汇总正确，缺 schema 时降级为空 subtype 不阻断基础 summary。
  - summary formula 字段参与输出与 fingerprint；公式失败只影响该字段。
  - duplicate `row_key` 只 patch 第一条并计数。
  - multitable API 不可用返回 `{ ok:true, data:{ degraded:true } }`。
- 前端测试：
  - period sync 面板能切换 date range / cycle 模式。
  - `allUsers`/`page`/`pageSize` body 正确。
  - 成功结果、degraded、错误状态、打开多维表链接都能展示。
- 验证命令：
  - `node --check plugins/plugin-attendance/index.cjs`
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot`
  - `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web type-check`
  - `pnpm --filter @metasheet/core-backend build`
  - `git diff --check`

## Assumptions

- 不新增 `attendance_*` migration，不迁移事实源。
- 不让多维表公式直读 `attendance_*`。
- `attendance_report_period_summaries` 是可重建报表层，不作为查询 / 导出事实源。
- v1 支持 date range 与 payroll cycle；后台任务队列、自动跨页全量跑批、period dedup cleanup 留后续。
- summary 动态 subtype 字段在周期层按 approved request 汇总，不默默返回全 0。
- daily `attendance_report_records` 不改；period rollup 是独立对象、独立 writer、独立 UI 入口。

## Boundary 合同 cross-check（review-prep，非新增要求）

对照 `project_attendance_multitable_report_boundary.md` 的 6 点 review 合同——本节只是把合同条款映射到本计划，供 PR1/2/3 review 时逐项实测，不引入计划之外的新约束：

| # | 合同条款 | 本计划对应 |
| --- | --- | --- |
| 1 | multitable 不直接读/写 `attendance_*` | 不让多维表公式直读 `attendance_*`；`ensureObject()` provision、不裸写 `meta_*` |
| 2 | sync 只写私有 report 对象 | 新私有对象 `attendance_report_period_summaries`，独立 writer / UI |
| 3 | 每行带 source / fingerprint / period / syncedAt | 固定字段含 `source_fingerprint` / `field_fingerprint` / `synced_at` / `period_type` / `period_key` / `period_start` / `period_end` |
| 4 | 可重建报表层，非 `attendance_*` 迁移 | 可重建，不作查询 / 导出事实源 |
| 5 | 无新 `attendance_*` migration | 明确不新增、不迁移事实源 |
| 6 | 测试覆盖 date / period sync + 字段配置 fingerprint + 重复 sync 幂等 | Test Plan 覆盖 create→skip→patch、source fp 排除 `synced_at`、dup `row_key` 只 patch 首条计数、degraded、cycleId 解析 / 404 |

复用 daily sync（#1605）的 upsert / fingerprint / dup-row_key 纪律与 bulk sync（#1648）的参数互斥校验（`cycleId` 与 `from/to` 二选一→400、cycle 不存在→404）是一致性要求；review 时按 NAMED PR 逐 PR 实测。
