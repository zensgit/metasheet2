# RFC：Approval ↔ Automation 收敛（job 挂起/恢复统一引擎）2026-05-26

- **状态**：RFC / **设计储备**。**runtime 一行不写**，K3 GATE PASS 或具名解锁前**冻结**。
- **来源**：本文是 `docs/research/metasheet2-vs-teable-benchmark-20260525.md`（#1879）§5 头号发现的落地设计；benchmark 结论是 **NocoBase plugin-workflow 的 job 挂起/恢复模型 = 把 approval 人工节点 + automation 延时/等待节点 + DAG 统一进一个引擎的地基**。
- **路径约定**：所有代码引用为完整 workspace-relative 路径（仓库根）。外部参照在 `references/`（`.git/info/exclude` 本地忽略，复现见 #1879 §9）。

## 0. 范围与非目标

- **是什么**：一份架构设计储备，论证「我们能否、以及如何」把现有两套割裂的流程运行时收敛到一个带挂起/恢复的 job 模型。
- **不是什么**：不写 runtime、不加 migration、不改 route、不引依赖。**不解锁** approval Phase 2/3 下游、不解锁 automation 编排 runtime。
- **AGPL 纪律**：NocoBase 为 AGPL-3.0，**只借鉴架构模式、不复制其源码**（见 #1879 §6.2）。本文只描述模式 + file:line 锚点。
- **lock 自洽**：K3 lock 的 #1 风险是「PoC 通过前过度打磨 kernel **runtime**」。本文是**冻结 runtime 的设计文档**，与 D2 perf-gate 设计、yida benchmark plan 同类（docs-only 储备）。**它是「备而不用」，不是「现在要建」。**

## 1. 问题：两套割裂的流程运行时

我们今天有**两个**独立的「按步骤推进 + 持久化状态」的引擎，互不相通：

| | approval product | multitable automation |
|---|---|---|
| 模型 | **DAG 状态机**（节点/边，会签/或签/并行） | **线性 1..N，fail-stop** |
| 推进 | 人工动作驱动（approve/reject/…） | 事件触发后**同步跑完** |
| 持久化 | `approval_instances` / `approval_assignments` / `approval_records` | `multitable_automation_executions`（+steps JSONB） |
| 版本冻结 | `published_definition_id` → 冻结 runtime graph | 无（读当前 rule） |
| 挂起/恢复 | 有「人工等待」语义但**专属 approval**，automation 无法复用 | **无**（不能等人、等时、等外部事件） |

**割裂的代价**：
1. automation 想「发起审批后等审批结果再继续」→ 做不到（automation 无挂起；approval 不是 automation 的一个 step）。这正是 yida benchmark Phase 2 `start_approval` + event-bridge 想要的。
2. automation 想要 delay / wait-until / 人工确认节点 → 做不到（线性同步、无 PENDING 态）。这正是 PLAN-Automation 想补的编排能力。
3. 两套审计/状态模型重复造（approval 6 动作审计 vs automation 4 态 execution），无法统一观测。

## 2. 现状盘点（亲验 file:line）

**automation（线性、无挂起）**：
- 执行：`packages/core-backend/src/multitable/automation-executor.ts:578`（`executeActions`）逐个动作**顺序**跑。语义两分：**条件不满足** → 整体 `execution.status='skipped'`（在 `execute()` `:549`）；**action 失败** → 整体 `execution.status='failed'`、其后 steps 标 `skipped`（`executeActions` fail-stop break + `execute()` `:559` 的 `hasFailed?'failed'`）。**无分支/循环/挂起**。
- 触发/动作白名单 + 递归guard：`packages/core-backend/src/multitable/automation-service.ts:45`（8 触发）/`:56`（~10 动作）/`:34`（`MAX_AUTOMATION_DEPTH=3`）/`:625`（深度 guard）。
- 调度：`packages/core-backend/src/multitable/automation-scheduler.ts`（内存 timer + Redis leader lock，**非持久队列**）。
- 持久化：`multitable_automation_executions`（`packages/core-backend/src/db/migrations/zzzz20260414100001_create_automation_executions_and_dashboard_charts.ts`），**无 trigger 快照、无 job 级挂起记录**。

