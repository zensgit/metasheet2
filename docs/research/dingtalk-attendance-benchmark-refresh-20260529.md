# 钉钉考勤对标 — delta 刷新（完整手册重抓 + 状态翻转 + 字段/公式细节）

> Date: 2026-05-29 · Author: Claude (manual re-crawl + code re-verify) · Status: **research / delta 刷新 — 非开工承诺**
> Scope: 在三份前序文档基础上做 **delta**，不重复推导排班/调度/假期/RBAC 的完整 gap 矩阵。
> 受 **K3 PoC Stage-1 锁** 约束：阅读/对标属允许的内核打磨研究；实施任何项均为独立 opt-in，涉及 integration-core/RBAC/auth 一律不碰。
> 竞品名仅限本研究稿（按 `feedback_formal_docs_own_principles_not_brand_names`）；正式设计文档只写 MetaSheet 自己的口径。

> ⚠️ **证据基准诚实声明**：本文撰写于分支 `codex/attendance-uuid-validation-20260526`（HEAD ≈ #1837），**落后 `origin/main`**（撰稿时 origin/main = #2040，落后 175 commit）。
> - **2026-05-29 轻量复核**（合并前已 rebase 到最新 main）：本稿建于 origin/main `a3ba6afde`（**#2053**，本 commit 的 parent）；复核 #2040→#2053 区间，attendance 域命中 **#2045**（reveal import batch admin section）+ **#2056**（clear stale forbidden report data）—— 二者均为小修、**非能力翻转**；其余为 multitable/admin/approvals/integration 类。且 **`index.cjs`/`engine.ts` 自 #2051 起未变**（diff 空），故下文行号稳定。**本稿结论不受影响。** 后续若再隔较多 commit，重跑此复核即可。
> - 直接读到的代码证据（`comprehensive_hours_*` 在 #1833、`resolveEffectiveCalendar` 在 #1789，均 < #1837）在本 checkout 与 origin/main **均成立**。
> - 标「origin/main」的状态翻转以 `git log origin/main` 的 PR 证据为准（非仅记忆）。
> - **§2「仍未翻转」清单 + §3.2 FormulaEngine 函数集 + §4 代码发现，均已在初稿后重新对 `origin/main:` blob 核实**（修正了一处来自 exploration agent 的「缺 lookup/date 函数」误判）。仍标「⚑ 待复核」者表示尚未追到生产点。

---

## 前序文档（权威基线，本文不重复推导，仅引用并刷新状态）

1. `dingtalk-attendance-vs-metasheet2-comparison-20260514.md` — 考勤高级版/假期高级版/假勤增强版/AI算薪 全量 gap 矩阵（A 排班/B 假期/C 加班/D 防作弊/E 算薪/F 通知/G UX）+ L2 细节（RBAC 4 层、外勤 9 开关、假期基础 4 发放方式…）。**未在本文翻转的项，一律以它为准。**
2. `dingtalk-attendance-optimization-plan-20260514.md` — 6 阶段落地计划（完整 SQL/API/PR 拆分）。**实施细节仍以它为模板。**
3. `dingtalk-advanced-scheduling-vs-metasheet2-20260522.md` — 付费「高级排班」12 章矩阵；明确声明「截图为登录态占位图，未消化视觉证据」。

**本文的 4 项 delta**：① 新信源（完整手册 + 截图，补 #3 的截图局限）；② 状态翻转（#1/#2/#3 标为「缺失」的几项已落）；③ 字段/公式细节下钻（#1 §7.8 延后的部分 + 专家模式洞察 + 修正）；④ 代码层新发现（computed-only 不落库的脆弱性）。

---

## 1. 新信源：完整手册离线包（带截图）

