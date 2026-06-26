# 加班调休抵扣与周期结算（加班银行）— 设计与验证记录

> **范围**：把"加班入池 → 请假优先抵扣 → 周期末折算"做成**企业可配置**的薪资/考勤结算规则组。本文是该线的**设计 + 验证**真源；设计锁见 `attendance-overtime-bank-settlement-designlock-20260624.md`（RATIFIED）。
> **状态（2026-06-26 refresh）**：**账1 入池 + 账2 抵扣 + 账3 满勤 + 配置 UI + 账4 周期结算（v1-5 snapshot-at-close）全部落 main** —— **加班银行四账模型 + 结算机制完整闭环**。**v1-5 settlement 线 = design-lock #3206 → 表 #3211 → 纯计算 #3228 → 写路径+冻结守卫 #3233 → must-pay e2e #3255（全 merged，逐刀 owner review，约 13 个 money-path/会计 finding pre-merge 闭环）**：cycle→`closed` 同事务快照（三入口 update/create/generate 都不绕过 §3），§8a population = 期间 facts ∪ active comp_time 余额（不漏离职带余额），must-pay 从 **period OT facts**（statutory 永付 + 非 pooledSources 来源；**不从 balance lot 推导**，poison-lot 已证且 #3255 已经 OT-segmentation harness 端到端验证）、convertible 从 close 时点余额；`closed`/`archived`/有结算行 = period 冻结（PUT 改 period/template + DELETE 都 409）。v1-7 需 payout producer、v1-8 需 staging。本记录随每刀落地更新。
> **执行纪律**：money-path 切片（碰加班 grant / 请假 deduct 的事务）**绿了也不自动合,逐刀 owner review** —— CI-green-but-wrong 在这条线 = 算错工资。staging smoke 需环境（gated）。

---

## 1. 设计（已 RATIFIED）

**边界（最关键）**：MetaSheet 考勤是**工时事实引擎**，算"量 + flag"（加班累计 / 请假抵扣 / 有效工时 / 真实缺勤 / 满勤 flag / 周期末各来源剩余可折算分钟 + 可折算-直付标记），**按人按来源导出**；**倍率 / 工资基数 / 加班费金额 / 个税 = payroll**。对齐 `H2 OUT = payroll-SaaS`。

**四账模型**：① 加班产生账（按来源标签：工作日/休息日/法定/特殊工时制）② 请假抵扣账（先扣哪个池、最早过期优先）③ 考勤结果账（有效工时 / 真实缺勤 / 满勤资格 **三量独立**）④ 周期结算账（剩余可折算 + 可折算-直付标记；金额归 payroll）。

**六 Policy**：OvertimeBankPolicy · LeaveOffsetPolicy · AttendanceBonusPolicy · PayrollSettlementPolicy · PolicyAssignment · Ledger（不可变流水）。

**§11 配置契约（拍板锁的不是业务值,是契约）**：① 每条 bounded config；② 推荐默认 preset；③ 客户按 PolicyAssignment 覆盖；④ **生效日期 + 结算快照必需**；⑤ **合规下限不可被配置突破**。

**合规下限（法律，不可配）**：法定节假日加班按《劳动法》§44 **必须支付、不得调休抵扣** → `statutory_holiday` **永不可入池**；逐日按日历 `dayType` 判（长假含多个 statutory_holiday，每个都必付）。

---

## 2. v1 实现切片与验证状态

