# 钉钉考勤对标 — refresh 审计 v2（2026-06-14：tracker 全闭环后的「下一梯子」）

> **状态**：research / **决策参照，非 backlog**（沿用 base §6 纪律：不据本文直接开 slice；每项须 owner 选定 + 独立 design-lock + 独立 opt-in 才开工）。
> **基线**：代码实测 @ `origin/main` `058e9c032`（plugin `index.cjs` 37,449 行）；本文是对 `docs/research/dingtalk-attendance-benchmark-refresh-20260529.md`（base，2026-05-29）的 **delta 刷新**。
> **执行账本**：`docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md` — **本轮列入的目标已全部 ✅**（H2 MUST + H2 SHOULD + OPTIONAL-3a + §0.3 C5；2026-06-14 复核）。
> **为什么有这份文**：base §5 的 priority 表写在 H2/SHOULD/OPTIONAL 大潮**之前**，其 P0/P1/P2 大半已落。本文做三件事：① 与 base §5 重新对齐（ERRATA）；② 逐项代码实证「幸存候选」；③ 按 **价值 × 成本 × 可并行独立性** 重排梯子 + 标注并行泳道，供 owner 选下一条 arc。
> **竞品名仅限本研究稿**（`feedback_formal_docs_own_principles_not_brand_names`）；正式 design doc 只写 MetaSheet 自己口径。OUT 红线（§4）不变。

---

## 0. TL;DR

- **tracker 全闭环**（committed 文档 + 代码符号实测 + **0 个未合考勤 PR** 三方坐实）。base §5 的 P0/P1/P2 招牌项大半已 done（§1）。
- **幸存候选 = 8 个产品候选 + 1 个非主线清理项**（H1 scheduler-scope leftover，不与产品 arc 同级），按价值×成本×可并行独立性重排为 **4 档 + 收尾**（§2）。
- **头条候选 = 法定/年假额度引擎**：`年假` 当前仅是 leave-type 标签（grep 实测 1 命中、无 balance/accrual/结转/过期），但可**直接复用** comp_time 已建的 grant-lot ledger（`attendance_leave_balances` + events）+ ④ C4 的 `AttendanceScheduler` expiry 基座 → 高价值、低边际、独立链。
- **并行首波建议 = 3 条 feature/merge 级独立的纵向链**：①年假额度引擎 ②员工自助工作台（前端为主）③通知渠道扩展（C5 worker 已有 `AttendanceDeliveryChannel` adapter seam）。**仅 ③ 文件级真正不相交**；首波里 **① 仍编辑 `index.cjs`**，靠 worktree + rebase/baseline-first 纪律并行（换班/小组织/调度正是这样并行 `index.cjs` 出的，**非零撞车**）（§3）。
- **必须串行/谨慎** 的是动 effective-calendar 核心 resolver / `attendance_records` 一日一行模型 / 报表共享算的项（夜班深化、弹性打卡、pending/team overlay、报表分级阈值）。
- 每项仍 design-lock + 独立 opt-in；owner 选定后锁成新的 **§0.4 目标块**（沿用 §0.1/0.2/0.3 的 In/Out/预算/完成口径格式）。

---

## 1. 与 base §5 重新对齐（ERRATA — 大半已落）

> base 2026-05-29 的 §5 priority 表，对照当前 tracker 全闭环状态：

| base §5 项 | base 档 | **2026-06-14 现状** | 证据 |
|---|---|---|---|
| 排班矩阵 UX（周/月矩阵·复制·批量·草稿/发布·修改窗） | P0 | ✅ 多班次/发布草稿/修改窗均落 | M1–M5 · P0–P4 · #2197 |
| 自动对班（未排班按打卡匹配，admin 核对） | P0 | ✅ A0 preview→A1 apply→A2 灰度自动写 | #2403/#2405/#2406 · A2 #2461–#2471 |
| 未排班提醒 | P0 | ✅ ⑤（`AttendanceScheduler` 第二 job） | #2294 |
| 考勤组打卡策略（外勤/外勤审批/未排班可打卡/内外勤合并） | P0 | ✅ 打卡策略组 S1/S2/S3 | #2209 · S3 #2308 · S2 #2329–#2344 |
| 子管理员范围 / 考勤管理员工作台 | P1 | ✅ scheduler-scope 工作台 + enforcement | #2099–#2103 · #2134–#2175 |
| 草稿 / 发布 / 审批后发布 | P1 | ✅ publish/draft 生命周期 | P0–P4 |
| 外勤需审批 | P1 | ✅ S3 外勤审批 | #2308/#2322 |
| 调度 / 换班 | P2 | ✅ 调度 D1–D5 + 换班 SW1–SW5 + 小组织 SO0–SO3 | dispatch/swap/small-org 全 staging-proven |
| 假期余额 过期/延期 + 批量 | P2 | 🟡 **仅 comp_time 有 ledger（C4）；其它 leave type 仍无** | → 幸存候选 #1 |
| 待审批假期可视化 | P2 | ⬜ **未落**（grep 0） | → 幸存候选 #4 |
| 团队可用性日历 | P2 | ⬜ **未落**（grep 0） | → 幸存候选 #4 |
| 团队统计通知 + **员工端一键入口** | P1 | 🟡 C5 外发已落；**统一员工自助入口仍缺** | → 幸存候选 #2 |
| 报表质量（分级迟到阈值/出勤口径/公式函数） | 🟡 | ⬜ **未落**（severe_late 仍 meta 透传） | → 幸存候选 #5 |
| 人脸/考勤机/越狱/AI 算薪 | P3 | 🚫 OUT 不变 | §4 |