| 项 | 值 |
|---|---|
| 路径 | `/Users/chouhua/Downloads/alidocs-admin-manual-package/alidocs-admin-manual/`（入口 `index.html` / 合并版 `manual-combined.html` / 全册 PDF 214 MB） |
| 来源 docKey root | `alidocs.dingtalk.com/i/p/Y7kmbokZp3pgGLq2`（与 05-14 同源；本册为**基础版「管理员手册」** 14 章，非付费高级版） |
| 截图 | **412 张已本地化**（391 原图 + 21 截图兜底，`assets/images/`）→ **补上 05-22 文档明确声明的「截图未消化」局限**：本次可读字段名/默认值/配置面板 |
| 覆盖 | 考勤组（固定/排班/自由+大小周）· 7 种打卡方式 · 班次/排班/自动对班 · 四类规则 · 考勤统计（字段说明/自定义/导出/移动端）· 假期 · 多时区 · AI拍照异常 · API · 通知/提醒/申请入口 |

> 本册是 05-14 已对标过的同源基础版，但 05-14 §7.8 明确「140 加班规则只是另一层 TOC，需再下钻 1 层」「141 补卡/142 其他规则待对照」。本文 §3 补齐这些下钻 + 155 字段说明全表。

---

## 2. 状态翻转（ERRATA）— 前序文档标「缺失/部分」的几项已落

> 这是本文最重要的更新：05-14/05-22 文档的几个招牌 gap，在其后的 attendance 工作中已经建成。**前序文档相应结论作废，以下表为准。** 全部以 `git log origin/main` PR 证据坐实。

