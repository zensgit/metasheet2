# 加班调休抵扣与周期结算规则 — 设计锁（RATIFIED）

> **Status**: ✅ **RATIFIED（§11 owner 拍板 2026-06-24）**。本设计锁锁定**规则模型 + 配置形态 + 合规护栏 + v1/v2 边界 + §11 配置契约**。**v1 已解锁**,但仍按 per-slice 纪律一刀一 PR 建（v1-1 → v1-8,见 §8 TODO）。代码侧 grounding 已在 main 核实（§10）。本文件陈述 MetaSheet 自身的设计原则与《劳动法》合规下限,不体现任何外部产品品牌。

---

## 1. 范围与边界

把"**加班入池 → 请假优先抵扣 → 周期末折算剩余**"做成**企业可配置**的结算规则组（名为「加班调休抵扣与周期结算规则」），不写死在系统里。

**边界（最关键）**：MetaSheet 考勤是**工时事实引擎**，只算"量 + flag"——加班累计、请假抵扣、有效工时、真实缺勤、满勤 flag、周期末**各来源剩余可折算分钟 + 可折算/必须直付标记**，按人按来源导出。**倍率 / 工资基数 / 加班费金额 / 个税 = payroll**，由 payroll 套各自费率算钱。对齐既定 `H2 OUT = payroll-SaaS`。

**OUT（明确不做）**：加班费金额计算、每人薪资费率、个税、自由规则 DSL/公式引擎。

---

## 2. 四账模型

清晰拆四账，互不串味：

1. **加班产生账（Overtime accrual）**：本期产生多少加班池，**按来源标签**——工作日 / 休息日 / 法定节假日 / 特殊工时制。每笔 OT 记 `source` + 产生时间 + 到期（lot），不是只记聚合分钟（丢来源就没法在账2/账4 区别对待）。
2. **请假抵扣账（Leave offset）**：请假先扣哪个池、按什么顺序。来源维度受**合规**约束（§6），时间维度 = 最早过期优先。
3. **考勤结果账（Attendance result）**：**三量互相独立、不可互推**——有效工时（排班 − 未覆盖请假）、真实缺勤（= max(0, Σ请假 − 可抵扣池)）、满勤奖资格（任意请假即 false，*即便被池抵掉*）。
4. **周期结算账（Cycle settlement）**：周期末各来源剩余按何处理（结转/过期/部分结转/强制 payout），哪些来源**允许折算**、哪些**必须直付**。我们出"剩余分钟 + 可折算/直付标记 + 工资基数口径引用"；**金额归 payroll**。

---

## 3. 六 Policy（实体模型）

| Policy | 职责 | 现状 | v1 新增 |
|---|---|---|---|
| **OvertimeBankPolicy** | 加班是否入池、哪些来源类型可入池、上限、有效期 | OT→`compTimeGrantMinutes` + comp_time lots + 到期 已有 | 账1 **来源标签 lot**（含特殊工时制）+ 可入池类型/上限 config |
| **LeaveOffsetPolicy** | 哪些请假类型可用池抵扣、扣减顺序、余额不足处理 | 通用 FIFO 扣减引擎 已有（§10） | 上层 `leaveBalanceDeductionPolicy` **纯 config**（驱动现有引擎） |
| **AttendanceBonusPolicy** | 满勤奖规则、"发生请假即取消"、迟到早退阈值 | 迟到/早退阈值 = #5 RT 报表分级 + 每组阈值 已有 | **满勤 flag** + "发生请假即取消"判定（新） |
| **PayrollSettlementPolicy** | 周期末如何处理剩余池、工资基数口径、周期 | `attendance_payroll_cycles` + payroll summary 导出点 已有 | 各来源**结转/过期/payout/直付** config + 导出契约 |
| **PolicyAssignment** | 规则分配给哪些员工/部门/岗位/考勤组/合同类型 + **生效日期** | org/组/子管理员/合同维度 基础设施 已有 | assignment 记录 + 生效日期（新） |
| **Ledger** | 加班入账 / 请假抵扣 / 周期 payout / 人工调整 走**不可变流水** | `attendance_leave_balance_events` 已是余额不可变事件流；**`event_type` 仍是余额动作枚举 `grant/deduct/expire/revoke`**，OT 入账已用 `event_type='grant' + source_type='overtime_conversion'` 表达 | 扩 **`source_type`**（如 `overtime_conversion` / `settlement_payout` / `manual_adjust`）+ settlement-item / payroll-export 标记。**是否新增 `event_type` = 单独 migration 决策,本锁不提前锁事件层** |

