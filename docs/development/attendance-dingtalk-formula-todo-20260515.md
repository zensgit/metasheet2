# 考勤字段对齐钉钉与公式引擎 TODO

Date: 2026-05-15

## 背景

P0 已完成“考勤统计字段多维表底座”：`attendance_*` SQL 表继续作为考勤事实源，多维表承载统计字段目录、启用状态、报表可见性、排序和映射配置。

本轮 P1 目标是对齐钉钉字段管理体验，并提供受限版统计公式字段。当前 in-app browser 页面标题为“管理员设置拍照打卡”，该页面属于钉钉考勤设置能力，不直接改变本轮统计字段事实源方案。

## 决策

- 不迁移 `attendance_records` 到 `meta_records`。
- 不让考勤插件直接写 `meta_*` 表。
- 公式配置写入“考勤统计字段目录”多维表对象。
- 用户公式使用 `{field_code}` 引用考勤统计字段，不暴露多维表内部 `{fld_xxx}`。
- v1 只支持单条记录级公式，不支持跨人、跨天、跨周期聚合。
- v1 禁用 `NOW`、`TODAY`、lookup、自定义脚本等非确定性或跨表能力。

## 钉钉字段对齐矩阵

| 分类 | 钉钉字段/能力 | 当前字段编码 | 当前状态 | 公式需求 | 优先级 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 固定字段 | 日期 | `work_date` | supported | 否 | P0 | 已进入目录、记录与导出 |
| 固定字段 | 姓名 | `employee_name` | supported | 否 | P0 | 已进入目录、记录与导出 |
| 固定字段 | 考勤组 | `attendance_group` | supported | 否 | P0 | 来自记录 meta 或规则上下文 |
| 固定字段 | 部门 | `department` | supported | 否 | P0 | 来自员工/导入 meta |
| 固定字段 | 工号 | `employee_no` | supported | 否 | P0 | 来自员工/导入 meta |
| 固定字段 | 职位 | `position` | supported | 否 | P0 | 来自员工/导入 meta |
| 基础字段 | 打卡时间 | `punch_times` | supported | 否 | P0 | 上/下班时间集合 |
| 基础字段 | 打卡结果 | `punch_result` | supported | 否 | P0 | 与状态字段一致 |
| 基础字段 | 关联审批单 | `approval_forms` | config_only | 否 | P1 | 依赖审批摘要导入/归集 |
| 出勤统计 | 应出勤天数 | `expected_attendance_days` | supported | 否 | P0 | 由工作日/排班上下文计算 |
| 出勤统计 | 出勤天数 | `attendance_days` | supported | 否 | P0 | 当前为按日记录级值 |
| 出勤统计 | 工作时长 | `work_duration` | supported | 否 | P0 | 分钟单位 |
| 出勤统计 | 自定义净工作时长 | custom formula field | formula_needed | 是 | P1 | 例：`={work_duration}-{late_duration}` |
| 异常统计 | 迟到次数 | `late_count` | supported | 否 | P0 | 记录级规则 |
| 异常统计 | 迟到时长 | `late_duration` | supported | 否 | P0 | 分钟单位 |
| 异常统计 | 早退次数 | `early_leave_count` | supported | 否 | P0 | 记录级规则 |
| 异常统计 | 早退时长 | `early_leave_duration` | supported | 否 | P0 | 分钟单位 |
| 异常统计 | 缺卡次数 | `missing_clock_in_count` / `missing_clock_out_count` | supported | 否 | P0 | 上班/下班分列 |
| 请假统计 | 请假时长 | `leave_duration` | supported | 否 | P0 | 来自审批/导入归集 |
| 加班统计 | 加班审批时长 | `overtime_approval_duration` | supported | 否 | P0 | 来自审批/导入归集 |
| 加班统计 | 工作日加班 | `workday_overtime_duration` | supported | 否 | P0 | 按工作日上下文拆分 |
| 加班统计 | 休息日加班 | `restday_overtime_duration` | supported | 否 | P0 | 按工作日上下文拆分 |
| 加班统计 | 节假日加班 | `holiday_overtime_duration` | config_only | 否 | P1 | 依赖节假日标记导入/规则 |
| 专家模式 | 自定义公式 | custom formula field | formula_needed | 是 | P1 | v1 仅 record-scope |
| 专家模式 | 跨周期汇总公式 | - | out_of_scope_v1 | 是 | P2 | 后续接汇总/薪资周期引擎 |

## Claude Code TODO

- [x] 扩展字段目录 descriptor：`formula_enabled`、`formula_expression`、`formula_scope`、`formula_output_type`。
- [x] 扩展字段合并逻辑：多维表配置缺失时回退内置字段，配置存在时合并公式元数据。
- [x] 新增考勤公式包装层：解析 `{field_code}`、校验引用、函数白名单、错误封装。
- [x] 接入记录/导出：启用的公式字段进入 `reportFields`、JSON export、CSV export 和 field fingerprint。
- [x] 新增公式预览 API：`POST /api/attendance/report-fields/formula/preview`。
- [x] 前端统计字段区域展示公式徽标、表达式、范围、输出类型、引用和错误。
- [x] live acceptance 支持 `EXPECT_FORMULA_CODE` 并检查目录/记录/导出的公式字段。
- [x] 后端/前端/脚本测试覆盖公式字段主路径。

## P1 Closeout Follow-up

