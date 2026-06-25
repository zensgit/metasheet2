# 加班银行 v1-5 — 周期结算快照（settlement snapshot）设计锁

> **状态**：架构 owner 拍板 2026-06-25（snapshot-at-close + 新 typed 表 + must-pay-from-facts）;**owner #3206 review = CHANGES REQUIRED,3 项已闭环**（[P1] closed cycle 周期冻结 → §2 加 `period_start/end_date`+`closed_at` + §3 close 后禁改周期;[P2] NULL/legacy `overtime_source` → §2 `source NOT NULL` + COALESCE `legacy_unsourced` + 处置;[P2] 结算人群 → §8a 事实∪余额并集,非 active 名单）。本锁把 v1-4 defer 后扩大的 v1-5 scope（PolicyAssignment + 生效日期 + 结算快照 **+ 吸收 §4 账4 导出**）收敛成可实现的契约。**先锁后建**——本锁(含 3 修)land 后再开 v1-5 runtime。
> **缘起**：v1-4（#3201）把 settlement 导出挂在 live `GET /summary?from&to` 上,owner [P1] 抓到温度不一致（period must-pay + 当前累计 convertible 余额,无 asOf/cycle 边界 → 历史期间查算错）。settlement 本质是 period-end/snapshot 概念。故导出归 v1-5,以 cycle close 为温度一致的快照时点。
> **边界不变**：考勤出**量 + flag**（各来源剩余 convertible + must-pay 标记 + 快照 metadata）;**倍率/工资基数/金额/个税 = payroll**,不进本表。

---

## 1. 架构决策：snapshot-at-close（拒绝 reconstruct-as-of 先行）

`attendance_payroll_cycles` 已有 `status ∈ open/closed/archived` 生命周期。结算快照在 **cycle 进入 `closed` 时算一次并持久化**——构造即温度一致（无需事后按 asOf 重建）、可测、幂等。

- **拒绝（不先做）reconstruct-as-of**（从 `attendance_leave_balance_events.created_at` 按 asOf 重建余额）：最重、money-path、本地难验;**仅在 owner 要追溯正确性且无 close hook 时才用——但 close hook 已具备**。留作显式 admin recompute 的后备实现,不在 v1-5。

## 2. 落点：新 typed 表（不塞 `cycle.metadata` blob）

新建 **`attendance_payroll_cycle_settlements`**（typed rows,可查询、可断言）：

| 列 | 说明 |
|---|---|
| `id` uuid PK | |
| `org_id` text | |
| `cycle_id` uuid FK → attendance_payroll_cycles | |
| `period_start_date` date | **[P1] 冻结周期**：close 时从 cycle 拷入,settlement 自带周期,**不随后续 cycle PUT 漂移**;读出口按本表 period,不依赖 cycle 当前 start/end |
| `period_end_date` date | 同上 |
| `closed_at` timestamptz | **快照时点**（cycle 进入 `closed` 的时刻）|
| `user_id` text | 按人（人群口径见 §8a）|
| `source` text **NOT NULL** | OT 来源（`workday`/`restday`/`statutory_holiday`/`legacy_unsourced`）;**[P2] NULL `overtime_source` 结算时 COALESCE → `legacy_unsourced`**,唯一键按归一化后的非 NULL source 生效 |
| `convertible_minutes` int | 该来源 close 时点的可折算余额（见 §5）|
| `must_pay_minutes` int | 该来源本周期必须直付的 OT（见 §5,从 period facts 算）|
| `snapshot` jsonb | 快照范围（§4：policies + assignment/effectiveFrom/version/hash）|
| `created_at` timestamptz | 行写入时刻 |

- **唯一约束 `UNIQUE (org_id, cycle_id, user_id, source)`** —— 幂等键（§6）。**source `NOT NULL` 是前提（[P2]）**：Postgres 对 NULL 不等价,nullable source 会让幂等键漏判 + 重复 close 重复写;故 NULL `overtime_source` 结算时 COALESCE 到 `legacy_unsourced` **再入键**。
- **`legacy_unsourced` 处置（[P2]）**：v1-1b dormant/legacy path 产出的 `overtime_source = NULL` comp_time lot = **已入池的调休余额**（只是无来源标签）→ 归 **convertible**（导出给 payroll 作可折算）,**不是** must-pay（must-pay 只来自未入池的 statutory OT）。结算枚举 comp_time lot 时**不能只 group 有 source 的 lot**（否则漏掉历史/休眠余额）——一律 COALESCE 后 group。
- `cycle.metadata` 最多放 `{ settlementSnapshotId / snapshotHash / settledStatus }`,**不放明细**（明细在本表）。
- **不含金额**：无 amount/rate/wage-base 列。payroll 按 convertible/must-pay 分钟 × 自己的费率算钱。

## 3. 触发点：锁在 cycle 进入 `closed`

- **update 从非 `closed` → `closed`**：走 close-snapshot path。
- **create/generate 直接创建 `closed`**：也走**同一** close-snapshot path（不能绕过）。
- 实现上抽一个 `snapshotCycleSettlementOnClose(trx, cycle)`,被上述两条入口共用;在 cycle 状态写 `closed` 的**同一事务**内执行（原子）。
- **[P1] close 后冻结 cycle 周期字段**：现有 `PUT /api/attendance/payroll-cycles/:id` 仍可改 `start_date`/`end_date`/`template_id`/`status`——v1-5 必须在 cycle `status === 'closed'` 时**拒绝修改 `start_date`/`end_date`/`template_id`**（settlement 已按当时 period 算定,改周期会让旧快照挂错周期 → 审计/payroll 错）;只允许 `archive` 或显式 reopen/recompute（§6）。**双保险**：settlement 行自带 `period_start_date/period_end_date/closed_at`（§2）,读出口按本表 period,即便 cycle 周期被改也不漂移。