| 项 | 前序结论 | **2026-05-29 现状** | 证据（PR / 代码） |
|---|---|---|---|
| **综合工时制（年度/季/月工时上限）** | 05-22 ch10「❌ 缺 …**最低成本可补的合规缺口**，推为锁内首选」；05-14 P2「缺失」 | ✅ **已落（报表侧）** — 字段「综合工时超额/上限/来源/版本（分钟）」；`resolveAttendanceComprehensiveHoursCap()` 按 月/季/年 解析上限；origin/main 进一步加了 payroll_cycle cap 映射 + 模板窗校验 | `index.cjs:12584-12660`（origin/main：resolver `:12584` / value-cols `:12616` / excess 字段 `:12617` / period-builder `:12646`）· #1801（PR0-5 close）· #1819→#1836 · #1843/#1850 staging acceptance · #1887/#1894/#1900 payroll_cycle cap · #1923 quarter-year cadence（origin/main） |
| **effective-calendar（假期/节假日/日历策略分层覆盖）** | 05-22「部分实现 #1722/#1743」 | ✅ **全落** — `resolveEffectiveCalendar`（origin/main `index.cjs:11908`）+ 七态日历（班/休/假/加/补/出/训）+ 角色匹配 + 冲突告警 + Admin/HR 快捷增删（缩短/额外休息）+ closure audit | #1695(RFC)→#1707→…→#1779/#1781→#1782→#1785/#1788→#1789 |
| **考勤组 admin（list-detail 管理面）** | 05-14「无主/子负责人体系」「admin 全有/全无」 | ✅ **list-detail UX 已落**（Basic info + People 两条写路径 + 只读摘要卡 + 成员标签 enrichment） | #1946(design)→#1952→#1955→#1957→#1963→#1965 · #1974/#1980 label enrichment |
| **固定班制排班管理（按组 预览→应用 + 来源标记）** | 05-14「排班 UX 多为缺失/待确认」 | ✅ **已落** — 按考勤组 预览/应用 固定班表 + assignment provenance 列 + managed controls | #1984(design-lock)→#1991(preview)→#1994(apply)→#2007/#2016(provenance)→#2019/#2025(managed controls) |
| **排班权限范围模型（scheduler scope：主体×范围×动作）** | 05-14「无管理范围概念，admin 全有/全无」「管理范围 RBAC 缺失」 | ✅ **底层已落（产品包装待补）** — 主体 user/role/role_tag × 动作 view/edit/import/export/clear/approve/**dispatch** + scope targets；即钉钉「管理范围 + 分项权限」模型 | `index.cjs:48-49`（subject/action 枚举）· `:7467-7510`（normalize/map scheduler scope） |

**仍未翻转（继续以前序文档为准，不在本文重列）**：高级排班合规引擎（日/周/月工时上限 **强管控/超出禁止保存**）、**一天多班次/multi-slot**、临时划线排班、排班发布工作流、未排班提醒、调度/换班、人件费率、算薪引擎。（已扫 #1837→#2040 attendance/schedul/leave/overtime/punch 全部 commit 全无 flip；#2040→#2051 轻量复核仅 #2045 命中且非能力翻转。）
> 「管理范围 RBAC」从前序的「完全缺」**降级为「模型已落、缺工作台 packaging + dept/group scope-target」**（见上表新行）——前序结论相应修正。

> ⚠️ **两点 nuance**：
> 1. **综合工时制**已落部分是 `enforcement: 'warn'` 的**报表侧超额计算**。钉钉 ch10 的**排班保存时「超出禁止保存」强管控**仍缺——需尚未建的**排班合规引擎**（前序 P0-1）。即「能算并报超额」，尚不能「排班时挡住」。
> 2. **打卡方式**：采集层仍不属我方（见 §5），但 **group 级打卡策略配置**已在 origin/main 推进——#2029 设计锁 + #2033 考勤组卡片只读展示 workspace 级打卡策略。

---

## 3. 字段/公式细节下钻（补 05-14 §7.8 + 洞察与修正）

### 3.1 考勤统计字段全表（手册 155「字段说明」）

| 类 | 钉钉字段 | 我们的对应 | 落地深度 |
|---|---|---|---|
| 固定 | 姓名/考勤组/部门/工号/职位（不可删改） | employee_name/attendance_group/department… | ✓ 落库 |
| 基础-打卡时间 | 上班1-3/下班1-3 打卡时间 | punch_in_1..3 / punch_out_1..3（1/2 落 first_in/last_out + meta.clockIn2/3） | ✓ **3 对打卡 = parity**（钉钉也只到上班3/下班3，勿当差距） |
| 基础-打卡结果 | 上班1-3/下班1-3 打卡结果 | punch_result / punch_result_in_1 / _out_1 | ⚑ computed-only（见 §4） |
| 基础-审批单 | 关联请假/出差/补卡审批单 | approval_forms | ✓ |
| 出勤统计 | 应出勤天数 / 出勤天数 / 休息天数 / 工作时长 / 出差时长 / 外出时长 / 出勤班次 | expected_attendance_days / attendance_days / rest_days / work_duration / business_trip_duration / outing_duration / attendance_shift | 半：天数/工时落库；出差vs外出 ⚑ formula |
| 异常统计 | 迟到 / **严重迟到** / **旷工迟到** / 早退 / 上班缺卡 / 下班缺卡（次数+时长） | late_*（一等算）；severe_late_* / absence_late_* / missing_clock_*（目录 `index.cjs:925`+） | 迟到 ✓ 一等算；分级 ⚑ meta 透传（见 §4） |
| 请假统计 | 请假（通过审批单时长之和） | leave_duration / leave_minutes | ✓ |
| 加班统计 | 工作日 / 休息日 / 节假日 加班（分离） | workday/restday/holiday_overtime_duration | ⚑ formula 派生，引擎条件未按日型区分 |

**钉钉的可配口径（值得对标的细节）**：
- **应出勤天数**：=排班天数；**自由工时不计**、**未排班不计**、法定节假日/休息日不计。
- **出勤天数**：默认「有打卡即计（含休息日）」，**admin 可自定义规则**。
- 旧版报表不支持应出勤规则，需切新版。

> ⚑ 我方需复核：`expected_attendance_days` 是否落实「自由工时/未排班不计」语义；`attendance_days` / `rest_days` 说明文案是否撞车（exploration 提示二者 description 雷同）。

### 3.2 「专家模式」↔ 我们的 FormulaEngine（修正前序过头说法 + 修正我方初判）

**修正 A（前序）**：05-22 §3 称「钉钉考勤无公式引擎」——过头。手册 155 明确字段编辑有 **选项模式** + **专家模式**（「企业可自定义函数…系统提供运算符、字段和函数」），专家模式 **需钉钉专业版**，支持年度报表跨月/按年导出。

**修正 B（我方）**：初稿据 exploration agent 称我方「缺 lookup/date 函数」——**经 `origin/main:engine.ts` 复核为误判**。实际函数集见下。

| 维度 | 钉钉「专家模式」 | 我方 FormulaEngine（origin/main 复核） | delta |
|---|---|---|---|
| 形态 | 运算符 + 字段 + 函数自定义 | record-scope + summary-scope 公式列 + raw alias + 依赖图 + 循环检测 | ≈ 对位 |
| 商业 | **专业版收费** | 免费内置 | ✅ 我方优势 |
| 已具备 | 封闭（手册未列全） | **VLOOKUP/HLOOKUP/INDEX/MATCH**（`engine.ts:214-217`）+ DATE/DATEDIF/YEAR/MONTH/DAY + array 类型 + SWITCH + 数学/文本/逻辑 + `registerFunction()` 可扩展 | ✅ lookup/date 家族**已在** |
| 真实缺口 | — | **仅缺**：日期→串格式化(TEXT/FORMAT)、FILTER、正则(REGEX)、高阶数组(MAP/REDUCE)、per-field scope | 比初判窄得多 |

**修正后的口径**：钉钉**有**专家模式（收费 + 仅报表字段域 + 函数封闭）；我方 FormulaEngine **免费 + 跨 record/summary 域 + 可扩展**，且已有专门的 attendance 自定义公式 track（`docs/development/attendance-custom-formula-sources-*-20260517.md` / `attendance-dingtalk-formula-*-20260515.md`）。**我们在这条线上基本已是对位或领先**；剩余仅 4-5 个函数 + scope 的小补缺 —— 故 §5 的 A2 价值由初判的「🟢高」**下调为「🟡中」**。

### 3.3 补卡规则明细（手册 141，05-14 延后）

钉钉补卡可配：**次数 1-99 / 时限 0-180 天 / 类型限制（正常·缺卡·迟到·早退，且勾「正常」含「无需打卡」、勾「迟到」含「严重迟到」）/ 弹性打卡(晚到晚走)补卡时间顺延 / 每月起算日 / 自然日 vs 工作日**；代提交扣**实际补卡人**次数。

> 我方现状（前序 + exploration）：靠规则字符串识别 `补卡/缺卡`，**无次数/时限/类型强约束、无专用补卡表**。补齐 = 前序 P1，属规则细节优化。

---

## 4. 代码层新发现（前序文档未记）：分级/分型字段 computed-only / meta 透传

⚑ 基于 origin/main `index.cjs` 复核（HEAD 与 origin/main 一致）。

**基础迟到本身是一等计算**：`lateThresholdAt = shiftStart + lateGraceMinutes`，`lateMinutes = max(0, firstIn − lateThresholdAt)`（origin/main `index.cjs:9260-9263`）——这部分不是问题。

**问题在更细的分级/分型字段**——取值并非引擎按可配阈值自算，而是 `readAttendanceRecordMeta(...)` **从 meta 透传**（origin/main `:4357-4362`）：
- **严重迟到 / 旷工迟到**：`severe_late_count` / `absence_late_count`（目录 `:925`+；字段描述提及「超过严重迟到阈值」，但该**阈值在所读代码中未追到一等可配规则**；`internalKey: summary.severeLateMinutes` 的**生产点 ⚑ 待复核**——可能在某 summary 计算里，也可能纯透传）
- 缺卡：`missing_clock_in/out_count`（meta 透传）
- 加班分型：`workday/restday/holiday_overtime_duration`（公式派生，引擎条件未按日型区分）
- 出差 vs 外出时长：formula

**风险**：这正是 `feedback_metasheet2_skip_when_unreachable_blind_spot` / wire-vs-fixture 反复踩的「computed-only 不 round-trip」形态——上游（如钉钉导入）给了就显示，自己不算；一旦改走自算口径，易「单测对手搓 fixture 通过、真 wire 丢字段」。

**候选优化（横切）**：先追清 `summary.severeLateMinutes` 生产点；再决定 **严重迟到/旷工分级阈值**是否升为「**一等可配规则 + 自算 + 落库 + 真过线 round-trip 测试**」。

---

## 5. 优先级（产品负责人 2026-05-29 排定）

> 本节为**权威优先级**，取代初稿那版试探性的「细节内核打磨候选」。视角是**运营体感 + 产品价值**（不是单纯「锁内最易做」）。本文据代码核实补注两列：**extend-vs-build**（已有资产 / 是否 greenfield）与 **锁内可否启动**。
> 现状判断：我方底座已不弱 —— 考勤组 / 班次 / 轮班 / 假期日历 / 规则集预览 / 导入 / 报表字段 / 多维表快照 / **综合工时** / **固定排班组 preview/apply** 都有；尤其 **有效日历、节假日组差异、综合工时、固定排班** 最近补得多（见 §2）。下表是「从能配置 → 好操作」的下一步。
> 图例 锁列：🔒 = 新战线，等 GATE PASS · 🟢/🟡 = 锁内可议（内核打磨/小工程）· ⚫ = 不做。仍按 `feedback_staged_optin_lineage` 每项单独 opt-in、先 design-lock。

| 优先 | 方向 | 现状 / extend-vs-build（代码证据） | 锁内可否启动 |
|---|---|---|---|
| **P0** | **排班矩阵 UX**（周/月矩阵 · 复制上周上月 · 批量 · 清空 · 草稿/发布 · 修改窗口） | 底层 preview/apply(#1991/#1994) + scheduler-scope 已在；矩阵交互/复制粘贴/草稿态 = **build（前端为主）** | 🔒 新战线→GATE PASS 后（底座在） |
| **P0** | **自动对班**（仅未排班场景，按打卡匹配最近班次，admin 可核对修改） | **确认无**（grep 0）；与固定排班 preview/apply 是两件事 | 🔒 新链路→GATE PASS 后；feature-flag off 灰度、**只做未排班不覆盖人工**（前序已设计 derived_from） |
| **P0** | **未排班提醒** | cron + notification-channels（渠道已有）；缺 扫描+推送 | 🔒 小工程但属排班战线→GATE PASS 后 / 独立 opt-in |
| **P0** | **考勤组打卡策略**（地点 · 外勤 · 外勤需审批 · 拍照/备注 · 未排班是否可打卡） | #2029 设计已锁 + #2033 卡片只读展示；**配置字段 = greenfield** | 🔒 新战线→GATE PASS 后 |
| **P1** | **子管理员范围 / 考勤管理员工作台**（按 dept/group/schedule-group + 细到 排班/导入/导出/审批/清空/调度） | **primitives 已在**：scheduler scope 7 动作（含 dispatch）+ subject + scope targets（`index.cjs:48-49`,`:7467-7510`）；缺 工作台 UX + dept/group scope-target | 🟢 模型已落 → 工作台属**内核打磨可议**（若客户提）——比 P1 排位更可行 |
| **P1** | **草稿 / 发布 / 审批后发布** | 前序已设计 status 机；缺实现 | 🔒 跨 attendance+approval→GATE PASS 后 |
| **P1** | **外勤需审批** | 复用 attendance_approval_flows（已有） | 🔒 GATE PASS 后 |
| **P1** | **团队统计通知**（上/下班前后 · 缺卡 · 团队日/周/月报）+ **员工端一键**（请假/加班/补卡/出差入口） | notification-channels + 报表字段 + attendance_requests(5 类) 已有；缺 聚合推送 + 入口 UI | 🟡 通知聚合=小工程；入口 UI 跨域→视范围 |
| **P2** | **假期余额 过期/延期 + 批量** | 余额子系统 **greenfield**（leave types + `paid` 已在，无 balance 表） | 🔒 GATE PASS 后 |
| **P2** | **待审批假期可视化** | effective-calendar 已在，可叠 pending 层 | 🟡 可扩展（effective-calendar 内核打磨） |
| **P2** | **团队可用性日历** | effective-calendar 已在，可聚合团队视图 | 🟡 可扩展 |
| **P2** | **调度 / 换班** | 新表（scheduler scope 已含 dispatch 动作位） | 🔒 GATE PASS 后 |
| **P3** | 人脸 / 考勤机 / 越狱检测 / AI 算薪 | 依赖设备 / 合规链路 | ⚫ 不补 / 对接外部 SaaS |

**锁内可立即启动的子集（不等 GATE 的内核打磨；与上面多属 post-GATE 的 P0/P1 互补）**：
- 🟢 **子管理员工作台**（scheduler-scope 模型已在，纯 UX 包装 + dept/group target）—— 若客户提，是 P1 里唯一锁内可启动的。
- 🟢 **待审批假期 / 团队可用性日历**（基于 effective-calendar 扩展，P2 里锁内可启动的）。
- 🟡 **报表质量打磨**（owner 未单列，但属 §3/§4 实证缺口）：严重迟到/旷工分级阈值一等化+落库（§4，先追 `summary.severeLateMinutes` 生产点）· 出勤口径可配+命名修正（§3.1）· 专家模式函数补全（TEXT/FORMAT·FILTER·REGEX·高阶数组·per-field scope，§3.2，价值比初判小）。

**明确不补（P3，错层/方向不符，沿用前序结论）**：7 种打卡方式**采集**、AI 拍照异常识别、防作弊（依赖原生 App）、对外公开 API。

---

## 6. 复审条件 / 出范围声明

**何时复审本文**：
1. 本 checkout sync 到 origin/main 后，复核 §4 的 `summary.severeLateMinutes` 生产点 + computed-only 发现是否仍成立（截至 2026-05-29 已 rebase 复核到 #2053，attendance 命中 #2045/#2056 均非翻转；再隔较多 commit 时重跑）。
2. 任一 §5 候选被客户需求或 GATE PASS 触发，进入 design-lock 前以本文 + 前序 #2 落地计划作首轮可行性判断。
3. 钉钉手册重大改版（>6 个月）时重抓 diff。

**不做什么**（沿用 05-22 §6）：
- ❌ 不基于本文直接开 slice —— 决策参照，非 backlog。
- ❌ 不凭手册截图盲抄钉钉 UI。
- ❌ 不基于「对标焦虑」单方面开 RFC —— 须客户需求或 GATE PASS 触发。

**诚实声明**：
- 本文 checkout 落后 origin/main 175 commit；§2 翻转 + §3.2 函数集 + §4 发现已用 `origin/main:` blob/git log 坐实，仍有 `summary.severeLateMinutes` 生产点标 ⚑ 待复核。
- 内容版权：阿里巴巴（中国）有限公司；本文**仅供 metasheet2 内部产品决策参照**。

---

## 参考

- 手册离线包：`/Users/chouhua/Downloads/alidocs-admin-manual-package/alidocs-admin-manual/`（412 图本地化）
- 前序文档：`dingtalk-attendance-vs-metasheet2-comparison-20260514.md` · `dingtalk-attendance-optimization-plan-20260514.md` · `dingtalk-advanced-scheduling-vs-metasheet2-20260522.md`
- 代码证据（origin/main）：`plugins/plugin-attendance/index.cjs`（`:925` 分级字段目录 · `:4357-4362` meta 透传 · `:9260` 迟到一等算 · `:11908` resolveEffectiveCalendar · `:12584-12660` 综合工时 cap）· `packages/core-backend/src/formula/engine.ts`（`:214-217` lookup 家族）
- 相关 memory：[[project_attendance_effective_calendar_complete]] · [[project_attendance_multitable_report_boundary]] · [[project_attendance_group_admin_ux_chain]] · [[project_k3_poc_stage1_lock]] · [[feedback_metasheet2_skip_when_unreachable_blind_spot]] · [[feedback_formal_docs_own_principles_not_brand_names]]
