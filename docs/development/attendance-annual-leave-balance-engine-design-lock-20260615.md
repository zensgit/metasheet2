# 年假 / 法定假余额引擎 — 设计锁（design-lock）

> **状态**：design-lock（owner 决策 2026-06-15 锁定）；**实现 L0–L5c 已全部 BUILT + MERGED 落 `origin/main`**（L0 #2627 · L1 #2633 · L2 #2638/#2678/#2687 · L3 #2713 · L4 #2717/#2718 · L5a/b/c #2779/#2782/#2830，L0–L4 capstone #2753）；**L6 staging smoke 已 PASS（2026-06-21，stamp `annual-l6-mqnv0lnv-f47084`，runtime image `49050b82739f84bef20493f98f3f863fba642611`，residue=0）**。子链「各自独立 opt-in」纪律保留为历史。
> **口径**：本文写 MetaSheet 自有设计口径；默认法定阶梯 preset 校准自**《职工带薪年休假条例》+《企业职工带薪年休假实施办法》**（法规来源，非竞品对标）。不引用任何竞品产品。
> **基线**：代码实测 @ `origin/main`（plugin `index.cjs` 37.4k 行 + `packages/core-backend/src/services/AttendanceExpiryService.ts`/`AttendanceScheduler.ts`）。
> **谱系**：复用 ④ 加班调休假期闭环建成的 leave-balance ledger（#2231）+ FIFO 扣减（#2261/C3）+ leader-elected `AttendanceScheduler` 过期基座（#2270/#2274/C4）。**这是该梯子的"下一主线"**（refresh 审计 v2 #2617 §2 档 A #1）。
> **触发**：客户拉动 / GATE，已 owner opt-in（2026-06-15）；后续每个 slice 仍单独 opt-in（§6）。

---

## 0. 一句话 + 关键 reframe

年假余额引擎 = 给"配额型假期"（v1 = 法定/公司年假）建 **发放（accrual）→ 扣减（deduct）→ 结转/过期（carryover/expiry）→ 可审计（provenance）** 的闭环。

**关键 reframe（整个设计的承重点）**：年假**不是** comp_time 的"事件→固定额→`ON CONFLICT DO NOTHING` 幂等入账"。年假额度是 **computed entitlement = f(累计工龄, 日历位置)**，会在年中变（首年折算 + 工龄跨 1/10/20 年界）。一条 `annual_accrual:{user}:{year}` 幂等 grant 对"当年跨界"的人是错的、且幂等插入补不上。因此 v1 取 **snapshot 口径 + accrual-run 可审计快照 + manual adjustment 纠偏出口**，而非照搬事件入账。

---

## 1. 复用 vs 泛化 vs 新建（代码实证的设计论点）

**复用（零 ledger DDL）** — `attendance_leave_balances` + `attendance_leave_balance_events`（#2231）**已是 `leave_type_code`-generic**：lot 表有 `leave_type_code` 列，CHECK（amount>0 / 0≤remaining≤amount / status 枚举）、`UNIQUE(org_id, source_key)` 幂等索引、events `±` 审计（grant/deduct/expire/revoke + 符号 CHECK）对任意假型都成立。年假 = 新 lot 行 `leave_type_code='annual'`，**ledger 本身不动 schema**。FIFO 扣减序 `expires_at ASC NULLS LAST, granted_at ASC` 对年假正合适（结转/将过期 lot 先扣）。

**泛化（3 个 comp_time-specific 触点）** —
1. **扣减**：`deductCompTimeBalance`（现 `WHERE leave_type_code='comp_time'`、扣 `metadata.minutes`、抛 `COMP_TIME_BALANCE_INSUFFICIENT`、写 `'comp_time_leave'`）→ 抽成参数化 `deductLeaveBalance(trx, { leaveTypeCode, deductionBasis, sourceType, insufficientCode, ... })`。
2. **过期 event 标签**：`AttendanceExpiryService` 的 scan **已通用**（`WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=now()`，无假型过滤——已能过期任意 aged lot），但 expire event 写死 `source_type='comp_time_expiry'` → 泛化为按 lot 的 `leave_type_code` 派生（comp_time 不变，annual 用 `annual_leave_expiry`）。
3. **过期触发**：复用 `AttendanceScheduler` 现有 expiry job（leader-elected / env-gated），无需第二调度器。

**新建** — accrual 配置 + **accrual snapshot 引擎** + **accrual-run provenance 结构**（[P2]）+ manual adjustment + 天↔分钟换算 + （cumulative_service 模式下的）累计工龄起算字段。

---

