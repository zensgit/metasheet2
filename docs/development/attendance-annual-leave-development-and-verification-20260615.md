# 年假 / 法定假余额引擎 — 开发与验证报告（L0–L6）

> **日期** 2026-06-15 · **范围** 考勤 年假/法定假 accrual 引擎（design-lock #2622，执行账本 §0.4）
> **状态** L0 / L1 / L2a **已合并并验证**；**L2b 卡在一个 `asOf` 法定口径 拍板**；L2c–L6 已规划（每刀独立 opt-in）。
> **口径** 本文写 MetaSheet 自有设计 + 法定校准（《条例》《实施办法》），不引用竞品。法定公式经 gov.cn 原文核对。
> **执行模式** connected-run A + ultracode 工作流：Claude 驱动 build+verify，owner 握真岔口（asOf 等）+ 合并 + staging。
> **验证来源** 一条多智能体工作流（`wf_93a750ff`，5 lens→synthesize→plan+adversarial）；7/8 agent 被服务端临时限流，**存活的 plan agent 自行 grounding 完成了法定核对 + asOf 证明 + 全程规划**；叠加 advisor 的 asOf 对抗分析 + 主线代码 grounding。

---

## 0. 一句话

把"配额型假期"（v1=法定/公司年假）建成 **发放(accrual)→扣减(deduct)→结转/过期→可审计(provenance)** 的闭环，复用 ④ comp-time 闭环已建的 ledger + 扣减 helper + 过期 scheduler。**年假 = computed entitlement（非幂等事件入账）→ snapshot accrual + accrual-run provenance + manual adjustment。**

---

## 1. 已完成并验证（L0 / L1 / L2a — 全部 MERGED）

| 刀 | PR / squash | 内容 | 锁定验证 |
|---|---|---|---|
| **L0** | #2627 `3fbabc9a4` | 抽 `deductCompTimeBalance`→泛型 `deductLeaveBalance`（comp_time 变薄包装）+ latent `annualLeavePolicy` 配置 | **comp_time 逐字节不变**（④C3 真 DB 测试 verbatim 通过）+ annualLeavePolicy round-trip + **2×P2 修复**：enabled 必须有 timezone→422 `ANNUAL_LEAVE_TIMEZONE_REQUIRED`、tiers ladder 连续性校验→坏 ladder 回退 preset |
| **L1** | #2633 `8bd46364a` | `AttendanceExpiryService` expire-event `source_type` → in-SQL `CASE leave_type_code`（comp_time_expiry / annual_leave_expiry / `{type}_expiry`） | **保持 #2267 单语句原子性**；④C4-1 测试 verbatim 通过（comp_time 不回归）+ 新派生测试 annual/comp_time/sick |
| **L2a** | #2638 `c02b28814` | latent provenance schema：`users.cumulative_service_start_date` + `attendance_leave_accrual_runs` + `_run_items`（id PK + UNIQUE + FK + CHECKs） | **fresh-DB 全量 migrate + replay-idempotent** + 真 DB invariant 测试：每个 CHECK/UNIQUE/FK 实际触发（23514/23505/23503）+ users 列存在 |

**复用资产（L2b–L4 直接骑）**：ledger `attendance_leave_balances`/`_events`（已 leave_type 泛型，零 ledger DDL）· C2 grant pattern（`index.cjs:24902` ON CONFLICT DO NOTHING RETURNING id→grant event）· `deductLeaveBalance`（`index.cjs:15339`）· `AttendanceExpiryService` + 过期 scheduler · L0 `annualLeavePolicy` 配置 + timezone PUT 守卫 · L2a provenance 表。

---

## 2. 法定口径验证（statutory calibration — gov.cn 原文核对）

| 维度 | 法定规则 | 来源 |
|---|---|---|
| **eligibility** | 连续工作满 12 个月才享受年休假 | 《条例》第二条 / 《实施办法》第三条 |
| **tier（阶梯）** | 按**累计工作时间**：满 1–10 年=5 天；10–20 年=10 天；≥20 年=15 天 | 《条例》第三条 / 《实施办法》第四条 |
| **首年折算** | `(当年度在本单位剩余日历天数 ÷ 365) × 全年应享天数`，**折算后不足 1 整天不享受** | 《实施办法》第五条 |
| **除数** | **÷365**（法定字面值，非 365.25、非按年实际天数） | 《实施办法》第五条 |