**结论**：base §5 里 owner 当初排的 P0/P1 几乎全做完，P2 的调度/换班也做完。**真正幸存的是少数 P2 + 报表质量 + base 未单列但手册有的几项**（补卡强约束、弹性打卡、销假、夜班深化）。

---

## 2. 幸存候选梯子（代码实证 + 重排）

> 价值 = 真实客户运营体感；成本 = 粗估人天/周（对齐已闭环链：一条 OT-3seg/multi-shift 链 ≈ 1–1.5 周）；**extend** = 复用已有资产，**build** = greenfield；**并行泳道**见 §3。

### 档 A — 高价值 · 复用已建基座 · 可独立并行（首选）

| # | 方向 | 现状 / extend-vs-build（代码证据） | 价值 | 粗估 | 泳道 |
|---|---|---|---|---|---|
| **1** | **法定/年假额度引擎**（年假按工龄发放 · 跨年结转 · 过期 · 余额可视） | `年假` 仅 leave-type 标签（grep 1）；**comp_time ledger（`attendance_leave_balances`+events）+ ④C4 `AttendanceScheduler` expiry 已建** → 把 lot/事件/过期推广到 statutory/annual 类型 = **extend** | 🟢 高（几乎每家有年假） | ~2–3 周 | **独立**（自有 config/accrual job/ledger 复用；不动核心 resolver） |

### 档 B — 实打实价值 · 多为 extend · 可并行

| # | 方向 | 现状 / extend-vs-build | 价值 | 粗估 | 泳道 |
|---|---|---|---|---|---|
| **2** | **员工自助工作台**（请假/加班/补卡/外出/调休/换班/调度 统一一键入口 + 我的余额/审批进度） | **非 greenfield**：`apps/web` 已有 self-service overview（`attendance__grid--selfservice` + 「我的状态」卡）+ `AttendanceRequestCenterSection.vue`（申请中心）+ `AttendanceOverview/ExperienceView`；后端 request 类型已富（5+ 类 + swap/dispatch）。gap = **统一/补全**（一键各类申请 + 余额可视 + 状态进度集中），非从零建 = **extend**。⚑ design-lock 前先**盘点现有 `apps/web` 员工端入口 + API surface**，勿当 greenfield | 🟢 高（C 端体感最直接） | ~1–1.5 周 | **独立**（前端为主，复用既有 API） |
| **3** | **通知渠道扩展**（邮件 / 短信 / 企业微信，超出 C5 v1 仅钉钉） | C5 worker **已有 `AttendanceDeliveryChannel { send(message) }` adapter seam + 可注入 `channels[]`** → 每渠道 = 一个 adapter 实现 = **extend** | 🟡 中（可靠性/覆盖面） | ~1 周/渠道 | **独立**（adapter，不动 producer/scheduler） |
| **4** | **补卡自助 + 规则强约束**（专用补卡申请 → 审批 → 写补卡 event；次数/时限/类型限制，对标手册 141） | 现状 `补卡`→generic `adjusted`（grep 6，仅报表指标+映射，无结构化流/约束/专表）；可仿 S3 外勤审批 pattern = **build-on-pattern** | 🟡 中（员工高频缺卡） | ~2–2.5 周 | **半独立**（动 `/punch`+requests，与打卡策略组轻度共线） |

### 档 C — 质量/深度 · 动核心或横切 · 谨慎串行