- [x] 公式白名单按函数大类补 wrapper 单测，每类至少一个代表函数：条件（`IF`）、数学（`ROUND`/`ABS`）、聚合（`SUM`/`COUNT`/`COUNTA`）、日期（`DATEDIF`/`DATE`/`YEAR`）、文本（`CONCAT`/`LEFT`/`LEN`）。
- [x] staging 环境补跑真实 live acceptance：2026-05-15 通过 SSH tunnel + admin JWT 跑通，48 checks PASS，evidence 在 `output/attendance-report-fields-live-acceptance/2026-05-15T07-01-24-382Z/`（已脱敏）。
- [x] 合并前复核真实 evidence 中 catalog、records、export、CSV label/code header 的 formula field fingerprint 一致：5 处全部 = `d7f0d74172d35268bae4295af089947ceeedd20f`。
- [x] staging 环境 seed 一个 formula 字段后重跑 + `EXPECT_FORMULA_CODE`，验证 formula 评估链路在真实后端的 evaluation。2026-05-18 已在 staging seed `net_anomaly_minutes`，48 checks PASS，5 处 field-config fingerprint 全部 = `684233f9c36205f9ea59248b29f9d050f88af0cd`。详见 `attendance-formula-live-evaluation-acceptance-development-20260518.md` / `attendance-formula-live-evaluation-acceptance-verification-20260518.md`。

## P2 TODO

- [x] 对齐钉钉明细拆字段：将“打卡时间”拆成上班 1/2/3、下班 1/2/3 六个报表字段。已落地（`punch_in_1..3`/`punch_out_1..3`，slot-1 接 first_in_at/last_out_at，slot-2/3 读 meta，placeholder）。详见 `attendance-punch-split-development-20260515.md` / `-verification-20260515.md`。
- [x] 对齐钉钉明细拆字段：将“打卡结果”拆成上班 1/2/3、下班 1/2/3 六个报表字段。已落地（`punch_result_in_1..3`/`punch_result_out_1..3`，**不复用日级 status**，读 meta 专用 key，当前空 placeholder，待 multi-punch ingest-persist P2 点亮）。
- [x] multi-punch ingest-persist（独立 P2）：导入路径将 `clockIn2/3`、`clockOut2/3` 与 `punchResultIn/Out1..3` 持久化进 `attendance_records.meta`，override 模式清空缺失的受管 punch key，已拆的 slot-2/3 + result 字段自动点亮。详见 `attendance-multipunch-ingest-development-20260517.md` / `-verification-20260517.md`。
- [x] 函数参考面板。已落地：`AttendanceReportFieldsSection.vue` 在统计字段区域展示 record-scope 引用语法、v1 函数白名单分组、示例公式与禁用项提示。详见 `attendance-formula-reference-panel-development-20260517.md` / `-verification-20260517.md`。
- [x] 内联公式编辑器。已落地：新增 `PATCH /api/attendance/report-fields/:code/formula` 存盘接口（经 multitable `patchRecord/createRecord`，保存前复用后端 validator），前端支持 custom formula 字段行内编辑、预览、保存，以及创建新的 custom formula 字段；系统字段、动态 subtype、reserved code 保持只读/不可见。详见 `attendance-inline-formula-editor-development-20260517.md` / `-verification-20260517.md`。
- [x] 公式字段依赖图与循环检测。已落地只读诊断层：`reportFieldConfig.formulaDependencyGraph` 汇总公式节点、依赖边、v1 已阻止的公式互引边与循环；前端统计字段区域展示摘要/风险提示，不放开 formula-to-formula 求值。详见 `attendance-formula-dependency-graph-development-20260517.md` / `-verification-20260517.md`。
- [ ] 周期汇总级公式。
- [x] 请假/加班子类型拆分字段。已落地：动态 `leave_type_<code>_duration` / `overtime_rule_<compactId>_duration`（来自 active `attendance_leave_types`/`attendance_overtime_rules`，碰撞 guard + 确定性排序），查询期 `loadApprovedMinutesRange` 按 metadata 聚合，旧 aggregate 不变，不迁移事实源/不写 meta_*。详见 `attendance-leave-overtime-subtype-development-20260515.md` / `-verification-20260515.md`。
- [ ] 与薪资周期字段模板联动。
- [x] Custom 非公式字段作为公式源——已落地 v2 opt-in：catalog descriptor 增加 `formula_source_mode`（`none` / `meta` / `internal_key` / `alias`），默认 `none` 保持 Round 5 拒绝语义；启用后可从 `row.meta[code]`、`internalKey` dotted path、命名 alias 进入 record-scope 公式，含危险路径 guard、disabled guard、fingerprint 纳入与单测。详见 `attendance-custom-formula-sources-development-20260517.md` / `-verification-20260517.md`。
- [x] Raw alias 全局门控——已落地：settings 增加 `formula.allowRawAliases`，env 增加 `ATTENDANCE_FORMULA_ALLOW_RAW_ALIASES` 覆盖；关闭后 validator、preview、records/export runtime 均拒绝 `{work_minutes}`、`{late_minutes}`、`{early_leave_minutes}`、`{leave_minutes}`、`{overtime_minutes}`。不复用 stat 字段 `enabled`。详见 `attendance-raw-alias-gate-development-20260515.md` / `-verification-20260515.md`。
- [x] Reserved-code shadow UI 反馈——已落地：`buildAttendanceReportFieldCatalogResponse` 暴露 `droppedReservedCodes: string[]`（sibling helper `getAttendanceReportFieldDroppedReservedCodes`，fallback 同步返回 `[]`），前端 `AttendanceReportFieldsSection.vue` 在非空时展示独立 amber warning banner（列 codes + 补救动作）。详见 `attendance-reserved-code-shadow-ui-feedback-development-20260515.md` / `-verification-20260515.md`。
