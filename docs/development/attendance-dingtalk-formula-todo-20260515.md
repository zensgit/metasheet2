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

- [x] 对齐钉钉明细拆字段：将“打卡时间”拆成上班 1/2/3、下班 1/2/3 六个报表字段。已落地（`punch_in_1..3`/`punch_out_1..3`，slot-1 接 first_in_at/last_out_at，slot-2/3 读 meta，并已由 multi-punch ingest-persist P2 点亮）。详见 `attendance-punch-split-development-20260515.md` / `-verification-20260515.md`。
- [x] 对齐钉钉明细拆字段：将“打卡结果”拆成上班 1/2/3、下班 1/2/3 六个报表字段。已落地（`punch_result_in_1..3`/`punch_result_out_1..3`，**不复用日级 status**，读 meta 专用 key；slot-2/3 与 result 字段已由 multi-punch ingest-persist P2 点亮）。
- [x] multi-punch ingest-persist（独立 P2）：导入路径将 `clockIn2/3`、`clockOut2/3` 与 `punchResultIn/Out1..3` 持久化进 `attendance_records.meta`，override 模式清空缺失的受管 punch key，已拆的 slot-2/3 + result 字段自动点亮。详见 `attendance-multipunch-ingest-development-20260517.md` / `-verification-20260517.md`。
- [x] 函数参考面板。已落地：`AttendanceReportFieldsSection.vue` 在统计字段区域展示 record-scope 引用语法、v1 函数白名单分组、示例公式与禁用项提示。详见 `attendance-formula-reference-panel-development-20260517.md` / `-verification-20260517.md`。**2026-05-18 增强（PR #1640）**：每函数 `title=` tooltip 含 description + example、独立"禁用函数"块（NOW / TODAY / lookup / cross-table / scripts）、Record↔Summary scope toggle、scope-aware 静态 chips（record 4 / summary 6 documented aliases）+ catalog-derived chips 仅在 record 渲染。详见 `attendance-formula-reference-panel-development-20260518.md` / `-verification-20260518.md`。
- [x] 内联公式编辑器。已落地：新增 `PATCH /api/attendance/report-fields/:code/formula` 存盘接口（经 multitable `patchRecord/createRecord`，保存前复用后端 validator），前端支持 custom formula 字段行内编辑、预览、保存，以及创建新的 custom formula 字段；系统字段、动态 subtype、reserved code 保持只读/不可见。详见 `attendance-inline-formula-editor-development-20260517.md` / `-verification-20260517.md`。**2026-05-18 增强（PR #1640）**：编辑器顶部追加 help 行回指上方参考面板与预览动作。
- [x] 公式字段依赖图与循环检测。已落地只读诊断层：`reportFieldConfig.formulaDependencyGraph` 汇总公式节点、依赖边、v1 已阻止的公式互引边与循环；前端统计字段区域展示摘要/风险提示，不放开 formula-to-formula 求值。详见 `attendance-formula-dependency-graph-development-20260517.md` / `-verification-20260517.md`。
- [x] 周期汇总级公式。已落地：`formula_scope=summary` 支持周期汇总源指标（`total_minutes` / `leave_minutes` / `work_duration` 等），接入 `/api/attendance/summary`、薪资周期 summary 与薪资周期 summary CSV 追加公式 metric；不进入日明细 record fields / report-records sync，不放开 formula-to-formula。详见 `attendance-period-summary-formulas-development-20260518.md` / `-verification-20260518.md`。
- [x] 请假/加班子类型拆分字段。已落地：动态 `leave_type_<code>_duration` / `overtime_rule_<compactId>_duration`（来自 active `attendance_leave_types`/`attendance_overtime_rules`，碰撞 guard + 确定性排序），查询期 `loadApprovedMinutesRange` 按 metadata 聚合，旧 aggregate 不变，不迁移事实源/不写 meta_*。详见 `attendance-leave-overtime-subtype-development-20260515.md` / `-verification-20260515.md`。
- [x] 与薪资周期字段模板联动。已落地后端 PR1 + 前端 PR2：薪资模板 `config.summaryFieldCodes` / `config.summaryFields` 可筛选并排序薪资周期 summary/export 字段，支持 summary 基础指标与 `formula_scope=summary` 公式字段；未配置时保持默认字段 + summary 公式字段兼容；管理页可直接选择/排序并保存为 `config.summaryFields`。详见 `attendance-payroll-summary-field-template-development-20260518.md` / `-verification-20260518.md` / `attendance-payroll-summary-field-template-ui-development-20260518.md` / `-ui-verification-20260518.md`。**Live evidence 已补齐**：2026-05-18 staging 创建含 `summaryFields` 的模板和周期，验证 summary API 与 CSV export 字段顺序一致，并验证 record-scope/hidden/unknown 字段进入 `droppedFieldCodes`。详见 `attendance-payroll-summary-field-template-live-development-20260518.md` / `-verification-20260518.md`。
- [x] Custom 非公式字段作为公式源——已落地 v2 opt-in：catalog descriptor 增加 `formula_source_mode`（`none` / `meta` / `internal_key` / `alias`），默认 `none` 保持 Round 5 拒绝语义；启用后可从 `row.meta[code]`、`internalKey` dotted path、命名 alias 进入 record-scope 公式，含危险路径 guard、disabled guard、fingerprint 纳入与单测。详见 `attendance-custom-formula-sources-development-20260517.md` / `-verification-20260517.md`。
- [x] Raw alias 全局门控——已落地：settings 增加 `formula.allowRawAliases`，env 增加 `ATTENDANCE_FORMULA_ALLOW_RAW_ALIASES` 覆盖；关闭后 validator、preview、records/export runtime 均拒绝 `{work_minutes}`、`{late_minutes}`、`{early_leave_minutes}`、`{leave_minutes}`、`{overtime_minutes}`。不复用 stat 字段 `enabled`。详见 `attendance-raw-alias-gate-development-20260515.md` / `-verification-20260515.md`。
- [x] Reserved-code shadow UI 反馈——已落地：`buildAttendanceReportFieldCatalogResponse` 暴露 `droppedReservedCodes: string[]`（sibling helper `getAttendanceReportFieldDroppedReservedCodes`，fallback 同步返回 `[]`），前端 `AttendanceReportFieldsSection.vue` 在非空时展示独立 amber warning banner（列 codes + 补救动作）。详见 `attendance-reserved-code-shadow-ui-feedback-development-20260515.md` / `-verification-20260515.md`。