---

## 4. 余额类型 + 扣减契约

**统一余额模型**：年假与加班池走**同一套 ledger**，只是 `leave_type_code` 不同（现状即如此，§10）。

| 余额类型 | 来源 | 用途 | 周期结算 |
|---|---|---|---|
| `annual`（年假） | 年度额度发放 / 手工调整 | 请年假扣减 | 通常结转/过期，**不折工资**或按公司政策 |
| `comp_time`（加班调休池） | 加班审批转入（按来源标签） | 抵扣请假 / 调休 | 周期末**可折算工资**（来源受 §6 约束） |
| `personal_leave`（事假等） | 非余额，是**缺勤类型** | 余额不足后的真实缺勤 | 扣工资 / 影响满勤 |

**扣减策略契约**（上层 config，驱动现有 `deductLeaveBalance`）：

```json
{
  "leaveBalanceDeductionPolicy": {
    "enabled": true,
    "rules": [
      { "requestLeaveType": "annual",         "deductFrom": ["annual"],    "insufficient": "block" },
      { "requestLeaveType": "comp_time",      "deductFrom": ["comp_time"], "insufficient": "block" },
      { "requestLeaveType": "personal_leave", "deductFrom": ["comp_time"], "insufficient": "partial_unpaid_absence" }
    ]
  }
}
```
`deductFrom` 是**有序池列表**（v1 默认单池；v2 才放开如 `["comp_time","annual"]`）。`insufficient` ∈ `{block, partial_unpaid_absence}`。

---

## 5. 配置形态（可配，但带护栏 —— 不是自由 DSL）

**原则：对薪资/合规规则，"可配置" ≠ "用户写任意规则"。** 自由规则引擎 = 算错工资 + 法律责任 + 维护爆炸。形态 = **有限词表的结构化配置 + 预设克隆**。

**三层谁配什么：**
1. **产品出**：规则 schema（词表）+ 预设 + 合规护栏（§6，法律写死、配不动）。词表如 `deductFrom ∈ {comp_time, annual, unpaid}`、`cycle ∈ {month, quarter, year}`、`insufficient ∈ {block, partial_unpaid_absence}`、OT 来源 ∈ 4 类。
2. **企业管理员配**：在 schema 内**组合 / 克隆预设 / 分配**——不是写规则，是从下拉/开关/数字框选 + 搭；克隆预设改旋钮、分配给考勤组 + 生效日期。
3. **员工**：只看结果（我的池、我的满勤状态），配不了。

**复用已落地的两套安全模式**（不是发明规则引擎）：
- **enum-strict normalizer + 每组 config** = #5 RT-1a（每组可配阈值，normalizer 拒非法值）；
- **fail-closed allowlist 授权 UI** = 审批模板授权 #2296（allowlist 永不 flatten 未知字段）。

**预设（克隆起点，v1 随附）**：生产一线（加班池抵假、季度结算剩余）/ 管理岗（部分加班不入池、只记录）/ 销售岗（无满勤奖、或请假不影响某些奖金）/ 特殊工时制（按综合工时周期结算）。

---

## 6. 合规护栏（法律下限，不可配）

normalizer 同时是 fail-closed 合规护栏，**法律下限高于管理员 config**：
- **节假日加班按日历日 `dayType` 分级判定**（不是笼统"节假日"）：
  - `statutory_holiday`（真正法定假日）：依《劳动法》§44 **必须支付（300%）、不得以补休抵扣** → 中国法域 preset 下**强制 `direct_pay_required`**,管理员**配不动**（标成可抵扣/免付直接拒）；
  - `adjusted_rest_day`（调休日）/ `company_holiday`（公司假）：**企业可配置**进调休池或周期结算。
  - 这样支持"长假中**所有 `statutory_holiday` 必付**、**非 statutory_holiday 的调休日/公司假可配**",但**不允许把真正法定休假日配成免付**（长假可能含多个 statutory_holiday,逐日按 `dayType` 判,不是只认首日）。