## 2. owner 决策锁（2026-06-15）

### 2.1 入账口径 = snapshot v1（+ manual adjustment v1 必备 + accrual-run provenance）
accrual-run 当时按"工龄起算日 + 日历位置"快照一次额度写 grant lot；接受"工龄跨界当年略 stale"。**manual admin 调整是 v1 必备**（不是后续 slice）——它是 snapshot 偏差的唯一纠偏出口。reconcile（对账式 adjustment 事件链）**v1 不做**，文档明写此 limitation。

### 2.2 发放锚点 = 自然年（eligibility gate 先于折算）
1/1 发放。**先过 eligibility gate（[P1] 修正——eligibility ≠ proration）**：连续工作满 12 个月才享受年休假（条例第二条 / 实施办法第三条）——`service < 12 个月` → **skip `NOT_ELIGIBLE_UNDER_ONE_YEAR`，既不发也不折算**。**首年折算只适用于"已满足 12 个月 eligibility 的新进员工"**（实施办法第五条）：`entitlement = (本单位当年剩余日历天数 ÷ 365) × 阶梯天数`，**折算后不足 1 整天不享受**。入职周年制 v1 不做。
> 注：eligibility（连续满 12 个月）与 tier（累计工作时间）是两个独立判定。v1 eligibility 以配置的 service-start 字段 elapsed ≥ 12 个月判（cumulative 模式用 `cumulativeServiceStartDate`、company 模式用 `hire_date`）；"连续 vs 累计"的法定细分作为 documented 简化，必要时 L2 再细化。

### 2.3 工龄阶梯 + 口径
- **默认 preset（法定，可配）**：阶梯按**累计工作时间**（条例第三条 / 实施办法第四条）：累计满 1–10 年 = **5 天**；满 10–20 年 = **10 天**；满 20 年以上 = **15 天**。org 可改阶梯。**"不满 1 年"不落进阶梯——由 §2.2 的 eligibility gate 处理，不是"按比例进阶梯"**（owner 已对《职工带薪年休假条例》《企业职工带薪年休假实施办法》校准）。
- **工龄口径（[P1]，承重）**：默认 `tenureMode='cumulative_service'`（法律口径 = 累计工作时间，含同一/不同用人单位）。**`hire_date` 只代表本单位入职日，不足以算法定累计工龄** → `cumulative_service` 模式必须用**独立字段** `cumulativeServiceStartDate`（亦名 `annualLeaveServiceStartDate`）；该字段缺失 → **skip + 可见原因**（绝不用 hire_date 顶替、绝不静默发错额度）。
- org 可选 `tenureMode='company_tenure'`，**此时才用 `hire_date`** 算本单位工龄。

### 2.4 单位 + 扣减口径（刀刃在扣减）
ledger 继续存 minutes（不动 ledger DDL）。1 年假"天" = 可配 `standardDayMinutes`（默认 **480**），半天 = **240**。**请年假扣"标准天分钟"（天数 × standardDayMinutes），与当天实际排班时长无关**。`deductLeaveBalance` 参数化 `deductionBasis ∈ {'standard_day','actual_minutes'}`：annual → `standard_day`，comp_time → `actual_minutes`（保持现状）。即扣减抽象参数化的是**额度语义**，不只是 `leave_type_code`。

### 2.5 结转 + 过期（[P2] 时区显式）
- **可配，默认结转到次年末**。过期复用 C4 scheduler。
- **结转/过期边界是"日历年末"，不是 C4 的 `granted_at + N×24h`** → 用 **org 时区的年末时间戳**（如 `次年 local 12-31 23:59:59.999`）。时区来源 = `annualLeavePolicy.timezone`，默认继承 attendance default rule / org timezone。**[P2] 拍死一个行为（不二选一）**：`enabled=true` 必须能解析 timezone；解析不到 → 配置/启用路径返回 `422 ANNUAL_LEAVE_TIMEZONE_REQUIRED`，accrual-run 路径 **skip 该 org + 可见原因 `TIMEZONE_UNRESOLVED`**。**不做 UTC fallback。**
- expire event `source_type`：`comp_time_expiry` 不变，annual 用 `annual_leave_expiry`。
- **[P3] "默认结转到次年末"是 MetaSheet 产品默认，不是法定默认**：法规仅"允许确有必要时跨 1 个年度安排"（≠默认全量结转）；org 可配，含 use-it-or-lose-it = 当年末。

### 2.6 门 + 不足 + 范围
默认 **OFF**、org opt-in（同 comp_time）。余额不足 = **block approval**、**不预支 / 不负余额**（同 C3）。v1 单一可配 `'annual'` 类型（法定 + 公司补充折成一个可配总额）；其它配额假（病假配额等）后续 generalize，不进 v1。