**关键校准结论**：tier 按 **累计**、折算按 **本单位（hire_date）**——这两个日期口径在 cumulative 模式下**都要用**。折算只对"当年新进本单位"的人触发。

---

## 3. 验证发现 + 待拍板 forks

### 3.1 ✅ [已拍 2026-06-15] period + asOf 模型（解锁 L2b）

design-lock §2.2 当初钉的 **reference date = Jan 1** 与 §5 折算**自相矛盾**：

- **Jan-1 下**：任何 Jan-1 在册的人都在上一日历年入职 → `剩余日历天数=365` → 折算系数恒 `1.0` → **§5 折算变死代码**。法定自带的"7-1 入职→2 天"例子（不是 5、不是 0）在 Jan-1 锚点下根本算不出来。
- **修正模型**：把单锚点拆成两个输入：
  - `period` —— **哪一年的额度**（如 2026），驱动 `period_key='annual:2026'`。
  - `asOf` —— **评估日**（默认=run/today，org 时区）。eligibility 与 tier **as-of asOf** 判。
  - **折算当且仅当 `hire_date ∈ [period 年 1-1, period 年 12-31]`**（当年新进本单位）；分子=hire_date→当年末的剩余日历天数；否则系数=1.0。
- **验算（含 eligibility 前提，[P2 owner 修正]）**：用户**已满足 eligibility（连续工作满12个月，靠累计工龄）**，但**本单位** `hire_date=2026-07-01`、tier=5 天 → 本单位当年剩余 `184/365×5 = 2.52 → floor 2 天`。⚠️ **若该用户无 prior service、连续<12mo，则先 skip `NOT_ELIGIBLE_UNDER_ONE_YEAR`，不折算**——eligibility 门**先于**折算，**绝不能**写成"新入职当年直接折算发放"。

**✅ 已拍（2026-06-15）**：采纳 period+asOf 模型——`period` 定哪年额度与 `period_key`，`asOf` 定 eligibility/tier（默认 org-tz today），折算只看本单位 `hire_date` 是否在 period 年内。此模型**只局限 L2b 计算**（L2c–L6 只消费"granted lot"，不级联）。

> **[P2-1 asOf schema 落地，owner 拍板]**：L2a 的 `attendance_leave_accrual_runs` 目前**只有 `occurred_at`、无 `as_of`**。L2b **必须补一个小 migration 加 `as_of date NOT NULL`**（该表 latent 空表，加 NOT NULL 列安全），把"回溯跑 period=2026 + asOf=2026-07-01"与"实际执行时间 `occurred_at`"**分开存**，审计才干净。**不**把 asOf 塞进 occurred_at。

### 3.2 ✅ [已拍 2026-06-15] 手工调整登记 = 独立轻量登记表

正向调整=建 `annual_manual_adjustment` lot + grant event；负向=FIFO 扣 active annual lots + deduct event（复用 `deductLeaveBalance`）；稳定 `source_key='annual_manual_adjust:{adjustmentId}'`。**✅ 已拍：独立轻量登记表 `attendance_leave_manual_adjustments`**（`adjustmentId` / who / why / references-run / occurred_at）——snapshot 模型**必然靠手工纠偏兜底**，只靠 source_key/event 没有 who/why 的完整审计会把 v1 最重要的纠偏出口做薄；轻量 DDL 值得。该表是 L2c 的 DDL（与 L2b 的 `as_of` 列分属各自 slice）。

### 3.3 [L4 wiring choice] `expires_at` 在哪盖

`expires_at` = **org 时区日历年末时间戳**（非 C4 的 `granted_at+N×24h`——comp_time 固定时长模型对年假是错的）。建议**在 L2b grant 时就盖**（accrual INSERT 从 policy 算年末 expiry），L4 只负责结转边界策略 + 过期收割验证。

### 3.4 ⚠️ as-built 纠偏：`deductLeaveBalance` **无** `deductionBasis` 参数

design-lock §2.4/§5 文案说"参数化 `deductionBasis`"，但 **L0 实际落地的** `deductLeaveBalance`（`index.cjs:15339`）**没有该参数**——L0 把"额度语义"放在了**调用方**（注释 15338："caller owns amount semantics… 年假 L3 传 standard-day minutes"）。**按 as-built 走**：L3 调用方算 `requestedDays × standardDayMinutes` 传 `amountMinutes`，**不要**为追文案加 `deductionBasis`。§2.4 文案=文档漂移，非规格。