| # | 方向 | 现状 / extend-vs-build | 价值 | 粗估 | 泳道 |
|---|---|---|---|---|---|
| **5** | **报表分级口径一等化**（严重迟到/旷工迟到阈值升为可配规则+自算+落库+真过线 round-trip；出勤口径「自由工时/未排班不计」可配；公式补 TEXT/FILTER/REGEX/高阶数组） | `severe_late_*`/`absence_late_*` 仍 `summary.*` meta 透传（grep 15，base §4 finding 持续成立）= **build（且踩 computed-only/wire-vs-fixture 雷区）** | 🟡 中（报表可信度=护城河） | ~1.5–2 周 | **串行**（共享报表算 + meta 透传雷区） |
| **6** | **待审批假期可视化 + 团队可用性日历**（pending 层叠 effective-calendar；团队视图聚合） | grep 0；effective-calendar resolver 已在可叠加，但**它是热核 resolver** | 🟡 中（排班/请假协同） | ~1.5–2.5 周 | **串行**（动 effective-calendar 核心） |
| **7** | **销假 / 假期冲销**（撤销已批假期 + 余额反冲） | grep 0；④ 设计明确「撤销首版不自动反冲但不静默错账」→ 这是预留的再入点，复用 ledger 反向事件 = **extend** | 🟡 中（假勤生命周期完整性） | ~1.5–2 周 | **半独立**（动 ledger + 审批撤销） |

### 档 D — 最重 / 各自成 arc

| # | 方向 | 现状 / extend-vs-build | 价值 | 粗估 | 泳道 |
|---|---|---|---|---|---|
| **8** | **夜班/跨午夜深化**（跨天加班口径 + records 跨午夜归属 + 多 slot 夜班） | 班次级 overnight 已支持（`isOvernight`/`inferOvernightFlag`/`resolveShiftTiming`，grep 46）；但**跨午夜加班硬拒**（`OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED`）+ records 一日一行 + multi-slot 夜班未做 = **build（动核心 resolver + records 模型）** | 🟢 高（三班倒/制造/医疗刚需） | ~3–5 周 | **串行**（最热核：resolver + records 模型 + OT 引擎） |

### 收尾（非 arc）

| 项 | 现状 | 备注 |
|---|---|---|
| **§4 H1 scheduler-scope 收尾** | ~3–7 人天，owner 当初判 **YAGNI 缓做** | scoped-actor 真实 UX smoke · dept/role picker（角色无可枚举源、性价比低）· async-import 开给 scoped actor。唯一「字面还剩」的既有量，但非对标 arc，客户提才做。 |

---

## 3. 并行性分析（直接回应 owner 的「能否并行」）

**结论**：能——而且并行**本就是这条线已验证的工作模式**（worktree 几十个；换班/小组织/调度是几条独立链并行 Codex session 同时出的）。缺的不是并行产能，是**切好片的目标**。

**硬约束（决定哪些能并行）**：单文件 `plugins/plugin-attendance/index.cjs`（37.4k 行）+ 热表 migration + 撞车史（T4 pickers、enforcement 撞两次、S2-1 差点重复做）。规律：

- **feature/merge 级可并行**（靠 worktree + rebase/baseline-first 纪律，**非零文件撞车**——换班/小组织/调度正是这样并行 `index.cjs` 出来的）：
  - **#1 年假额度引擎**（自有 ledger 复用 + accrual job + config）— **编辑 `index.cjs`（与 `deductCompTimeBalance` 同文件），带 rebase 摩擦**
  - **#2 员工自助工作台**（前端为主，复用既有 API）— 主要在 Vue 层，与 plugin 错面
  - **#3 通知渠道扩展**（C5 worker 的 `AttendanceDeliveryChannel` adapter seam）— **唯一文件级真正不相交**（独立 `AttendanceNotificationDeliveryWorker.ts`）
  - **#4 补卡**（半独立，动 `/punch`+requests + `index.cjs`，与打卡策略组轻度共线 → 与 #1/#2/#3 仍可 merge 级并行，避免与未来打卡策略 slice 同窗）
- **必须串行 / 单 arc 推**（动 effective-calendar 核心 resolver、`attendance_records` 一日一行、或共享报表算）：**#5 报表分级**、**#6 pending/team overlay**、**#8 夜班深化**。**#7 销假** 动 ledger（与 #1 同表 → 与 #1 错开或同链）。

**执行波次（owner 2026-06-14 拍板）**：
- **第一波（并行 3 链）**：`#1 年假/法定假余额引擎`（下一主线）∥ `#2 员工自助工作台`（前端为主）∥ `#3 先接一个通知渠道`（如 email，每渠道独立 PR）。三者 **feature/merge 面独立**（非文件面全不相交：#1 仍动 `index.cjs`、需 rebase 纪律；#3 独立 worker 文件；#2 主在前端），三 worktree 同时推；各自 design-lock → staging smoke → 回填。
- **第二波（串行）**：`#4 补卡自助` → `#5 报表分级语义一等化` → `#6 待审批假期 + 团队可用性日历`（动 effective-calendar / 报表共享算，彼此不硬撞）。`#7 销假/余额冲正` 与 #1 同 ledger，随 #1 家族排期。
- **最后**：`#8 夜班/跨天深水区`（最重，单 arc，碰排班/打卡归属日/summary/合规/加班多轴）。

