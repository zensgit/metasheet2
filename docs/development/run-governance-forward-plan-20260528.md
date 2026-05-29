# 运行治理 / 收敛引擎线 — 前向开发安排（需求闸账本 · 2026-05-28）

> 类型：**前向开发安排（forward plan）**，非开工清单。
> 配套（已收口）：`multitable-automation-run-governance-development-20260527.md` + `-todo-20260527.md`（#1987 固化）。
> 上游契约：C1 `workflow-job-contract.ts`（#1889，landed）· 收敛 RFC #1885。
> 锁：**K3 Stage-1 blanket 锁已退役（#1993；#1792 = M1 单条 Material Save-only PASS）→ 改用 post-GATE scoped gates（见 `k3-post-gate-scoped-governance-20260528.md`）**。这不改变本线纪律：**治理半（A0–A3）属于内核治理 / observability，已关闭**；**能力半（A4–A6）仍各受需求闸 / 独立具名 opt-in**（本线天然为 multitable 内核范畴，不依赖 integration-core / RBAC / auth），除非对应 scout 明确授权。

---

## 0. 核心判断 —— 为什么这份是"账本"而不是"排期"

这条线**没有线性排期**，因为它由两半构成、完成度天差地别：

| 半 | 100% = | 完成度 | 是否该现在排期 |
|---|---|---|---|
| **治理半**（observability：快照→脱敏→只读 API→admin UI→可达） | 运行可观测/可审计/可诊断 | **✅ 100% + 文档固化** | 否 —— 已关闭，不重开 |
| **能力半**（收敛引擎：suspend/resume / branch / DAG / approval-as-job） | automation+approval 统一到 WorkflowJob 引擎 | **⬜ 引擎本体 0%**（契约层就位、被读边界消费；机器本体未建） | 否 —— **受需求闸，未触发即过早工程** |

> **grounded 2026-05-28**：`automation-executor.ts` 无 suspend/resume/branch/persist-job 任何 runtime；`/retry` 路由不存在；C1 契约仅被 `routes/automation.ts` 在 A2 读边界用作状态映射（`success→resolved`），job/suspend/branch 机器未被任何 runtime 引用。

**所以"接下去的开发安排" = 触发条件账本 + 不自动推进纪律，不是任务队列。**

---

## 1. 纪律（决定本账本形态的两条）

- **两闸**：能力按**具名集成/产品需求**触发（需求闸）；任何流程面必须继承共享 run/job/status/provenance/redaction 底座（治理闸）。治理普适、能力按需 —— 不为对称而建。
- **staged opt-in**：每个 unlock（A4→A5→A6 的每一节）是**一次独立的显式用户 opt-in**，前一节落地不自动开下一节。

---

## 2. 已关闭（✅ 不重开）

| 项 | PR | 提交 |
|---|---|---|
| A0 两闸纪律 + scope-gate | #1932 | 36ad42da4 |
| A1 execution 快照 + 落盘前脱敏 + redactor 统一 | #1937 | 030ed32a5 |
| dead-letter error secret scrub | #1917 | 3163cdbb4 |
| A2 只读 runs API + C1 读边界映射 + admin-only gate | #1967 / #1973 | 9468a6816 / 0e06ebf19 |
| A3 admin runs view + 导航入口 | #1975 / #1983 | 9e504de38 |
| 文档固化（TODO 不再 proposed） | #1987 | e7faf9799 |

治理半链路完整且可达；每层继承治理。**这部分不在前向安排内。**

---

## 3. 能力半前向阶梯 —— 状态 / 触发信号 / 解锁后第一步

> 顺序是**依赖序**（前节是后节地基），**不是排期**。每节标注：触发它的真实信号、解锁后第一步、锁姿态。

### A4 — Retry scope-gate（design-only）🔒 deferred
- **触发信号**：**A3 视图（已上线）暴露出真实运营痛** —— admin 频繁看到失败 run 且需要手动重跑。A3 正是产生这个信号的仪器（见 §4）。
- **解锁后第一步**：docs-only 设计 scout —— 定 retry 源（`rule_snapshot` vs 当前 rule，默认前者）、副作用确认 UX（idempotency key）、审计字段、**并决定 A1 标记的 business-field/PII-in-replay 遮罩开放问题**。
- **锁姿态**：docs 本身锁安全；但产出的 retry runtime（A5）受 gate。

### A5 — Retry runtime 🔒 gated
- **触发信号**：A4 设计获采纳 + 具名 unlock。
- **解锁后第一步**：迁移加 `rerun_of_execution_id` / `initiated_by`（此时才有写入者）；`POST /api/multitable/automation-executions/:id/retry`；从 `rule_snapshot` 重建、复用 `trigger_event`、回链。
- **锁姿态**：🔒 runtime，需具名 unlock。retry = 未来 resume 的退化特例（与 A6 复用恢复路径）。