| 切片 | 内容 | PR | 状态 | 验证 |
|---|---|---|---|---|
| **v1-1a** | OvertimeBankPolicy 休眠 config + enum-strict normalizer + 整条 settings wire | #3145 | ✅ **landed** | unit 6/6 + **real-DB PUT/GET wire 往返**（full shape / partial-preserve siblings / statutory_holiday→400）|
| **v1-1b** | 账1 来源标签 lot：migration（`overtime_source`）+ gated 按来源 grant | #3158 `8862448ed` | ✅ **landed** | unit 8/8（partition）+ **real-DB**（dormant byte-identical via C2 §1–3 + ENABLED 按来源 lot 守恒 + replay 无重复贷记，C2 §4）。**owner review §P1/§P2 已闭环**（见 §3.5）|
| **v1-2a** | LeaveOffsetPolicy `leaveBalanceDeductionPolicy` 休眠 config + normalizer + wire | #3162 `c4e5944fd` | ✅ **landed** | unit 5/5 + real-DB wire 往返。**§P2 单池锁**：deductFrom 截断到单池 + PUT zod `.max(1)` 拒多池;跨池顺序 = v2 |
| **v1-2b** | LeaveOffsetPolicy **扣减 wiring**：按 rule 驱动 FIFO `deductLeaveBalance`(读单池)+ `mode='partial'`;dormant byte-identical | #3173 `fa1a41936` | ✅ **landed** | unit + **real-DB 矩阵**（dormant byte-identical · block 422+rollback · partial 扣可用+审批 · **no-double-deduct**：comp_time/annual 跳过）|
| **v1-3a** | AttendanceBonusPolicy 满勤休眠 config + normalizer | #3167 `3349c8613` | ✅ **landed** | unit 2/2 + real-DB wire 往返（rebase 修掉 #3158 allowlist 倒退后合）|
| **v1-3b** | 满勤 flag 计算（live summary,dormant-clean）：任意请假即 false（即便被池抵掉,读 raw leave_minutes）+ 迟到/早退 | #3193 | ✅ **landed** | unit 7/7 + real-DB（off→absent · on→present；**owner [P1]: late_early_days 漏数已修** + false-path 真实库用例）|
| ~~v1-4~~ | ~~账4 导出契约~~ → **DEFER 到 v1-5** | ~~#3201 closed~~ | ⛔ **deferred** | owner [P1]：live 导出混 period must-pay + current convertible balance（无 asOf/cycle 边界）→ 历史期间查算错可折算余额。settlement 导出 = period-end/snapshot 概念,需 v1-5 结算时点快照才温度一致（§7）|
| ~~v1-5（伞）~~ | 结算快照（snapshot-at-close）→ 拆 design-lock + a/b-i/b-ii/b-iii | #3206 design-lock | ✅ **ratified→built** | owner 拍板 snapshot-at-close + 新表落点；3 个 review-fix（frozen-period cols + source NOT NULL + §8a facts∪balance）已入锁 |
| **v1-5a** | 结算快照表 `attendance_payroll_cycle_settlements`（typed，休眠） | #3211 | ✅ **landed** | real-DB schema 锁：frozen-period cols + source NOT NULL + UNIQUE 幂等键 + **FK ON DELETE RESTRICT**（owner [P2]：不级联删不可变结算行） |
| **v1-5b-i** | 结算纯计算 `buildCycleSettlementRows`（§5，休眠） | #3228 | ✅ **landed** | unit 7/7：**poison-lot**（伪 statutory balance lot 不动 must_pay）· **无条件 must-pay**（bank-off 仍结算）· **un-pooled→must-pay**（owner [P1]）· convertible-by-source · legacy_unsourced |
| **v1-5b-ii** | 结算写路径 `snapshotCycleSettlementOnClose` + 三入口 close hooks + §8a population + **冻结守卫** | #3233 | ✅ **landed** | real-DB 矩阵：convertible · poison-lot-no-row · 幂等 replay · frozen-period-reject · DELETE-closed-reject · **create/generate-as-closed** · **archived-freeze**（owner [P1] + [P2]×2 闭环）|
| **v1-5b-iii** | must-pay-from-period-OT **e2e 实库测试** | #3255 `cc00066b6` | ✅ **landed** | real-DB attendance integration：period OT facts 经 OT-segmentation harness → settlement summary；workday un-pooled `must_pay=120`、statutory holiday `must_pay=480`、poison statutory balance lot `9999` 不污染 must-pay |
| **v1-6** | 授权 UI（3 卡片：OvertimeBankPolicy + LeaveOffsetPolicy + 满勤）| #3175 + #3194 | ✅ **landed** | vue-tsc -b 0 + vitest（load/toggle/PUT-only-policy-key;§6 UI 不暴露 statutory_holiday）|
| v1-7 | Ledger：扩 `source_type`（payout/manual_adjust）+ settlement/payroll-export 标记（**不新增 event_type**）| — | ⬜ designed | 计划 unit + real-DB |
| v1-8 | **staging smoke**（三例验收 + residue=0） | — | ⬜ gated | **staging 需环境（gated）**；real-DB money-path 矩阵已由逐刀 PR 覆盖到 #3255 |

---

## 3. 关键证明（已验证）

**① 休眠 byte-identical（回归底线）**：`overtimeBankPolicy` 默认 `enabled=false`、`pooledSources=[]`。
- v1-1a：settings 层默认全关，PUT/GET 往返不影响既有字段（real-DB wire 测试）。
- v1-1b：grant 的 **dormant 分支 = 既有单 lot INSERT 一字未改**（`overtime_source` 新列默认 NULL）；既有 C2 测试（§1–3）在 enabled=false 下仍绿即证明。