**approval（DAG、有人工等待但不可复用）**：
- 图推进/会签或签/并行：`packages/core-backend/src/services/ApprovalGraphExecutor.ts`。
- 实例/动作/版本冻结：`packages/core-backend/src/services/ApprovalProductService.ts`（`published_definition_id` :1018/:2526；`adminJump` :2607；`approval_assignments` :818）。
- 动作集：`packages/core-backend/src/types/approval-product.ts:16` = `approve|reject|transfer|revoke|comment|return`（6 个；无加签）。
- SLA：`packages/core-backend/src/services/ApprovalSlaScheduler.ts`（仅 breach 标记，**无节点超时动作**）。
- 动态审批人：`packages/core-backend/src/services/ApprovalAssigneeResolver.ts`（static_user/role/requester/form_field_user）。

→ 两者都已经是「持久化 + 分步推进」，但 **automation 缺「等待并恢复」这一原语**，approval 的等待又被锁死在自己的领域里。

## 3. 目标模型：job 挂起/恢复（借 NocoBase 模式）

NocoBase 用**一个** Processor + 一套 job 状态把「等人 / 等时 / 等外部」统一成挂起/恢复（`references/` 亲验）：

- **状态枚举**：`references/nocobase/packages/plugins/@nocobase/plugin-workflow/src/server/constants.ts:10-30` —— `JOB_STATUS.PENDING=0`（:23）/ RESOLVED / REJECTED / ERROR / RETRY_NEEDED 等 9 态。
- **挂起**：节点 `run()` 返回 `PENDING` 并持久化 job，执行**停在那里**：delay `references/nocobase/packages/plugins/@nocobase/plugin-workflow-delay/src/server/DelayInstruction.ts:107/118`（`return null`+`status:PENDING`）；manual `references/nocobase/packages/plugins/@nocobase/plugin-workflow-manual/src/server/ManualInstruction.ts:109/121`（建 `workflowManualTasks`）。
- **恢复**：外部事件（timer / 用户动作）调 `workflow.resume(job)` → `Dispatcher.resume` `references/nocobase/packages/plugins/@nocobase/plugin-workflow/src/server/Dispatcher.ts:125` → `Processor` 从挂起的 job 续跑（delay `:95/:121`、manual `:138`）。
- **持久化**：`workflows`/`flow_nodes`/`executions`/`jobs`/`workflowManualTasks` collections。

**关键原语 = 「节点返回 PENDING + 持久 job + 外部事件 resume()」**。有了它，「等审批」「等定时」「等 webhook 回调」都是同一个机制的不同触发源。

## 4. 映射到 MetaSheet2（设计，不实现）

不照搬 NocoBase 的表，而是**在我们已有结构上引入挂起/恢复原语**：

| NocoBase | 我们的对应 | 落点（设计） |
|---|---|---|
| `execution` | automation `multitable_automation_executions` 行 / approval `approval_instances` 行 | 已有，加「可挂起」语义 |
| `job`（节点级、可 PENDING） | **新增** automation step 的持久化 job（今天 steps 只是 JSONB 结果，非可恢复实体） | 关键缺口：steps → 可恢复 job |
| `JOB_STATUS.PENDING` + `resume()` | **新增** automation 的「等待态 + 恢复入口」 | 关键缺口 |
| manual 节点 | **approval 实例**作为 automation 的一个挂起 job（automation 发起 approval → PENDING → approval 完成事件 resume） | = yida `start_approval` + event-bridge 的正解 |
| delay / schedule 恢复 | 复用 `packages/core-backend/src/multitable/automation-scheduler.ts` 的 leader-lock，但改为「到期 resume 持久 job」而非内存 timer 直跑 | 接 PLAN-Automation 持久队列方向 |

**兼容策略（设计原则）**：
1. **不破坏** approval 版本冻结（`published_definition_id`）—— approval 作为 automation 的 manual-job 时，仍走自己冻结的 runtime graph。
2. **automation 向后兼容** —— 现有线性 rule = 「无挂起节点的退化 DAG」，旧 execution 行不变；新增 job 表为可空/附加。
3. **统一状态模型** —— 参照 NocoBase 9 态收敛我们的 automation 4 态 + approval 动作态，便于统一观测（接 DF-N1 运行监控的思路）。

## 5. 分期 + gating（对齐 PLAN-Automation）

每一步都是**独立 opt-in**，且**全部 runtime 冻结至 GATE/解锁**：