### 3.5 dry-run 不消耗 source_key（幂等推论，必须写进代码+测试）

`dry_run=true` 持久化 run + run_items（可检视的预览）但**不写 lot、不写 event** → **dry-run 不占 source_key** → 之后的真跑仍能发（无幻影幂等阻断）。

---

## 4. L2b 计算规格（implementation-ready）

**输入**：`period`（int 年）· `asOf`（date，默认 today，org tz）· `scope`（org/用户集）· `dryRun`（bool）。

**逐用户算法**：
1. 读 policy（L0 `annualLeavePolicy`）；`enabled=false` → 整 org 不跑。timezone 解析不到 → run skip + `TIMEZONE_UNRESOLVED`（配置/PUT 路径已 422）。
2. 取 tenure 锚点：`cumulative_service_start_date`（cumulative 模式）/ `hire_date`（company 模式）。缺 → skip `MISSING_SERVICE_START_DATE`（**绝不回退 hire_date** 顶替 cumulative）。
3. **eligibility**：`(asOf − service_start) ≥ 12 个月` → 否则 skip `NOT_ELIGIBLE_UNDER_ONE_YEAR`（不算折算）。
4. **tier**：`floor(累计 years as-of asOf)` → 匹配 ladder → `tier_days`。
5. **折算**（**仅对步骤 3 eligibility 已通过的用户**——ineligible 在步骤 3 已 skip，**绝不进折算**）：若 `hire_date ∈ period 年`（当年新进本单位）→ `entitlement_days = floor((当年末−hire_date 剩余日历天数 ÷ 365) × tier_days)`；否则 `= tier_days`。
6. `entitlement_days = 0`（折算不足 1 整天）→ skip `PRORATION_BELOW_ONE_DAY`（**不建 0-minute lot**，lot CHECK 要求 amount>0）。
7. `entitlement_minutes = entitlement_days × standardDayMinutes`。
8. 写 1 行 `run_items`（granted+entitlement / skipped+reason）。
9. **granted 且非 dry-run**：INSERT `leave_type_code='annual'` lot（`source_type='annual_accrual'`、`source_id=run_item.id`、`source_key='annual_accrual:{user}:{period_key}'`、`expires_at`=org-tz 年末 per §3.3、ON CONFLICT (org_id,source_key) DO NOTHING RETURNING id）→ 有新 id 才写 grant event（**镜像 C2**）。
10. 写 `runs` header 快照（tenure_mode/timezone/standard_day_minutes/tiers/policy_version + dry_run + **新列 `as_of`（与 `occurred_at` 分开：as_of=评估日，occurred_at=执行时间）**）。

**skip_reason 闭集**：`NOT_ELIGIBLE_UNDER_ONE_YEAR` · `MISSING_SERVICE_START_DATE` · `TIMEZONE_UNRESOLVED` · `PRORATION_BELOW_ONE_DAY`。

**幂等**：source_key + ON CONFLICT（run+run_items 每次都写=审计；lot 只发一次）。**snapshot staleness 是预期行为**（跨 tier 边界 re-run 不 top-up；纠偏走 L2c），测试名要写明"expected not bug"。

**触发**：admin `POST /api/attendance/annual-leave-accrual/run`（attendance-admin scope）+ dryRun 预览。scheduler 自动跑=后续 opt-in。

---

## 5. L2b → L6 执行计划（gated 路线图）