- **工作日延时加班**：多数地区不宜无条件转池 → 默认不入池/给合规提示（§11 已拍板默认；企业可显式开）。
- **休息日加班**：经典调休来源，可安排补休（200% 或调休）。
- **来源分开** → normalizer 对违法组合给提示或禁止；未知字段拒。

---

## 7. 生效日期 + 结算快照纪律（硬要求）

**规则必须带生效日期，并在结算时快照**——企业今天改规则，**不能反向改掉上个月工资**。
- 每条 Policy 带 `effectiveFrom`；结算时把当时 **active 的 PayrollSettlementPolicy 版本快照**进结算账。
- 复用现有快照纪律：OT 三段是 versioned snapshot、年假是 "snapshot run + run_items provenance"——同一套。
- 事后改 policy 不动已结算周期；重算只走显式人工调整（写 Ledger）。

---

## 8. v1 / v2 边界

**v1（薄层 + 现成基础设施）**：
- LeaveOffsetPolicy 的 `leaveBalanceDeductionPolicy` config（复用现有 FIFO 引擎）；
- 账1 OT **来源标签 lot**（工作日/休息日/法定/特殊工时制）；
- AttendanceBonusPolicy 的**满勤 flag**（复用 RT 阈值）；
- 账4 **导出契约**（各来源剩余 + 可折算/直付标记，**不含金额**）；
- 生效日期快照；
- **保守默认：`annual` 不自动抵 `personal_leave`**（"事假自动扣年假"员工体验敏感，必须企业显式开）。三条默认：年假→annual、调休→comp_time、事假可选先扣 comp_time 不足转真实缺勤。

**v2（显式 opt-in，另起切片）**：放开**跨池扣减顺序**（如 `comp_time → annual → unpaid`），管理员侧必须显式展示该顺序。

### 落地 TODO（gated checklist）
- ✅ §11 owner 拍板（2026-06-24，配置契约 + 七条收敛值已锁；v1 解锁）
- ✅ v1-1 OvertimeBankPolicy + 账1 来源标签 lot（含特殊工时制）+ normalizer（#3145/#3158）
- ✅ v1-2 LeaveOffsetPolicy `leaveBalanceDeductionPolicy` config（驱动现有 `deductLeaveBalance`）+ 保守默认（#3162/#3173）
- ✅ v1-3 AttendanceBonusPolicy 满勤 flag（复用 RT 阈值）（#3167/#3193）
- ✅ v1-4 账4结算读取口径已吸收到 v1-5 snapshot-at-close（#3201 关闭，#3206 锁定）
- ✅ v1-5 PolicyAssignment / 生效日期 / 结算快照的 v1 范围：snapshot-at-close 表、计算、写路径、冻结守卫、must-pay e2e 均已落（#3206/#3211/#3228/#3233/#3255）
- ✅ v1-6 授权 UI（克隆审批模板授权那套）+ 预设清单（#3175/#3194）
- ⬜ v1-7 Ledger 扩 `source_type`（`overtime_conversion`/`settlement_payout`/`manual_adjust`）+ settlement-item/payroll-export 标记（复用现有 `event_type` `grant/deduct/expire/revoke`；新增 `event_type` = 单独 migration 决策,不在本锁；需 payout producer/consumer，另起 gated design）
- ⬜ v1-8 staging smoke（real-DB money-path 矩阵已逐刀覆盖到 #3255；staging 需环境）
- 🔒 v2 跨池扣减顺序（v1 绿 + 显式 opt-in 后另起）

---

## 9. 验收用例（owner 三例，初始池 = 0、纯累计）

设：排班满勤 176h，本期加班 +10h；`personal_leave` 走 `deductFrom: ["comp_time"]`：