## 收口矩阵（2026-05-15 → 2026-05-18）

本节是 P1 落地 + P2 backlog 全部收敛后的 hand-off 矩阵。"事实源 / 写入边界 / 迁移"列锁定每条 PR 是否触及 `attendance_*` 事实源、是否直接写 `meta_*`、是否新增数据库迁移——三列全 None 即"纯派生 / 纯展示"。"Staging evidence" 仅记录公式评估链路本身的 live acceptance，与其他 staging 验证（多维表、薪资周期 UI 等）独立。

### P1 — 公式 v1 主路径

| PR | Merged | 标题 | 后端 | 前端 | 测试覆盖 | 事实源 / 写入边界 / 迁移 | Staging evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #1579 | 2026-05-15 | report formula fields hardening（7 rounds） | 公式 wrapper / validator / 白名单 / preview / records-export 串通 | 公式徽标 + 表达式 + scope + 错误展示 | 后端 catalog/engine 单测 + 前端 spec + live acceptance 脚本 | None / None / None | `output/.../2026-05-15T07-01-24-382Z/`（48 checks PASS） |
| #1594 | 2026-05-15 | gate raw alias formulas | `formula.allowRawAliases` 设置 + env 覆盖 + validator/preview/runtime 全链路门控 | — | 后端单测 + 设置回归 | None / None / None | — |
| #1591 | 2026-05-15 | reserved-code shadow UI | `droppedReservedCodes` sibling helper + 响应字段 + fallback 一致性 | 独立 amber warning banner（codes + 补救动作） | 后端 + 前端 spec | None / None / None | — |
| #1619 / #1621 | 2026-05-18 | live formula evaluation acceptance plan + record | — | — | 计划 + 真实 staging 跑 | None / None / None | `2026-05-18` staging seed `net_anomaly_minutes`：48 checks PASS，5 处 fingerprint = `684233f9c36205f9ea59248b29f9d050f88af0cd` |

### P2 — Backlog 落地