| 刀 | 类型 | 范围 | 待拍板 fork | 锁定测试（真 DB）| 推进门 |
|---|---|---|---|---|---|
| **L2b** | ⚙️ 可推进（fork 已拍） | accrual 引擎 + provenance + dry-run + admin endpoint + **小 migration 加 `as_of date NOT NULL` 列** | （asOf ✅ 已拍；DDL = as_of 列）| 幂等·eligibility-skip·missing-field-skip·**折算(eligibility-pass + 本单位 7-1→2天)**·tier-边界·<1天-skip·dry-run-no-lot·provenance-round-trip | 8 测试绿 + provenance 通 |
| **L2c** | ⚙️ 可推进（fork 已拍） | 手工调整（lot-mutation）+ **独立登记表 `attendance_leave_manual_adjustments`** | （✅ 独立轻量登记表）| 正/负调整·幂等·原始 run_item 快照不被覆盖 | 双向 lot-mutation 证实 + 快照非破坏 |
| **L3** | ⚙️ 机械 | 年假审批→`deductLeaveBalance(annual, standard_day minutes)` | 无（按 as-built §3.4）| standard-day 扣·不足 422 rollback·FIFO·**comp_time C3 不回归** | 三测绿 + comp_time 逐字节 |
| **L4** | ⚙️ 机械(tz) | 结转/年末过期（org-tz 边界，复用 L1 泛化过期）| 无（边界已定；wiring=grant 时盖 expiry）| 多 tz 年末边界·`annual_leave_expiry` event·tick 幂等·**comp_time_expiry 不回归** | 多 tz 正确 + 不回归 |
| **L5** | ⚙️ 机械 | admin UI：余额/policy 配置/手工调整/skip-reasons | 无 | wire-vs-fixture·PUT-422 surfaced·调整需 reason·dry-run 预览计数 | 四面板接真 endpoint + wire 测试 |
| **L6** | ⚙️ 机械 | staging smoke（端到端 residue=0）| 无 | 全链 + provenance + comp_time 不回归 + 幂等 + residue=0 | 全链绿 staging |

**关键路径**：两个 拍板（asOf、L2c 登记）**已于 2026-06-15 拿掉** → L2b / L2c 现可推进。L3–L6 都消费"granted lot"，与 asOf 无关。序列严格线性（逐门推进）。

---

## 6. 风险 / 开放问题（对抗视角）

- **日期算术**：闰年（÷365 是法定字面，闰年不变）· `asOf − service_start ≥ 12 个月` 的月/日边界 · 剩余日历天数含/不含 hire_date 当天（建议含 hire_date 当天，与"本单位剩余"一致）→ L2b 实现时用真 DB 测试钉死，advisor 复核日期边界。
- **org 用户枚举**：accrual 要遍历 org 用户——L2b grounding 需确认有无现成 helper（code-reuse lens 被限流未完成，**L2b 开工前补这一步 grounding**）。
- **policy_version**：run header 要存——建议=policy 关键字段的稳定 hash（enabled/tenureMode/tiers/standardDayMinutes/timezone/carryover），实现时定。
- **半天**：`standardDayMinutes` 半天=240（L3 扣减口径），年假折算以"整天"为单位（§5），半天只在请假扣减侧出现。
- **限流补验**：本次工作流 7/8 agent 限流；plan agent 已自洽完成法定+asOf+规划，但 dedicated 的 statutory/edge/idempotency/code-reuse lens 未跑完——**L2b 开工前可补一轮窄 grounding（org-用户枚举 + 日期边界对抗）**，不阻断本报告。

---

## 7. 下一步

1. **§3.1 period+asOf ✅ 已拍 + §3.2 L2c 独立登记表 ✅ 已拍**（2026-06-15，owner）——L2b 解锁；L2b DDL 含 `as_of` 列（[P2-1]）。
2. 拍完我写 **L2b**（按 §4 规格，连跑 A：我 build+真 DB 测试到成品 PR，你审/合）；L2b 开工前补 org-用户枚举 + 日期边界 grounding。
3. 之后 L2c→L6 按 §5 推进；L3–L6 多为机械刀，遇 §3.2/§3.3 的局部 fork 我停下来问。

---

## 参考

- **法规**：《职工带薪年休假条例》（国务院令514号）https://www.gov.cn/flfg/2007-12/16/content_835527.htm · 《企业职工带薪年休假实施办法》（人社部令1号）https://www.gov.cn/flfg/2008-09/28/content_1108445.htm
- **design-lock**：`docs/development/attendance-annual-leave-balance-engine-design-lock-20260615.md`（#2622）
- **代码 file:line**（worktree `/private/tmp/ms2-annual-l2b`）：`deductLeaveBalance` `index.cjs:15339`（无 deductionBasis，调用方算分钟）· C2 grant `index.cjs:24902` · C3 deduct 调用点 `index.cjs:24926` · L2a 迁移 `migrations/zzzz20260615170000_add_annual_leave_accrual_schema.ts`
- **已合并**：L0 #2627 · L1 #2633 · L2a #2638
