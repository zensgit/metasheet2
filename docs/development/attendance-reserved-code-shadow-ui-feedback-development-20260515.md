# 考勤 reserved-code shadow UI feedback 开发记录

Date: 2026-05-15

## Summary

P2 slice：把 Round 6 已经存在的「catalog merge 丢弃 raw alias 保留字字段」这一静默行为，透出到后端响应和前端 UI，让管理员能看到哪些字段因 code 撞保留字被丢弃。

纯附加式 surfacing——Round 6 的丢弃行为本身（merge + validator 双层防御）不动，公式计算语义不动，`attendance_*` 事实源不动，不直接写 `meta_*`。

## Background

Round 6 把 5 个 raw alias（`work_minutes` / `late_minutes` / `early_leave_minutes` / `leave_minutes` / `overtime_minutes`）设为保留字：`mergeAttendanceReportFieldDefinitions` 在 push 自定义字段时遇到 reserved code 直接 `continue` 丢弃。问题是这个丢弃是静默的——管理员在多维表里建了个 code 撞保留字的字段后，字段"消失"且无任何反馈，只能靠人工翻 catalog 记录排查。本 slice 闭合这个反馈缺口。

## Backend

`plugins/plugin-attendance/index.cjs`

- 新增 sibling helper `getAttendanceReportFieldDroppedReservedCodes(configRecords, fieldIds)`：
  - 复用 `mapAttendanceReportFieldConfigRecord` 映射每条 config 记录
  - 复刻 merge 的丢弃判定：非 system code 且 ∈ `ATTENDANCE_REPORT_FORMULA_RESERVED_CODES`
  - 返回去重 + 排序的 `string[]`
- 选 sibling helper 而非改 `mergeAttendanceReportFieldDefinitions` 返回类型——后者会破坏 ~15 处 caller/test（它们都期待数组）。代价仅是对 `configRecords` 多迭代一次纯映射。
- `buildAttendanceReportFieldCatalogResponse`：merge 之后调一次 helper，响应对象新增 `droppedReservedCodes: string[]`
- `buildAttendanceReportFieldCatalogFallback`：补 `droppedReservedCodes: []`（fallback 无记录 → 永远空，保持响应 shape 一致）
- `__attendanceReportFieldCatalogForTests` 导出 `getAttendanceReportFieldDroppedReservedCodes`

## Frontend

`apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`

- `AttendanceReportFieldsPayload` interface 增 `droppedReservedCodes?: string[]`
- 新增 computed `droppedReservedCodes`（默认 `[]`）
- 新增 warning banner：
  - **独立 `v-if="droppedReservedCodes.length > 0"`**（不是 `v-else-if`）——它与 loadError / degraded banner 正交，不应共用条件链
  - `role="alert"`、`data-report-field-dropped-reserved` 便于测试定位
  - 文案列出实际 codes + 补救动作（"在多维表字段目录里改成非保留 code 后才会重新出现"），中英双语
- 新增 `.attendance__status--warn` amber 样式（`#fde68a` / `#fffbeb` / `#92400e`），接在已有 `--error` 后；语义是"警告需处理"，区别于 neutral info 和 hard error；不新建 CSS 文件

## Constraints honored

- 不改 `attendance_*` 事实源
- 不直接写 `meta_*`（只读既有 catalog 记录，派生 metadata）
- 不改公式计算语义（Round 6 的丢弃行为原样保留，由其 test #12 锁定）
- 纯附加：新响应字段 + 新前端展示 + 新测试，无既有行为变更

## Changed files

| 文件 | 改动 |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | +helper、+response 字段、+fallback 字段、+test 导出 |
| `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue` | +payload 字段、+computed、+banner、+`--warn` CSS |
| `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts` | +1 test：`reports dropped reserved-code shadow fields` |
| `apps/web/tests/AttendanceReportFieldsSection.spec.ts` | +1 test：banner present + absent |
| `docs/development/attendance-reserved-code-shadow-ui-feedback-{development,verification}-20260515.md` | 本 slice 文档 |
| `docs/development/attendance-dingtalk-formula-todo-20260515.md` | P2 backlog reserved-code-shadow 项 → `[x]` |
