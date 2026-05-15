# 考勤打卡时间/结果拆字段开发记录

Date: 2026-05-15

## Summary

P2 slice：把钉钉「打卡时间」「打卡结果」对齐成 1/2/3 拆字段——新增 12 个 catalog 字段(上班/下班 × 1/2/3 时间 + 上班/下班 × 1/2/3 结果)。strict Option A(presentational split):一次性铺完整 DingTalk 字段形状,slot-1 接真实数据,slot-2/3 与全部结果字段为 documented placeholder。

不改 `attendance_*` 事实源 schema,不改 ingest 写入路径,不改公式计算语义,只读 `attendance_records` 行自身的 `meta` jsonb(≠ 写 meta_* 多维表)。旧 `punch_times`/`punch_result` 聚合字段**保留**(additive)。

## 决策与约束(A1-safe)

| 决定 | 理由 |
| --- | --- |
| 一次铺完整 12 字段形状(A1) | 形状对齐 slice;未来 ingest-persist P2 落地后数据直接流入已存在列,避免第二次 catalog 形状 churn |
| **`punch_result_*` 绝不用 `row.status` 填 slot-1** | `row.status` 是日级考勤结果,不是单次打卡结果;用它填 `punch_result_in_1` 形状对齐但语义污染。结果字段全部读 `row.meta` 专用 key,当前为空 placeholder |
| slot-2/3 时间读 `row.meta`(clockIn2/3 等) | import 已解析多段打卡但仅作 engine.evaluate 临时输入、不落库(3+ site 无 chokepoint);本 slice 不动 ingest,读 meta 多键 fallback,当前多为空 |
| 旧聚合字段保留 | additive,不破坏既有引用 `punch_times`/`punch_result` 的报表;未来 cleanup 可能 deprecate(届时单独评估) |
| 不做 ingest-persist | 多 site、无共享 chokepoint,属独立 P2(见下方 follow-up) |

## 命名约定

时间字段与结果字段采用 **in/out 平行式**,与既有 `missing_clock_in/out_count` 风格一致,消除"哪次打卡"歧义,且对齐 DingTalk「上班N/下班N」列:

| code | dingtalkFieldName | 取值来源 |
| --- | --- | --- |
| `punch_in_1` | 上班1打卡时间 | `row.first_in_at` |
| `punch_out_1` | 下班1打卡时间 | `row.last_out_at` |
| `punch_in_2` | 上班2打卡时间 | `row.meta` `['clockIn2','clock_in_2','上班2打卡时间']` |
| `punch_out_2` | 下班2打卡时间 | `row.meta` `['clockOut2','clock_out_2','下班2打卡时间']` |
| `punch_in_3` | 上班3打卡时间 | `row.meta` `['clockIn3','clock_in_3','上班3打卡时间']` |
| `punch_out_3` | 下班3打卡时间 | `row.meta` `['clockOut3','clock_out_3','下班3打卡时间']` |
| `punch_result_in_1` | 上班1打卡结果 | `row.meta` `['punchResultIn1','punch_result_in_1','上班1打卡结果']` |
| `punch_result_out_1` | 下班1打卡结果 | `row.meta` `['punchResultOut1','punch_result_out_1','下班1打卡结果']` |
| `punch_result_in_2` | 上班2打卡结果 | `row.meta` punchResultIn2 类 |
| `punch_result_out_2` | 下班2打卡结果 | `row.meta` punchResultOut2 类 |
| `punch_result_in_3` | 上班3打卡结果 | `row.meta` punchResultIn3 类 |
| `punch_result_out_3` | 下班3打卡结果 | `row.meta` punchResultOut3 类 |

## Backend

`plugins/plugin-attendance/index.cjs`

- `ATTENDANCE_REPORT_FIELD_DEFINITIONS`：在 `punch_result` 后新增 12 条定义(category `basic`,source `system`,时间 unit `dateTime`、结果 unit `text`,每条带 `dingtalkFieldName` + placeholder 说明)
- `getAttendanceRecordReportFieldValue` switch：新增 12 case
  - `punch_in_1`/`punch_out_1` → `formatAttendanceRecordReportDateTime(row.first_in_at/last_out_at, timezone)`
  - `punch_in_2/3`/`punch_out_2/3` → `formatAttendanceRecordReportDateTime(readAttendanceRecordMeta(row, [...多键]), timezone)`;缺失 → `''`(format 对 falsy 返回 `''`,非 `#ERROR!`)
  - `punch_result_*` → `firstNonEmptyValue(readAttendanceRecordMeta(row, [...多键]))`;缺失 → `''`;**不读 status**
- `ATTENDANCE_RECORD_REPORT_FIELD_CODES`：注册 12 个新 code(在 `punch_result` 后),使其进入 Round5 `formulaSourceFields`(systemDefined-only filter),公式可引用 `{punch_in_1}` 等而不被 validator 拒

## Frontend

`apps/web/src/views/attendance/AttendanceReportFieldsSection.vue` 无需改动——组件纯数据驱动,新 catalog 字段经既有 `fieldsByCategory` grid 渲染。仅补 spec 确认渲染。

## Constraints honored

- 不改 `attendance_*` 事实源 schema、不动 ingest 写入路径
- 不直接写 `meta_*` 多维表;只读 `attendance_records.meta` jsonb
- 不改公式计算语义(slot 空值 → `''`;公式上下文 `attendanceFormulaLiteral('')` → `'0'`,既有行为)
- 旧 `punch_times`/`punch_result` 保留,additive,无破坏

## Changed files

| 文件 | 改动 |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | +12 field defs、+12 switch case、+12 注册 code |
| `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts` | +1 test(slot-1 真值 / slot-2 读 meta / slot-3+result 空非 #ERROR! / **result 绝不等于 status 的硬不变量** / formula 源校验 / export+CSV DingTalk 列名) |
| `apps/web/tests/AttendanceReportFieldsSection.spec.ts` | +1 test(grid 渲染新字段名+code) |
| `docs/development/attendance-punch-split-{development,verification}-20260515.md` | 本 slice 文档 |
| `docs/development/attendance-dingtalk-formula-todo-20260515.md` | P2 拆字段两项 → `[x]` |

## Future follow-up (独立 P2,不在本 slice)

- **multi-punch ingest-persist**：import 已解析 `clockIn2/clockOut2/clockIn3/clockOut3`(`上班2/3 下班2/3打卡时间`),但仅作 `engine.evaluate` 临时输入、3+ site 无 chokepoint、未落 `row.meta`。后续 P2 在 ingest 持久化这些 key(及 per-punch 结果 `punchResultIn/Out N`)进 `attendance_records.meta`,本 slice 的 slot-2/3 与全部结果字段即自动点亮,无需再改 catalog 形状。
- 旧 `punch_times`/`punch_result` 聚合字段的 deprecation 评估(需确认无下游报表硬依赖后再议)。