## 4. 快照范围（snapshot jsonb）

close 时刻至少快照（值 + 版本/hash,供事后审计「当时用的什么规则」）：

- `overtimeBankPolicy`、`leaveBalanceDeductionPolicy`、`attendanceBonusPolicy`（§3 的三条 policy 当时的值）;
- 当时的 **PolicyAssignment 解析结果** + `effectiveFrom` + `version` + `hash`（§7 生效日期纪律：改规则不反算已结算周期——快照固化当时版本）。
- **不快照** payroll 的倍率/工资基数（归 payroll）。

事后改 policy **不动**已 close 的快照（§6 immutable）。

## 5. 计算口径（温度一致的两态配对）

- **`must_pay_minutes`（本周期事实）**：从 **cycle `[start_date, end_date]` 的 period overtime facts** 算——即该周期 statutory_holiday（及未入池来源）的 OT 总额。**必须从 period OT facts 算,永远不从 balance lot 推导**（§7 invariant）。must-pay 的「周期」= **被 close 的 cycle 的 [start,end]**（cycle 定义周期）。
- **`convertible_minutes`（close 时点余额）**：各来源 comp_time lot 在 **close 时点的剩余**（复用 `loadCompTimeRemainingBySource`,在 close 那一刻取）。这是**累计可折算余额**（含往期入池 lot）,语义标注为「balance at close」。
- 二者是**有意的两温度配对**（must-pay=本周期事实 / convertible=close 时点余额）,**不是** v1-4 那种意外混淆——本锁显式声明语义,payroll 据此分别处理。

## 6. immutable + 幂等 + 显式 recompute

- close 后快照**默认 immutable**。
- **重放 close 幂等**：`UNIQUE (org,cycle,user,source)` + `ON CONFLICT DO NOTHING`（或先查「已快照则 skip」）→ 重复 close 不重复写、不改既有行。
- 后续若要重算：**另开显式 admin recompute / reopen 机制**（reopen → 标记 + 受控重算 + 写审计）,不在 v1-5。

## 7. must-pay-from-facts invariant + poison-lot 测试（owner [P2]）

- **Invariant**：`must_pay_minutes` 只来自 period OT facts,**永不从 balance lot 推导**。
- **poison-lot 真实库测试（必须）**：伪造/残留一个 `statutory_holiday` 的 balance lot（或任意 must-pay 来源的 lot）,断言 **must-pay 数值不受其影响**（仍 === period OT facts 的分钟）。证明 must-pay 与 balance lot 解耦。
- 配套：must-pay 的具体分钟值要被真实库断言锁住（不只断言 key 存在——owner [P2] 对 v1-4 的批评）。

## 8. v1-5 build 切片（本锁 land 后逐刀,money-path 逐刀 review）

### 8a. 结算人群口径（[P2] —— 不能等同「当前活跃员工列表」）

close 时枚举哪些 user 进 settlement = **以下两类的并集**,再用 org boundary 限定：
- cycle `[period_start_date, period_end_date]` 内**有 OT facts / leave-offset facts / attendance facts** 的人;
- close 时**有 active comp_time balance**（任意 source,含 `legacy_unsourced`）的人。

**`active user_orgs` 只作权限/归属参考,不能作为唯一人群来源**——否则离职但本周期有 OT facts、或 close 时仍有 comp_time 余额的人会**漏结算**（年假线踩过的坑：只扫 active 会漏离职/非 active 但仍有余额或期间事实的人）。结算是工资/余额收口,必须覆盖「有事实或有余额」的全集,而非「当前在职名单」。v1-5b 的真实库矩阵要含一例「离职/非 active 但本周期有 OT facts 或有 comp_time 余额」的人被正确结算。

### 8b. 切片

- **v1-5a**：migration 新建 `attendance_payroll_cycle_settlements`（含 `period_start_date`/`period_end_date`/`closed_at`、`source NOT NULL`、UNIQUE）+ dormant（无写入）。
- **v1-5b**：`snapshotCycleSettlementOnClose` 计算 + 写入（convertible-at-close + must-pay-from-period-facts + NULL source COALESCE→`legacy_unsourced`）+ 接两条 close 入口（同事务、幂等）+ **[P1] close 后冻结 cycle 周期字段的 PUT 守卫**;人群按 **§8a**（事实∪余额,非 active 名单）。real-DB 矩阵：close 写快照 / 重放幂等 / poison-lot / convertible-by-source / **must-pay 分钟锁** / **`legacy_unsourced`（NULL source）入键不漏** / **离职但本周期有 OT facts 或有 comp_time 余额的人被结算** / **close 后改 start/end 被拒**。
- **v1-5c**：快照范围（policies + assignment/effectiveFrom/version/hash）落 `snapshot` jsonb + effectiveFrom 纪律。
- **v1-5d**：读出口（`GET cycle settlement` 或导出契约）——从**本表**读已快照的 settlement,**按本表 `period_start/end_date`**（不依赖 cycle 当前周期,§2 [P1]）,温度一致,替代 v1-4 的 live 混读。
- 每刀 dormant-safe / 不碰已 close 行 / held for review。

## 9. OUT（明确不在 v1-5）

- 金额/倍率/工资基数（payroll）。
- reconstruct-as-of 事件重建（后备,仅 recompute 机制需要时）。
- admin recompute/reopen 机制（另开）。
- 跨周期结转/部分结转的复杂结算策略（PayrollSettlementPolicy 的 config 之外的高级语义）。