| PR | Merged | 标题 | TODO 对应项 | 后端 | 前端 | 测试覆盖 | 事实源 / 写入边界 / 迁移 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #1598 | 2026-05-15 | split DingTalk punch report fields | 打卡时间 / 打卡结果 拆字段 | 12 个 split catalog 字段（`punch_in/out_1..3` × `punch_result_in/out_1..3`）；`punch_result_*` 不复用日级 status，读 meta 专用 key | 数据驱动，无新 UI 行为 | 后端 24 / 前端 16 | None / None（只读 `attendance_records.meta`） / None |
| #1601 | 2026-05-16 | dynamic leave/overtime subtype | 请假/加班子类型拆分字段 | active `attendance_leave_types` / `attendance_overtime_rules` 派生 `leave_type_<code>_duration` / `overtime_rule_<id>_duration`，碰撞 guard + 确定性排序 + metadata 聚合 | 子类型字段进 catalog/records/export | 后端 + 前端 spec | None / None / None |
| #1614 | 2026-05-18 | persist multi-punch import fields | 打卡时间 / 打卡结果 拆字段（点亮 slot-2/3） | 导入路径 stash `clockIn/Out2/3` + `punchResultIn/Out1..3` 进 `attendance_records.meta`，override 模式清空缺失受管键 | — | 后端 32 / 前端 19 | None / None（写自家 `attendance_records.meta`，非 `meta_*`） / None |
| #1615 | 2026-05-18 | formula function reference panel | 内联公式编辑器与函数参考面板（panel） | — | record-scope 引用语法 + v1 函数白名单分组 + 示例 + 禁用项提示 | 前端 spec（panel content + 数据驱动 chips） | None / None / None |
| #1617 | 2026-05-18 | inline report formula editor | 内联公式编辑器与函数参考面板（editor） | `PATCH /report-fields/:code/formula` 经 multitable `patchRecord/createRecord`；保存前复用后端 validator | 行内编辑 / 预览 / 保存 / 新建 custom formula 字段 | 后端 + 前端 spec | None / None / None |
| #1623 | 2026-05-18 | allow custom formula source fields | Custom 非公式字段作为公式源 | catalog `formula_source_mode`（`none` / `meta` / `internal_key` / `alias`），默认 `none` 保持 Round 5 拒绝；危险路径 / disabled / formula-to-formula guard；fingerprint 纳入 | source 模式 metadata 展示 | 后端 37 / 前端 23 | None / None（resolver 只读 `row.meta` / safe dotted path） / None |
| #1625 | 2026-05-18 | report formula dependency graph | 公式字段依赖图与循环检测 | `reportFieldConfig.formulaDependencyGraph` 汇总公式节点 / 依赖边 / 已阻止的公式互引边 / 循环 | 摘要 + 风险提示，formula-to-formula 仍拒 | 后端 + 前端 spec | None / None / None |
| #1632 | 2026-05-18 | period summary formula fields | 周期汇总级公式 | `formula_scope=summary` 接 `loadAttendanceSummary()` metrics（`total_minutes` / `leave_minutes` / `overtime_minutes` / `work_duration` 等）；不进日明细 / 日 record fields / `attendance_report_records` sync；保留 record-scope 默认 + 拒 formula-to-formula | scope 选择 + summary 示例；`/api/attendance/summary` 与薪资 summary CSV 追加 `formula_values` / `formula_fields` | 后端 41 / 前端 24 | None / None / None |
| #1635 / #1638 | 2026-05-18 | payroll summary field template + UI | 与薪资周期字段模板联动 | 模板 `config.summaryFieldCodes` / `config.summaryFields` 过滤/排序 summary 与 export 字段；支持 summary 基础指标 + summary 公式字段；未配置回退默认 | 管理页选择/排序 + 保存 `config.summaryFields` | 后端 42 / 前端 24 | None / None / None |
| #1640 | 2026-05-18 | augment formula reference panel + inline editor | 内联公式编辑器与函数参考面板（UX 补强） | — | per-function tooltip / disabled-functions 块 / Record↔Summary toggle + scope-aware chips / 编辑器 help 行 / preview 错误路径 spec | 前端 20（13 baseline + 7 new） | None / None / None |

### 边界相邻（attendance ↔ multitable report-records sync，非本 TODO 主线）

参考 [[attendance-multitable-report-boundary]]。这些 PR 不修改公式语义、不直接写 `attendance_*`，仅在私有 `attendance_report_records` 多维表对象上做派生 / 同步。

| PR | Merged | 标题 | 备注 |
| --- | --- | --- | --- |
| #1604 | 2026-05-16 | provision `attendance_report_records` (PR1) | descriptor only |
| #1605 | 2026-05-16 | report-records sync writer (PR2) | source / field fingerprint / period / syncedAt；rowKey upsert |
| #1609 | 2026-05-16 | report-records sync UI (PR3) | 触发 + 状态展示 |

### 边界纪律自检（所有 PR 同时通过）

- ✅ 不修改 `attendance_*` 事实源 schema（无新增迁移）
- ✅ 不直接写 `meta_*`（multitable 写入仅经 `patchRecord/createRecord`，且仅写私有 `attendance_report_records` 与字段 catalog）
- ✅ 公式 v1 不放开 formula-to-formula（依赖图只读，循环检测拒绝）
- ✅ 公式 v1 不放开 NOW / TODAY / 查找 / 跨表 / 脚本
- ✅ Raw alias 全局门控生效（`ATTENDANCE_FORMULA_ALLOW_RAW_ALIASES`）
- ✅ Reserved-code shadow（merge 层丢弃）+ UI 反馈（amber banner）双层防御
- ✅ Live evaluation acceptance 2026-05-18 staging 通过（48 checks PASS，5 处 fingerprint 一致）