---

## 3. accrual-run provenance 结构（[P2] 新建）

现 ledger **无 metadata JSON 列** → 只写 `source_key + 分钟数` 会丢"当时用了哪个工龄/阶梯/折算/时区/policy 版本"的证据。锁一个轻量 run/provenance：

- **`attendance_leave_accrual_runs`**（run 头）：`id`、`org_id`、`period_key`（如 `annual:2026`）、`policy_version`、`tenure_mode`、`timezone`、`standard_day_minutes`、`tiers` 快照、`triggered_by`（scheduler/manual）、`occurred_at`。
- **`attendance_leave_accrual_run_items`**（per-user）：**`id`（uuid PK）**、`run_id`、`user_id`、`leave_type_code`、`tenure_years`、`tier_days`、`proration_factor`、`entitlement_minutes`、`status`（granted / skipped）、`skip_reason`（如 `MISSING_SERVICE_START_DATE` / `NOT_ELIGIBLE_UNDER_ONE_YEAR` / `TIMEZONE_UNRESOLVED`）。**`UNIQUE(run_id, user_id, leave_type_code)`**。
- lot 的 `source_id` → **`run_item.id`**（[P2]：反链指向 run-item PK，不是模糊指向 run）；`source_type='annual_accrual'`、`source_key='annual_accrual:{user}:{period_key}'`。
- **manual adjustment 的余额模型（[P1] 修正——不能只写 event）**：events 是审计流水，**真正余额由 lot 表达**，故手工调整必须动 lot：**正向**调整 = 创建 `annual_manual_adjustment` lot（`source_type='annual_manual_adjust'`）+ 写 grant event；**负向**调整 = 按 FIFO（`expires_at ASC NULLS LAST, granted_at ASC`）扣 active annual lots + 写 deduct event(s)。两者都用稳定 `source_key='annual_manual_adjust:{adjustmentId}'`（幂等、可追溯），**绝不能只有 event**。调整引用对应 run，但**不覆盖** run-item 原始快照（纠偏 ≠ 抹证据）。

---

## 4. 数据模型 delta（最小 DDL，明确诚实）

- **不动** `attendance_leave_balances` / `_events`（已通用）。
- **新增**（DDL）：`attendance_leave_accrual_runs` + `_run_items`（§3 provenance）。
- **新增（仅 `cumulative_service` 模式需要）**：per-user `cumulativeServiceStartDate` 字段——`company_tenure` 模式复用 `hire_date`、**无需**新字段。该字段落 user/HR 列还是 HR 自定义属性，于 **L2 决定**（可能本引擎首个真 DDL 之一）。
- **配置（无 DDL）**：`annualLeavePolicy` 入 org settings JSON：`enabled`、`tenureMode`、`tiers[]`、`standardDayMinutes`、`accrualAnchor='calendar_year'`、`firstYearProration`、`carryover{ enabled, boundary }`、`timezone`。
- **schema 批**：accrual_runs 表 + service-start 字段与既有 attendance 热表 schema-batch 协调（见 benchmark tracker §schema-batch 规则），不一刀一迁。

---

## 5. 泛化触点细节（代码实证）

- **`deductLeaveBalance(trx, { orgId, userId, leaveTypeCode, amountMinutes, deductionBasis, sourceType, insufficientCode, sourceId })`** —— 从 `deductCompTimeBalance` 抽出；FIFO 序不变（`expires_at ASC NULLS LAST, granted_at ASC … FOR UPDATE`）；comp_time 路径调用时传 `deductionBasis='actual_minutes'` + `leaveTypeCode='comp_time'` + `insufficientCode='COMP_TIME_BALANCE_INSUFFICIENT'`，**行为逐字节不变**（§8 锁）。annual 传 `'standard_day'` + `'annual'` + `'ANNUAL_LEAVE_BALANCE_INSUFFICIENT'`。
- **过期**：`AttendanceExpiryService` 的 expire event `source_type` 改为按 lot `leave_type_code` 派生（`comp_time→comp_time_expiry`、`annual→annual_leave_expiry`）；scan 不动（已通用）。
- **accrual job**：`AttendanceScheduler` 新增年度 rollover job（env-gated，复用 composite job-list）+ admin 手动触发。幂等 = `source_key=annual_accrual:{user}:{period_key}` + `ON CONFLICT DO NOTHING`。**注意 snapshot limitation**：重跑（如工龄跨界后）因 source_key 去重 → **不 top-up**（已 documented）；纠偏走 manual adjustment。