**并行护栏（沿用治理）**：每链开工前 `git fetch origin main && git log origin/main` 查重 + grep 特征 symbol；worktree 隔离；每项独立 opt-in；MUST 口径 = 运行时强制 + 反向测试 + staging 联调。

---

## 4. 红线 / 非目标（不变）

🚫 **不自研**（§1 OUT + §6 H3-3b）：算薪引擎（→对接 SaaS）· 防作弊/越狱（→原生 app）· 人脸/AI 拍照异常（→视觉/硬件）· 7 种打卡方式**采集层** / 考勤机 / WiFi / 地理围栏硬件（→原生/硬件）· 原生 app push · 插件市场 · 多时区报表（除非海外客户）· 对外公开 API。

> 这些是**故意的非目标**，不计入「剩余开发量」，别让它们虚增数字。

---

## 5. 治理 / 下一步

> ⚠️ **触发门（沿用 base §6）**：本梯子是「菜单」（必要），但开工的**充分条件是一个点名的客户拉动或 GATE 触发**——**不基于「对标焦虑」单方面开 RFC**。排名 ≠ 绿灯：列在 #1 不等于该开 #1，只等于「客户真要排班合规之外的能力时，#1 性价比最高」。

1. **本文 = 决策参照，非 backlog**。owner 从 §2 梯子选下一条 arc（或首波 3 链）。
2. 选定项 → 各自 **design-lock**（含一轮代码层可行性复核：本文 ⚑ 类候选的生产点须在 design-lock 前追清，如 #5 的 `summary.severeLateMinutes` 生产点、#1 的 accrual/结转口径、#8 的 records 跨午夜归属）。
3. 锁成新的 **§0.4「下一阶段目标」块** 写入执行账本（In scope / Out / 预算 / 完成口径，沿用 §0.1/0.2/0.3 格式）。
4. 按 §3 泳道并行 fan-out；每链 staging-proven 后回填 ✅。
5. **不自动开工**（staged-opt-in；这条纪律之前被烧过）。

---

## 6. 证据附录（grep @ `origin/main:plugins/plugin-attendance/index.cjs`，37,449 行）

| 探针 | 命中 | 判读 |
|---|---|---|
| `isOvernight`/`inferOvernightFlag`/`resolveShiftTiming` | 46 | 班次级 overnight ✅；跨午夜**加班**硬拒 → #8 gap |
| `年假` / accrual / 结转 / quota | 1（仅标签） | 年假无额度引擎 → #1 gap（可复用 comp_time ledger） |
| `attendance_leave_balances` / `leave_type_code` | 22 | ledger 仅 comp_time 用 → #1 extend 点 |
| `补卡` / makeup / missed-punch | 6（报表指标 + `'补卡'→'adjusted'`） | 无结构化补卡流/约束 → #4 gap |
| `销假`/cancel-leave/revoke-leave | 0 | 无销假/反冲 → #7 gap |
| `elasticPunch`/`flexiblePunch`/`弹性打卡`/`flexBand`（plugin + `apps/web`） | 0 | 无弹性打卡 band（attendance-scoped 符号实测 0，非泛 `flex` 误命中 CSS-flex/Elasticsearch；手册 141 有；本文并入 #4/#8 邻域，未单列） |
| pending-leave / 待审批 overlay | 0 | 无 pending 假期叠加 → #6 gap |
| team-availability / 团队日历 | 0 | 无团队可用性日历 → #6 gap |
| self-service（`apps/web` 侧，非仅 plugin） | overview + 申请中心 section 已在 | **非 plugin-grep-zero**：`AttendanceRequestCenterSection.vue` + `attendance__*--selfservice` 卡 + `AttendanceOverview/ExperienceView` 已在；gap = 统一/补全入口，非 greenfield → #2（design-lock 前盘点 `apps/web` 入口 + API surface） |
| `severe_late_*` / `absence_late_*` | 15（`summary.*` 透传） | 分级阈值非一等可配 → #5 gap（base §4 finding 持续） |
| `AttendanceDeliveryChannel`（C5 worker） | interface + `channels[]` 注入 | 渠道 adapter seam 已在 → #3 低成本 extend |

**诚实声明**：本审计从沙箱实测代码符号 + committed 文档 + PR 状态（无法触达 staging）。粗估人天为「对齐已闭环链」的数量级判断，非承诺；各项真实可行性以其 design-lock 的代码层复核为准。内容版权：阿里巴巴（中国）有限公司；仅供 metasheet2 内部产品决策参照。