### A6 — 收敛引擎 🔒 frozen / 需求驱动
依赖序：**持久 WorkflowJob runtime → suspend/resume（先 webhook 后 delay）→ branch/parallel（DAG）→ BPMN compile/preview adapter → approval-as-job**。
- **触发信号**：某个**集成/DF 流水线真的需要 human-in-the-loop**（"导入→清洗→**等人工审批**→导出"= suspend + approval-as-job）或按记录分支；**且本就在 K3 GATE 下游**。
- **解锁后第一步**：持久 WorkflowJob runtime（wire #1889）—— **风险：热路径重写（每 action 一次 DB 写 = 写放大 + 事务性 + 旧规则兼容）→ 必带 flag / 向后兼容**，现有 fire-and-forget 规则不得突然全量持久。
- **治理继承硬契约**：A6 任一能力落地必须**复用本线的 run/job/status/provenance/redaction 底座**，不得新建二等可观测层。
- **BPMN 永久定位**：compile/preview adapter（编译成 auto/approval 定义），**永不自己执行**（否则第四套状态孤岛）。
- **锁姿态**：🔒🔒 全 frozen。approval-as-job 排最后（最高价值+最高风险，completion-event-contract 先行）。

---

## 4. A3 = 需求探针（observability-first 闭环 — 本线最该被看见的设计）

我们**先建可观测（A0–A3）、后建能力（A4+）**，是刻意的：

> A3 admin runs view 上线后，"运营是否真的需要 retry"从**猜测**变成**证据**。在 A3 暴露足够真实的失败-重跑痛之前，A4/A5 都是过早工程。**A3 自己就是 A4/A5 需求闸的测量仪。** 这是两闸纪律按设计运作 —— 不靠拍脑袋决定建不建引擎，靠数据。

---

## 5. 这条线在产品大局中的位置（避免 myopia）

**这条线不是产品关键路径。** 真正的关键路径是 **K3 下游 DF/K3 能力线**（DF-N2、K3 read/list、Save 扩展、Submit/Audit/BOM/多条）—— K3 PoC macro-GATE 已过（#1792 M1 单条 Save-only PASS），这些下游能力改由 **post-GATE scoped gates** 管（仍需 owner / 客户分别签核，见 `k3-post-gate-scoped-governance-20260528.md`）；它们按各自 session / PR 节奏推进，本账本不抢主线。

→ "全局接下去开发什么"的答案不是本线，而是 **K3 下游 scoped 能力线**。本线**让位**：能力半的 A6 需求本就来自**成熟的 DF 流水线**（post-GATE scoped，需 human-in-the-loop 时才触发）。

---

## 6. 责任分工（谁在什么时候动）

| 角色 | 负责 | 现在状态 |
|---|---|---|
| **本线（run-governance）** | 治理半 | ✅ 收口，停 |
| **本 session** | 点名 review（K3/DF/data-sources 主线优先）+ 能力半具名 opt-in 时的 scout/impl | 待命，不主动推 |
| **并行 session** | K3 GATE 主线、DF-N/DF-T、data-sources lanes | 进行中 |
| **Owner（你）** | 需求闸决策：是否"要 retry"（开 A4）、其余 owner 决策点（如 grid C0 已拍） | 决策位 |
| **Customer / Owner** | K3 下游 scoped-gate 签核（Save 扩展 / Submit/Audit/BOM / 多条 — 间接拉动 A6 编排需求） | macro-GATE ✅ PASS（#1792 M1）；下游 scoped gates 仍待 |

---

## 7. 触发后的标准进入流程（每个 unlock 通用）

任一节被 owner 显式 opt-in 后，按既定纪律：
1. **fresh worktree off origin/main**（不读 detached/dirty 根检出）。
2. **scout 先行**（读真实代码，回答"复用什么、最小改动集、哪些测试"），出 design-review 到 /tmp。
3. owner 确认 scout → **gated 实现**（独立 PR，just-in-time rebase → admin-squash，CI 绿 + 无 overlap）。
4. **不跨节**：本节落地不自动开下一节。

---

## 8. 一句话排期

**治理半已完成、文档固化、不重开。能力半（A4→A5→A6）= 依赖序就绪、但全部受需求闸，眼下不主动建任何一项。** 近期"开发安排"实质是：**本 session 待命做点名 review；A4 的解锁信号由已上线的 A3 视图去测量；A6 本就排在 K3 GATE 下游。** 触发出现 → 走 §7 流程。无触发 → 不动,这就是正确的安排。