| 阶段 | 内容 | 与 PLAN-Automation 对应 | gating |
|---|---|---|---|
| **C0** | 本 RFC（设计储备） | — | docs-only，**现在**（本文） |
| C1 | contract：job/挂起态的 schema + OpenAPI（不接 runtime） | A1 execution snapshot 的超集 | contract-first，单独 opt-in |
| C2 | automation 持久 job + PENDING + resume() runtime | A4/A5 retry 的地基 | **FROZEN**（GATE/解锁） |
| C3 | delay / wait 节点（最小挂起场景，无跨引擎） | PLAN-Automation 编排 | **FROZEN** |
| C4 | approval-as-job（automation `start_approval` + 完成事件 resume） | yida Phase 2 `start_approval`+event-bridge | **FROZEN**（且踩 approval Phase 2 冻结线，需双重解锁） |
| C5 | 分支/condition 节点（DAG 化） | yida Phase 3 编排节点 | **FROZEN** |

**顺序理由**：先 contract（C1，lock-safe）→ 再 automation 自身挂起（C2/C3，单引擎，风险低）→ 最后才碰 approval 收敛（C4/C5，跨引擎 + 撞 approval Phase 2 冻结，最重、最后）。

> **期望校准（别 skim 误读）**：C2/C3 单独**不等于**收敛 —— 它们只交付「挂起/恢复原语」，且大体是 PLAN-Automation A1–A5 的加厚版。**本 RFC 的头号价值（真正的双引擎收敛）落在 C4（approval-as-job）**，而 C4 恰是双重冻结、排在最后的一块。把 C2+C3 当成「已收敛」是误读。

## 6. 边界 / 风险

- **AGPL**：NocoBase 模式只借鉴，不抄码（#1879 §6.2）。
- **K3 lock**：C2 起全部 runtime 冻结。本文不改变任何冻结状态。
- **过度设计风险（诚实）**：这是 PoC 通过前的**储备**，价值在「趁源码读热捕获模型、re-derive 成本高」。若 K3 长期不 PASS，本 RFC 可能数月不动 —— 这是有意识的接受，不是承诺要建。
- **approval Phase 2 双重冻结**：C4（approval-as-job）同时踩 automation 编排 + approval 下游两条冻结线，再进入需**两边都解锁**，不能只凭本 RFC。
- **不与并行线冲突**：DF-N（数据工厂）是另一条 provenance/run 线；本 RFC 是流程引擎收敛，二者在「run/job 状态模型」上有概念交集，详设阶段需对照（非本文范围）。

## 7. 验证策略（解锁后才适用）
- C1 contract：schema round-trip 测试（参照 #1879 §9 风格的可重跑验证）。
- C2/C3：单引擎挂起/恢复的集成测试（创建→PENDING→外部事件→resume→完成），含 leader-lock 下不重复恢复。
- C4：approval 完成事件 → automation job resume 的端到端链路 + 版本冻结不被破坏的回归。

## 8. 来源（完整 workspace-relative 路径）
- 我方（亲验）：`packages/core-backend/src/multitable/automation-executor.ts:549,578`、`packages/core-backend/src/multitable/automation-service.ts:34,45,56,625`、`packages/core-backend/src/multitable/automation-scheduler.ts`、`packages/core-backend/src/services/ApprovalProductService.ts:818,1018,2526,2607`、`packages/core-backend/src/services/ApprovalGraphExecutor.ts`、`packages/core-backend/src/services/ApprovalSlaScheduler.ts`、`packages/core-backend/src/services/ApprovalAssigneeResolver.ts`、`packages/core-backend/src/types/approval-product.ts:16`、`packages/core-backend/src/db/migrations/zzzz20260414100001_create_automation_executions_and_dashboard_charts.ts`。
- NocoBase 模式（AGPL，仅借鉴；亲验）：`references/nocobase/packages/plugins/@nocobase/plugin-workflow/src/server/{constants.ts:10-30,Processor.ts,Dispatcher.ts:125}`、`references/nocobase/packages/plugins/@nocobase/plugin-workflow-delay/src/server/DelayInstruction.ts:95,107,118,121`、`references/nocobase/packages/plugins/@nocobase/plugin-workflow-manual/src/server/ManualInstruction.ts:109,121,138`。
- 上游：`docs/research/metasheet2-vs-teable-benchmark-20260525.md`（#1879，benchmark）+ 外部 `PLAN-Automation`（multitable automation 运行治理计划）。