**② 合规下限两层挡（法定假不可入池）**：
- normalizer：`OVERTIME_BANK_POOLABLE_SOURCES` 白名单**不含** `statutory_holiday`，drop 之；
- API：PUT /settings 的 zod enum **不含** `statutory_holiday` → `pooledSources:['statutory_holiday']` 返回 **400**（real-DB wire 测试断言）；
- grant：holiday OT 保守映射成 `statutory_holiday`,**永不进 pooled lot**（partition 单测断言"只 workday/restday 入账"）。

**③ 守恒 + rule-once（账面不丢不重）**：grant 按来源分配的是**规则规整后的总额**（rule 只套一次，复用 NS-3 纪律），**最早过期优先** + **末个非零来源吃余数**（0 权重来源得 0，不被误归）→ **Σ 各来源 === 总额**（partition 单测 + C2 §4 real-DB 断言）。

**④ replay 幂等（不双贷记）**：每个按来源 lot 键 `overtime_conversion:${req}:${source}`,`ON CONFLICT (org_id, source_key) DO NOTHING`；重放 final-approval 不新增 lot/event（C2 §3/§4 real-DB 断言）。

### 3.5 owner review 抓到并闭环的合规/薪资 blocker（per-slice 人审的价值证据）

- **§P1（#3158，合规绕过）**：bank enabled 但无 segmentation snapshot（无来源 breakdown）时,早期 fallback 成一整笔 `source:null` 全量入池 —— 会把**法定节假日加班也池化**,绕过 §6 法律下限 + 客户 pooledSources。**已改 fail-closed:enabled 且来源不可判定 → 不生成可抵扣 lot(must-pay,不入池)**;NULL-source 整笔 fallback 仅限 dormant legacy path。
- **§P2（#3158，allowlist 漂移）**：allowlist 暴露了 v1-1b 产不出的 adjusted_rest_day/company_holiday/special_hours,配了也永不生效。**已收窄到 {workday, restday}**;holiday 子类等日历 dayType 细分后再放。
- **§P2（#3162,单池口径）**：config 持久化了多池 deductFrom,而 v1 wiring 只读单池 → 配置与实际扣减漂移。**已锁单池**:normalizer 截断到首个有效池 + PUT zod `.max(1)` 拒多池;数组形状留给 v2 跨池顺序。
- **CI 自查抓到（#3158）**:enabled grant 漏读 reshaped snapshot 字段 → 0 lot(comp-time grant 丢失)。已改读 reshaped 字段。

这三类都是"绿了但算错工资/绕过合规"的缺陷,**只有逐刀人审 + real-DB 才挡得住**,印证本线 money-path 不自动合的纪律。

---

## 4. 复用的现成基础设施（grounding，已核实）

`deductLeaveBalance`（通用 FIFO 最早过期优先扣减引擎，多类型同表，审计 `attendance_leave_balance_events`）· `compTimeGrantMinutes`（OT 三段产出）· `attendance_payroll_cycles` + payroll summary（账4 导出点）· #5 RT-1a enum-strict normalizer（AttendanceBonusPolicy 阈值复用）· 审批模板授权 #2296（配置 UI 复用）· NS-0/1/2/3 OT 三段（账1 来源 + partition 纪律）。

---

## 5. 已知保守取舍 / 后续细化

- **holiday 子类型**：v1-1b 把分段引擎的 `holiday` 桶保守当 `statutory_holiday`（必付、不入池）。`adjusted_rest_day` / `company_holiday` 的细分需日历层暴露 `dayType` 子类（后续 gated 切片）。
- **special_hours**：综合/不定时工时制来源分段引擎尚未产出；v1 周期级处理，细法规适配后续。
- **跨池扣减**：v1 锁单池；`comp_time → annual → unpaid` 顺序留 v2（显式 opt-in）。

---

## 6. 验证矩阵口径（v1-8）

每条最终需：real-DB 矩阵（三例验收 + 守恒 + replay + 休眠回归）+ staging smoke（PASS stamp / deploy SHA / residue=0）。当前 real-DB 已逐刀覆盖到 #3255（见 §2/§3/§7.3）；v1-8 只剩 staging smoke，待环境（与 NS-4/TA-4 同闸门）。

---

## 7. 账4 defer 到 v1-5 的理由 + v1-5 设计闸（待 owner 拍板）

### 7.1 为什么 账4（v1-4）defer

v1-4 曾把 settlement 导出挂在 **live `GET /summary?from&to`** 上,但 owner review [P1] 抓到**温度不一致**:
- `mustPayBySource`（statutory_holiday）来自 **period 事实**（from/to 的 holiday OT）;
- `convertibleBySource` 来自 `loadCompTimeRemainingBySource` —— **当前所有 active comp_time lot,无 period/asOf/cycle 边界**。

