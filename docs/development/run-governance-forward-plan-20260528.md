# 运行治理 / 收敛引擎线 — 前向开发安排（需求闸账本 · 2026-05-28）

> 类型：**前向开发安排（forward plan）**，非开工清单。
> **2026-05-29 update**：A4 retry scope-gate (#2039) + A5 whole-execution retry runtime (#2047) 已按具名 opt-in 落地；`/test` + retry HTTP serialization redaction/fail-open hardening 已由 #2051/#2053 闭合。A6-0 docs-only scout 已记录在 `multitable-automation-a6-convergence-scout-20260529.md`；A6 runtime 仍 frozen / demand-gated。
> 配套（已收口）：`multitable-automation-run-governance-development-20260527.md` + `-todo-20260527.md`（#1987 固化）。
> 上游契约：C1 `workflow-job-contract.ts`（#1889，landed）· 收敛 RFC #1885。
> 锁：**K3 Stage-1 blanket 锁已退役（#1993；#1792 = M1 单条 Material Save-only PASS）→ 改用 post-GATE scoped gates（见 `k3-post-gate-scoped-governance-20260528.md`）**。这不改变本线纪律：**治理半（A0–A3）属于内核治理 / observability，已关闭**；**能力半（A4–A6）仍各受需求闸 / 独立具名 opt-in**（本线天然为 multitable 内核范畴，不依赖 integration-core / RBAC / auth），除非对应 scout 明确授权。

---

## 0. 核心判断 —— 为什么这份是"账本"而不是"排期"

这条线**没有线性排期**，因为它由两半构成、完成度天差地别：

| 半 | 100% = | 完成度 | 是否该现在排期 |
|---|---|---|---|
| **治理半**（observability：快照→脱敏→只读 API→admin UI→可达） | 运行可观测/可审计/可诊断 | **✅ 100% + 文档固化** | 否 —— 已关闭，不重开 |
| **Retry 能力薄片**（A4/A5：whole-execution retry） | 失败/跳过 run 可由 admin 显式确认后整 run 重跑 | **✅ 100% for A5 v1** | 否 —— 已关闭；UI/idempotency/record-refresh 另需 opt-in |
| **收敛引擎能力半**（A6：suspend/resume / branch / DAG / approval-as-job） | automation+approval 统一到 WorkflowJob 引擎 | **⬜ 引擎本体 0%**（契约层就位、被读边界消费；机器本体未建） | 否 —— **受需求闸，未触发即过早工程** |

> **grounded 2026-05-29**：`/retry` 路由已存在且仅实现 A5 whole-execution retry；`automation-executor.ts` 仍无 suspend/resume/branch/persist-job runtime；C1 契约仅被 `routes/automation.ts` 在 A2 读边界用作状态映射（`success→resolved`），job/suspend/branch 机器未被任何 runtime 引用。

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
| A4 retry scope-gate / design lock | #2039 | 06cb7bf6a |
| A5 whole-execution retry runtime | #2047 | c83ab6ca1 |
| `/test` + retry response redaction / fail-open hardening | #2051 / #2053 | 84fa45d12 / a3ba6afde |

治理半链路完整且可达；A5 retry v1 也已按具名 opt-in 落地。**这些部分不在前向安排内。**

---

## 3. 能力半前向阶梯 —— 状态 / 触发信号 / 解锁后第一步

> 顺序是**依赖序**（前节是后节地基），**不是排期**。每节标注：触发它的真实信号、解锁后第一步、锁姿态。

### A4 — Retry scope-gate（design-only）✅ closed (#2039)
- **已落地**：当前 enabled rule + stored trigger_event；admin-only；explicit side-effect confirmation；provenance; fail-closed matrix；A5 不 replay redacted rule_snapshot。
- **仍不自动打开**：retry UI、external idempotency keys、re-fetch-current-record context、broader PII display policy。

### A5 — Retry runtime ✅ closed (#2047 + #2051 + #2053)
- **已落地**：`POST /api/multitable/automation-executions/:id/retry`；`rerun_of_execution_id` / `initiated_by`; failed/skipped only; current rule + stored trigger_event; persisted-redacted response.
- **健壮性闭合**：`/test` 与 retry 的 HTTP serialization invariant 已闭合；log-read failure uses safe fallback, not 500.
- **锁姿态**：本 A5 v1 closed。后续 retry UI / idempotency / live-record-context 都是新 opt-in，不属于本 closed slice。

### A6 — 收敛引擎 🔒 frozen / 需求驱动
依赖序：**持久 WorkflowJob runtime → suspend/resume（先 webhook 后 delay）→ branch/parallel（DAG）→ BPMN compile/preview adapter → approval-as-job**。
- **A6-0 scout**：`multitable-automation-a6-convergence-scout-20260529.md` 只记录边界/顺序/测试面；它不是 runtime unlock。
- **触发信号**：某个**集成/DF 流水线真的需要 human-in-the-loop**（"导入→清洗→**等人工审批**→导出"= suspend + approval-as-job）或按记录分支；**且本就在 K3 GATE 下游**。
- **解锁后第一步**：持久 WorkflowJob runtime（wire #1889）—— **风险：热路径重写（每 action 一次 DB 写 = 写放大 + 事务性 + 旧规则兼容）→ 必带 flag / 向后兼容**，现有 fire-and-forget 规则不得突然全量持久。
- **治理继承硬契约**：A6 任一能力落地必须**复用本线的 run/job/status/provenance/redaction 底座**，不得新建二等可观测层。
- **BPMN 永久定位**：compile/preview adapter（编译成 auto/approval 定义），**永不自己执行**（否则第四套状态孤岛）。
- **锁姿态**：🔒🔒 全 frozen。approval-as-job 排最后（最高价值+最高风险，completion-event-contract 先行）。

---

## 4. A3/A5 = 需求探针（observability + controlled replay）

我们**先建可观测（A0–A3）、再用具名 opt-in 建最小 replay（A4/A5）、仍不建引擎（A6）**，是刻意的：

> A3 admin runs view 把"是否需要 retry"从猜测变成证据；A4/A5 只补 whole-execution retry v1，不进入 suspend/resume 或 branch/parallel。现在 A5 自己也是 A6 的需求探针：如果 whole-run retry 不够，才说明需要更细粒度 resume/job graph。

---

## 5. 这条线在产品大局中的位置（避免 myopia）

**这条线不是产品关键路径。** 真正的关键路径是 **K3 下游 DF/K3 能力线**（DF-N2、K3 read/list、Save 扩展、Submit/Audit/BOM/多条）—— K3 PoC macro-GATE 已过（#1792 M1 单条 Save-only PASS），这些下游能力改由 **post-GATE scoped gates** 管（仍需 owner / 客户分别签核，见 `k3-post-gate-scoped-governance-20260528.md`）；它们按各自 session / PR 节奏推进，本账本不抢主线。

→ "全局接下去开发什么"的答案不是本线，而是 **K3 下游 scoped 能力线**。本线**让位**：能力半的 A6 需求本就来自**成熟的 DF 流水线**（post-GATE scoped，需 human-in-the-loop 时才触发）。

---

## 6. 责任分工（谁在什么时候动）

| 角色 | 负责 | 现在状态 |
|---|---|---|
| **本线（run-governance / retry v1）** | A0-A5 | ✅ 收口，停 |
| **本 session** | 点名 review（K3/DF/data-sources 主线优先）+ A6 具名 opt-in 时的 scout/impl | 待命，不主动推 |
| **并行 session** | K3 GATE 主线、DF-N/DF-T、data-sources lanes | 进行中 |
| **Owner（你）** | 需求闸决策：是否进入 retry UI/idempotency/A6 等新项；其余 owner 决策点（如 grid C0 已拍） | 决策位 |
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

**治理半已完成、A5 whole-execution retry v1 已完成、文档固化后不重开。A6 收敛引擎仍 frozen / demand-gated。** 近期"开发安排"实质是：**本 session 待命做点名 review；A5 的运行效果用于判断是否需要 retry UI / idempotency / A6；A6 本就排在 K3/DF 成熟需求下游。** 触发出现 → 走 §7 流程。无触发 → 不动，这就是正确的安排。