---

## 6. 子链 L0–L6（owner-refined，各自独立 opt-in）

- **L0** — latent config（`annualLeavePolicy` 默认全关）+ 抽 `deductLeaveBalance`（**comp_time 行为不变**，先用 comp_time C3 真 DB 测试跑过泛化后 helper、断言逐字节不变）。
- **L1** — 泛化 expiry event `source_type`（按 leave_type 派生），**锁 comp_time 不回归**（重跑 C4 测试）。
- **L2** — annual accrual **snapshot 引擎** + **accrual-run provenance**（§3）+ **manual adjustment**；含 `cumulativeServiceStartDate` 字段决策 + missing-field skip 可见。
- **L3** — 年假审批扣减接线（final approval gated `leaveType.code==='annual'` → `deductLeaveBalance(..., 'standard_day')`）。
- **L4** — 结转 / 年末过期（accrual 写 org-tz 年末 `expires_at`；过期由 L1 泛化后的 scheduler 处理）。
- **L5** — admin UI：余额视图、policy 配置、手工调整、skip reasons。
- **L6** — staging smoke（端到端 + residue=0）。

---

## 7. 完成口径（MUST bar，每 slice 真 DB 反向测试 + 末端 staging）

1. **幂等**：重跑 accrual → 同 period 同 user grant 一次（source_key 兜底）。
2. **eligibility + 工龄正确性**：`连续 < 12 个月` → `NOT_ELIGIBLE_UNDER_ONE_YEAR` skip（不发不折算）；满足 eligibility 的新进员工首年折算正确（不足 1 整天不享受）；阶梯跨 1/10/20 年界正确（按累计工作时间）；**缺累计工龄起算字段 → `MISSING_SERVICE_START_DATE` skip + 可见原因**（不顶替 hire_date、不静默发错）。
3. **snapshot limitation 显式 + 手工调整动 lot**：文档写明 limitation + manual adjustment 走 **lot mutation**（正向新 lot / 负向 FIFO 扣，非 event-only）且留独立证据。
4. **扣减**：`standard_day` 基准、不足 block、**comp_time 路径不受影响**。
5. **结转/过期 + 时区**：org 时区年末边界、`annual_leave_expiry` event、重复 tick 不重复；**timezone 解析不到 → `422 ANNUAL_LEAVE_TIMEZONE_REQUIRED` 或 accrual-run `TIMEZONE_UNRESOLVED` skip，无 UTC fallback**。
6. **provenance**：每个 annual lot 可追到一条 run（含工龄/阶梯/折算/时区/policy 版本输入）。

---

## 8. 测试锁（热路径，承重）

- **`deductLeaveBalance` 抽取 = 热路径重构、非免费**：抽完先用 comp_time **C3 真 DB 集成测试**跑过泛化后 helper、断言 comp_time 行为逐字节不变，年假再骑上去（L0 门）。
- **expiry 泛化**：`comp_time_expiry` event 逐字节不变（重跑 C4 测试，L1 门）。
- **accrual**：幂等 + snapshot-staleness（跨界重跑不 top-up，符合预期）+ missing-service-field-skip，均真 DB（L2 门）。

---

## 9. 红线 / out

reconcile 对账式 v1 不做 · 预支/负余额不做 · 其它配额假（病假配额等）v1 不做 · payroll 回写不做 · 不引用任何竞品产品命名 · 不把公式派生当 runtime truth。

---

## 参考

- **法规来源（默认 preset 依据，[P3] 官方全文 URL）**：《职工带薪年休假条例》（国务院令第514号；第二条 eligibility=连续工作满 1 年、第三条 tier=累计工作时间 5/10/15 天）https://www.gov.cn/flfg/2007-12/16/content_835527.htm ·《企业职工带薪年休假实施办法》（人社部令第1号；第五条 新进员工按本单位剩余日历天数折算、不足 1 整天不享受）https://www.gov.cn/flfg/2008-09/28/content_1108445.htm
- **复用代码（origin/main）**：`attendance_leave_balances`/`_events` DDL（migration `zzzz20260603120000_create_attendance_leave_balances`，#2231）· `deductCompTimeBalance`（#2261/C3）· `AttendanceExpiryService` + `AttendanceScheduler`（#2270/#2274/C4）。
- **谱系账本**：refresh 审计 v2 `docs/research/dingtalk-attendance-benchmark-refresh-v2-20260614.md`（#2617，档 A #1）· 执行账本 `docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`（落地后此处加 §0.4 目标块）。