查 9 月 summary 时 must-pay 是 9 月的,但 convertible 可能含 10 月新入池、或被后续请假/过期改过的当前余额 → payroll 消费方天然按 from/to 理解 → **错发/漏发**。settlement 导出本质是 **period-end / snapshot** 概念,无法在 live 混温度读上自洽。故 **#3201 closed,导出归 v1-5**。owner [P2]（must-pay 真实库数值未锁、未证不从 balance lot 推导）也一并归 v1-5 矩阵。

### 7.2 v1-5 设计闸：snapshot-at-close vs reconstruct-as-of（owner 拍板）

核查 `attendance_payroll_cycles`：**已有生命周期**（`status ∈ open/closed/archived`,经 cycle-update route 写）。两条架构:

- **（推荐）snapshot-at-close**：cycle 转 `closed` 时,把各来源 facts（convertible 余额 by source + must-pay from period OT facts）**算一次并持久化**进 cycle/settlement 记录。构造即温度一致、可测;复用 `loadCompTimeRemainingBySource`（close 时点）。无需事件重建。
- **（后备,不推荐先做）reconstruct-as-of**：从 `attendance_leave_balance_events`（created_at）按 asOf 重建余额。最重、money-path、本地难验;**仅当 owner 要追溯正确性且无 close hook 时才用** —— 但 close hook 已具备。

**这是 owner 的拍板项,不是「continue」可自动建的**：v1-4 defer 让 v1-5 scope 扩大（吸收导出）,按本线 design-lock-first 纪律需 owner ratify。snapshot-at-close 还要定:导出存哪（`cycle.metadata` vs 新 settlement 表）、§7 effectiveFrom 快照哪些 policy、must-pay 必须从 **period OT facts** 算（**不从 balance lot 推导**,锁 owner [P2] 的反推毒测）。待 owner 拍 snapshot-at-close + 落点,再开 v1-5 build。

### 7.3 v1-5 闸已拍板 + 已建（2026-06-26 闭环）

owner 拍板 **snapshot-at-close**，落点 = **新 typed 表 `attendance_payroll_cycle_settlements`**（非 `cycle.metadata` blob，结算事实可查可断言）。design-lock `attendance-overtime-bank-v1-5-settlement-snapshot-designlock-20260625.md`（#3206 RATIFIED）含 3 个 owner review-fix：frozen-period cols + `source NOT NULL`（NULL/legacy→`legacy_unsourced`）+ §8a population = 期间 facts ∪ active 余额。**build 已完整落 main**：

- **v1-5a 表**（#3211）：frozen-period cols、`source NOT NULL`、`UNIQUE(org,cycle,user,source)` 幂等键、**FK ON DELETE RESTRICT**（owner [P2]：cycle 删不级联抹结算）。
- **v1-5b-i 纯计算**（#3228）：`buildCycleSettlementRows`(periodOtBySource + pooledSources)；must-pay = statutory 永付 + **非 pooledSources 来源**（owner [P1]：漏 un-pooled 会**少发**工资）；**poison-lot** 与**无条件 must-pay**（bank-off 仍结算）unit 锁。
- **v1-5b-ii 写路径 + 守卫**（#3233）：`snapshotCycleSettlementOnClose` 挂三入口 close（update/create/generate→closed，同事务、仅 transition、`ON CONFLICT DO NOTHING` 幂等）；§8a population 实库；**冻结守卫**：`closed`/`archived`/有结算行 → PUT 改 period/template + DELETE 都 409（owner [P1] 我误 defer 守卫 + [P2] create/generate 未测 + [P2] archived-once-closed 绕过，三 finding 闭环）。
- **v1-5b-iii must-pay e2e**（#3255）：period OT facts 经 OT-segmentation harness 进入 settlement summary；精确断言 `workday.must_pay_minutes=120`（un-pooled 来源必付）、`statutory_holiday.must_pay_minutes=480`（期间法定假 OT 必付）、`convertible=0`，且 `9999` poison statutory balance lot 不污染 must-pay。

**这条线 money-path 纪律的回报**：v1-5 单段 owner per-slice review 抓到并 pre-merge 闭环约 **13 个 money-path/会计 finding**（un-pooled 少发、FK 级联删、误 defer 守卫、create/generate 未覆盖、archived 绕过…），全部「CI 绿但算错工资」类——design-lock-first + 逐刀 review 正是为此存在。
