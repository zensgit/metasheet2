# Multitable Automation 运行治理开发计划（development MD · v2 · 2026-05-27）

> **Closeout update · 2026-05-28**：治理半已在 `origin/main` 闭环到 A3 + admin nav。落地链路：
> A0 scope gate / two-gate doctrine (#1932) → A1 execution snapshot + before-persist redaction (#1937) →
> A2 read-only runs API + C1 boundary mapping + admin-only gate (#1967 + #1973) →
> A3 admin runs view + navigation entry (#1975 + #1983). `#1917` 另补 dead-letter error secret scrub。
> 能力半未完成也未启动：A4 retry scope-gate 等显式需求；A5 retry runtime gated；A6 convergence-engine runtime
> frozen / demand-gated.
>
> **v2 定位**：在原“运行治理”线（A0–A5）基础上，折入复审敲定的修订，使本线**不偏科**且实现阶段不踩契约坑。
> v2 相对 v1 的实质变更（复审 Blocking/High 全部采纳）：
> 1. **Blocking 1**：steps 存储完全不动，C1 `WorkflowJob` 视图在 **A2 读边界**用 `toWorkflowJobView()` 合成（不持久化任何 job 子对象，不爬入冻结的 persistent-jobs 轨）。
> 2. **Blocking 2**：rule_snapshot / trigger_event **以及 `step.output`/`step.error`**（reviewer 漏掉、本人已核实的第三通道）一律**落盘前脱敏**；脱敏器**收敛为单一 multitable/core helper**（含归并 executor 现有的 DingTalk 专用 redactor），**不反向 import integration-core**。
> 3. **Blocking 3**：A0 docs-only=now；**A1/A2/A3 = S1 observability 具名解锁**（低风险但需显式 opt-in）；A5/A6 runtime gated/frozen。
> 4. **High 1 + rerun_of**：A1 **ultra-narrow** —— 只保留“现在就写真值”的列；`rerun_of_execution_id` 与 `initiated_by` **推迟到 A5**（retry 落地时才有写入者）。
> 5. **High 2**：A2 未来态 filter 合法但返回**空结果**（零 contract churn）。
>
> 配套：`multitable-automation-run-governance-todo-20260527.md`（同目录）。已落地依赖：C1 契约 `workflow-job-contract.ts`（PR #1889, not-wired）；收敛 RFC #1885。

---

## 0. 动机与非目标 — 两闸纪律（“不偏科”的定义）

本产品方向是 **ERP 集成平台**（K3/Data Factory）。强项（dry-run / 证据 / per-record provenance / redaction / dead-letter+replay / 交付就绪状态机）是**差异化 moat**；通用 workflow 引擎能力（branch/loop/suspend/DAG）是**被 OSS 商品化**的领域。因此 **“不偏科”不等于“把引擎能力补到和 OSS 对称”**。健康形状由两道闸长期维持：

- **需求闸**：任何流程**能力**上马前，必须能指出“哪个集成/产品用例逼我们要它”。没有具名用例 → 推迟。**能力按需求触发，不按对称触发。**
- **治理闸**：任何流程面**必须继承共享治理底座**（同一 run/job/status/provenance/redaction/replay 模型）。不继承 → 先修继承再谈能力。

> **关键非对称：能力可以偏科（战略），治理绝不能偏科。** 绝不允许“没 provenance / 没 replay / 没脱敏 / 状态词汇自成一套”的二等流程。

**本计划是“治理半”**：让自动化运行可观测、可审计、可诊断，**并保证未来引擎长出来时直接继承这套治理**。

**本计划明确不做（“能力半”，冻结 / 需求驱动 / 见 §A6）**：`approval_trigger_bindings` / `start_approval` / approval 完成事件桥；persistent `automation_jobs` **runtime**；suspend/resume、branch/parallel、cross-engine 编排；Workflow Designer / BPMN **live execution**。K3 stage-1 lock 仍有效；每项均为独立具名解锁。

---

## 1. Summary

推进 **multitable automation 运行治理**，不解锁 approval Phase 2 下游，不建引擎能力 runtime。

与原计划唯一实质差异：**数据模型对齐已落地的 C1 `WorkflowJobStatus`/`WorkflowJob` 词汇与 shape（边界映射，不改存储）**，使本线成为未来收敛引擎（§A6，冻结）的 substrate，而非将来要被替换的临时可观测层。

推进顺序：A0（docs-only，now）→ A1 → A2 → A3（**各为 S1 observability 具名解锁**）。

---

## 2. Lock 姿态（按里程碑）

| 里程碑 | 内容 | 锁姿态 |
|---|---|---|
| A0 | docs scope gate + TODO + 两闸纪律 | ✅ **docs-only，now** |
| A1 | execution 快照字段（含落盘前脱敏）+ 边界映射准备 | 🟡 **S1 observability 具名解锁**（加 nullable 列 + executor 脱敏，低风险但需显式 opt-in） |
| A2 | 只读 runs/detail API + `toWorkflowJobView` 映射 | 🟡 **S1 observability 具名解锁**（新只读 route） |
| A3 | 前端只读 runs view | 🟡 **S1 observability 具名解锁**（新只读 UI） |
| A4 | retry scope gate（design only） | ✅ docs；**runtime 🔒 gated** |
| A5 | whole-execution retry runtime（+ `rerun_of`/`initiated_by` 列） | 🔒 **gated**（retry = 未来 resume 的退化特例） |
| A6 | 能力半 bridge（design only） | ✅ docs；**所有 runtime 🔒 frozen / 需求驱动** |

> 复审纪律：A1/A2/A3 虽属低风险只读/可观测，**仍是 named unlock，不写成“自然 lock-safe / 只读不用审”**（staged-opt-in）。

---

## 3. Key Changes

### A0 — Docs-only Scope Gate + TODO

新增两份文档：

- `docs/development/multitable-automation-run-governance-development-20260527.md`（本文件）
- `docs/development/multitable-automation-run-governance-todo-20260527.md`

锁定：本线只覆盖 run governance（治理半）；记录 §0 两闸纪律；显式登记“能力半”为冻结/需求驱动另一轨（引用 #1885/#1889）；retry 必须单独 scope gate（A4）。

验收：docs-only diff；无 runtime/migration/route/UI 变更。

### A1 — Execution Snapshot Foundation（ultra-narrow + 落盘前脱敏）

**迁移：给 `multitable_automation_executions` 加列（仅“现在就写真值”的列）：**

- `sheet_id TEXT`
- `trigger_event JSONB`（**redacted**）
- `rule_snapshot JSONB`（**redacted**）
- `finished_at TIMESTAMPTZ NULL`
- `schema_version INT NOT NULL DEFAULT 1`

**不在 A1 加**（推迟到 A5 retry，届时才有写入者，避免 nullable 语义债）：

- ~~`rerun_of_execution_id`~~ → A5
- ~~`created_by` / `initiated_by`~~ → A5（且只有当 execute path 能准确传入操作者时才加）

**steps 存储：完全不动，保持 legacy `AutomationStepResult[]`。** 不持久化 `workflowJob` 子对象，不加 `upstreamStepKey`/`branchIndex`（graph 字段挪 §A6，现在不加用不上的列）。

**落盘前脱敏（Blocking 2，含本人核实的第三通道）：**

写入前对以下三处一律脱敏（**不在 read 时脱敏 —— 那太晚**）：

1. `rule_snapshot`（`send_webhook` config 的 `headers.authorization` / URL query token / `secret` 等）
2. `trigger_event`
3. **`step.output` / `step.error`** ← reviewer 的 Blocking 2 漏掉、已核实：今天 executor 只有 **DingTalk 专用** redactor（`automation-executor.ts:215 redactDingTalkFailureAlertText`，仅 DingTalk 失败路径），`step.output`（含 `responseBody`，:742/:765）与通用 `step.error` **裸落盘**；契约第 26 行明写 result 须“sanitised before persistence by the runtime”。新 runs view 会把它们当 `result`/`error` 暴露，**只脱 snapshot 不脱 output = 泄漏搬家**。

**脱敏的范围与边界（本人补的精确化）：**

- 脱敏 = **抠 secret 形状的值**（token / Authorization / Bearer / JWT / conn-string / `access_token` / `secret` / `SEC…` 等），**保留诊断所需的业务字段值**（trigger record 的业务字段是快照的用途所在，不能抹掉）。
- **业务字段 / PII 的遮罩是另一回事**（与可诊断性有取舍）→ **标为 A4 gate 的开放问题，A1 不静默决定。**
- **脱敏器收敛为单一 multitable/core helper**：优先复用 support-packet 已有的脱敏 util；不够通用则提一个 **core shared redaction helper**，并**归并** executor 现有的 DingTalk 专用 redactor（消除“第三套脱敏器”）。**禁止反向 import `integration-core/lib/payload-redaction.cjs`**（domain 边界）。
- 仅前向：已存在的旧行保持原样（不回填），新行脱敏。

**status 存储不动**：物理仍 legacy `running|success|failed|skipped`（避热路径重写 + 重迁移）；C1 词汇只在边界映射（见 A2）。

行为：`AutomationService.executeRule()` 接收/传递 `sheetId`、`triggerEvent`、当前 rule snapshot；`AutomationLogService.record()` 保存 redacted snapshot + `finished_at` + `schema_version`；现有 logs/stats API 兼容；旧行空字段安全展示（`schema_version` 默认 1）。

### A2 — Read-only Automation Runs API（+ `toWorkflowJobView` 边界映射）

新增只读 API：

```http
GET /api/multitable/automation-executions?sheetId=&status=&ruleId=&limit=
GET /api/multitable/automation-executions/:executionId
```

**execution status 输出**：经 `legacyAutomationStatusToJobStatus()` 映射为 `WorkflowJobStatus`（`success → resolved`，其余 identity）；可附带 `statusLegacy` 原始值供诊断。

**steps 输出 — 读边界映射器 `toWorkflowJobView(execution, step, index)`（Blocking 1 定稿）：**

```ts
function toWorkflowJobView(execution, step, index) {
  return {
    id: `${execution.id}:step:${index}`,
    executionId: execution.id,
    stepKey: String(index),                              // 不把 actionType 当 identity（同类型动作会重复）
    status: legacyAutomationStatusToJobStatus(step.status), // 直接调用；step.status 是 LegacyAutomationStatus 的子集，无需三元
    upstreamJobId: index > 0 ? `${execution.id}:step:${index - 1}` : null,
    result: step.output,   // A1 已在落盘前脱敏
    error: step.error,     // A1 已在落盘前脱敏
  }
}
```

> 清理点（已核实）：`LegacyAutomationStatus = AutomationExecution['status']` 含 `running`，而 `step.status` 仅 `success|failed|skipped`（子集），故 `legacyAutomationStatusToJobStatus(step.status)` 直接通过，**不需要** `step.status === 'success' ? …` 那种 no-op 三元。

**status filter 方向性 + 未来态行为（High 2）：**

- `status=`：**C1 `WorkflowJobStatus` 为规范值**；legacy 4 态仅作迁移宽限接受（内部归一）；文档/SDK 只宣传 C1 值。
- 未来态 `queued/suspended/rejected/errored`（当前无行可命中）：**合法但返回空结果**（不是 400）；A6 落地后同一 filter 自动有结果，**零 contract churn**。

返回字段：execution 基础字段、`status`(C1)/`statusLegacy`、steps（经 `toWorkflowJobView` 映射）、trigger_event(redacted)、rule_snapshot 摘要(redacted)、finished_at、schema_version。`limit` clamp 到 1..200；missing → 404；不新增 retry / 不新增 support-packet backend endpoint。

### A3 — Frontend Runs View（read-only）

在现有 automation manager/log viewer 上增加只读 runs list：按 status/rule/sheet 筛选；展示 status（**label 取自共享 `WorkflowJobStatus` i18n 词条**）、rule name/id、triggeredBy、duration、finished_at、error；可展开 steps（C1 视图）；复用现有 support-packet builder；**不提供 Retry 按钮**（或 disabled “retry requires next gate”）。

### A4 — Retry Scope Gate（后续 PR · design only）

只做设计，不写 runtime。锁定 retry 语义：仅 failed/skipped；复用原始 `trigger_event`；用 `rule_snapshot` 还是当前 rule 在 gate 决定（默认 `rule_snapshot`）；新 execution id；写 `rerun_of_execution_id`；外部副作用动作需用户确认或 idempotency key。**声明 retry = 未来 resume 的退化特例**（A6 落地后复用 resume 路径）。**并决定 §A1 标记的 business-field/PII 遮罩开放问题**（retry 重放是否暴露/遮罩业务数据）。

### A5 — Whole-execution Retry（后续 PR · runtime 🔒 gated）

```http
POST /api/multitable/automation-executions/:executionId/retry
```

**本里程碑迁移加列**：`rerun_of_execution_id TEXT NULL`、`initiated_by TEXT NULL`（此时才有写入者）。从 `rule_snapshot` 重建 executor rule；复用 `trigger_event`；持久新 execution；`rerun_of_execution_id` 回链。不做步骤级 retry。**runtime 受锁，需具名解锁。**

### A6 —（新增 · design only · 冻结 / 需求驱动）能力半 Bridge

> 只登记与对齐，不实现任何 runtime。让本治理线显式成为“能力半”的 substrate。

**能力半 = 收敛引擎**（顺序见 RFC #1885，每步独立需求闸 + GATE）：

1. **持久 WorkflowJob runtime**：automation 每 action 变可持久 job（wire C1 #1889）。**风险**：热路径重写（每 action 一次 DB 写 = 写放大 + 事务性 + 旧规则兼容）→ 必带 flag/向后兼容。
2. **suspend/resume**：**先 webhook/外部事件 resume，后 delay/timer resume**（delay 逼出持久调度；内存 timer 重启丢挂起 job —— 此即 persistent job queue 不可再推迟点）。
3. **branch/parallel（DAG）**：补“线性”那一半；此处才加 `upstreamStepKey/branchIndex` 等 graph 字段。**BPMN gateway 的真实落点。**
4. **BPMN adapter/simulator**：限定子集（start/end/userTask/serviceTask/exclusiveGateway/parallelGateway），只做 compile-preview/校验报告；**永不接 live execution**（否则第四套状态孤岛）。
5. **approval-as-job**：`start_approval` + approval completion event bridge；**completion event contract 先行**；排在 automation suspend/resume 成熟之后。

**Approval 自身**：不改造成 BPMN runtime；保留 `published_definition_id` 冻结 graph / `approval_assignments` / `approval_records`。解锁后优先：SLA timeout action、delegation/add-sign（冻结产品面，单独解锁）、completion event contract。

**治理继承断言（硬契约）**：上述任一能力落地时，**必须复用本线的 run/job/status/provenance/redaction/replay 模型**（对齐 C1 + DF observability borrow），不得新建二等可观测层。

---

## 4. Test Plan

A0：`git diff --name-only` 仅 docs；grep 确认未碰 runtime。

A1：
- `AutomationLogService.record()` 与 row mapper 单测（含 finished_at/schema_version）。
- 新列 nullable/defaulted 迁移测试。
- **脱敏测试**：构造带 `Authorization` header / token URL 的 `send_webhook` rule + 带 `responseBody`(含 token) 的 step.output + 带 conn-string 的 step.error → 断言 DB 落盘值已 scrub，**且业务字段值保留**。
- **单脱敏器测试**：断言无新增第二/第三套 redactor；DingTalk 路径走收敛后的同一 helper。
- 旧行（null 快照字段）安全映射。

A2：
- list/detail/filter/limit/not-found route 测试。
- **`toWorkflowJobView` 输出过 `normalizeWorkflowJob()`**（不是 DB step 原文过）。
- 断言 execution `status` 为 C1 值（`success → resolved`）。
- 断言 `status=` 同时接受 C1 与 legacy，且**未来态返回空结果（非 400）**。
- 现有 per-rule logs/stats/test shape 不变。

A3：runs list 渲染 + step 展开 web 测试；status label 取自共享 `WorkflowJobStatus` i18n；现有 `MetaAutomationLogViewer.spec.ts` / support-packet specs 通过。

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/automation-v1.test.ts \
  tests/unit/automation-routes-wiring.test.ts \
  tests/unit/workflow-job-contract.test.ts

pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/MetaAutomationLogViewer.spec.ts \
  tests/automation-log-support-packet.spec.ts
```

---

## 5. Assumptions

- 下一个 PR 是 A0 docs-only；首个 runtime PR 是 A1（非 retry），**且 A1/A2/A3 各需 S1 named unlock**。
- automation 路由保持 flat 响应风格。
- A1 新列仅含“现在写真值”的列；`rerun_of`/`initiated_by` 随 A5 落地。
- **C1 `WorkflowJobStatus` 是唯一状态词汇**；本线映射到它，绝不另 fork。
- **脱敏在落盘前**，收敛为单一 multitable/core helper，不反向 import integration-core；secret-scrub 保留业务字段，业务/PII 遮罩留 A4 决定。
- **能力半（A6）frozen/需求驱动**；治理继承是硬契约。
- Approval Phase 2 下游冻结至 K3 GATE PASS 或具名解锁。

---

## 修订差异速览（v1 → v2）

| 维度 | v1 | v2 |
|---|---|---|
| steps 前向兼容 | “持久化 superset / 过 normalize”（不自洽） | **存储不动；A2 `toWorkflowJobView` 读边界合成；测断映射器输出** |
| graph 字段 | A1 预留 upstreamStepKey/branchIndex | **删，挪 A6** |
| 脱敏 | 仅泛提“继承 redaction” | **落盘前脱 rule_snapshot+trigger_event+step.output/error；单脱敏器收敛；secret-only 保业务字段；PII 遮罩留 A4** |
| A1 字段 | sheet_id/trigger_event/rule_snapshot/rerun_of/created_by/finished_at/schema_version | **ultra-narrow：去 rerun_of+created_by（→A5），其余保留** |
| 锁姿态 | A2/A3“现在可做” | **A1/A2/A3 = S1 named unlock（非自然 lock-safe）** |
| status filter | “接受两种” | **C1 规范+legacy 宽限；未来态合法但空结果** |
| status 映射 | 表述含 no-op 三元风险 | **直接 `legacyAutomationStatusToJobStatus(step.status)`（已核实子集）** |