| 例 | 请假 | 加班池(初始0) | 有效工时 | 真实缺勤 | 满勤 flag | 周期末剩余可折算 |
|---|---|---|---|---|---|---|
| 1 | 10h | 0+10−10=**0** | 176 | 0 | **否**（请过假） | **0** |
| 2 | 5h | 0+10−5=**5** | 176 | 0 | **否** | **5** |
| 3 | 15h | 0+10−10=**0** | **171** | **5** | **否** | **0** |

v2 若配 `deductFrom: ["comp_time","annual"]`：例 3 → comp_time 扣 10、annual 扣 5、真实缺勤 0、满勤仍否、annual −5。

---

## 10. 复用的现成基础设施（grounding，已在当前 main 核实）

- **`deductLeaveBalance(trx, {leaveTypeCode, amountMinutes, sourceType, sourceId, insufficient…})`**（符号引用为准；当前 main `plugins/plugin-attendance/index.cjs:15339`，行号随漂移）= **L0 通用 FIFO helper**：`ORDER BY expires_at ASC` 最早过期优先、多类型同表、写 `attendance_leave_balance_events` 审计（带 `sourceId=requestId`）。**"FIFO vs 过期"代码里已定 = 最早过期优先。**（注：#2622 是年假 design-lock,非本 helper 的实现落点。）
- **`attendance_leave_balance_events`** = 余额不可变事件流（Ledger 雏形）。
- **`compTimeGrantMinutes`** = OT 三段引擎已产出的加班折算分钟（账1 入池来源）。
- **`attendance_payroll_cycles` + payroll summary** = 账4 导出点。
- **#5 RT-1a** = enum-strict normalizer + 每组 config（AttendanceBonusPolicy 阈值复用）。
- **审批模板授权 #2296** = fail-closed allowlist 授权 UI（配置形态复用）。

---

## 11. owner 拍板（✅ 已拍板 2026-06-24）

**拍板的本质不是把 7 条业务值写死,而是锁定「配置契约」:** ① 每条都是 **bounded config**;② MetaSheet 提供**推荐默认 preset**;③ 客户可按 **PolicyAssignment 覆盖**;④ **生效日期 + 结算快照必需**;⑤ **合规下限不可被客户配置突破**。

| 项 | 默认 preset | 客户可配 |
|---|---|---|
| 满勤粒度 | 月度 | 可按月/周期 |
| 加班池结算周期 | 月/季/年 | 可配 |
| 周期末处理 | payout 后归零 | 可结转/过期/payout |
| 工作日延时加班 | 默认不入池 | 可显式入池 |
| 跨池扣减 | v1 默认单池 | v2 可配置顺序 |
| 特殊工时制 | 周期级 | 可按批准周期配置 |
| 分配优先级 | 员工 > 考勤组 > 部门 > 岗位 > 合同类型 | 可配置,但必须 deterministic |

**七条收敛值:**
1. **双粒度**：满勤按月判；加班池按 PayrollSettlementPolicy 的周期结算。请过假即满勤 `flag=false`,**即使被加班池抵掉**。
2. **carry vs reset/payout**：默认周期末结算剩余可折算分钟并归零；是否结转由 policy 显式配置,**禁止无限期静默累积**。
3. **工作日延时加班**：默认不入池,只记录/导出；企业可显式开启入池,但**必须有合规提示与来源标签**。
4. **跨池扣减**：v1 锁单池,**不自动 `comp_time → annual`**；跨池顺序放 v2,**必须显式 opt-in**。
5. **特殊工时制粒度**：按批准/配置的**综合工时周期结算,不按单日自动入池**。v1 只做**周期级来源标签与结算导出**；不定时/综合工时的更细法规适配后续 gated。
6. **预设四档**：生产一线 / 管理岗 / 销售岗 / 特殊工时制,作为 **clone 起点,不是硬编码行业规则**。
7. **PolicyAssignment 优先级**：员工 > 考勤组 > 部门 > 岗位 > 合同类型；**同优先级按 `effectiveFrom` 最新赢,再用版本/更新时间做稳定 tie-break**（deterministic）。

---

## 12. 不在本期（OUT）

加班费金额 / 每人费率 / 工资计算 / 个税（payroll）；自由规则 DSL/公式引擎；v2 跨池扣减顺序（另起切片）。
