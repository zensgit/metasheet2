# Multitable Automation A6 Convergence Scout / Scope Gate — 2026-05-29

Status: docs-only scout / scope gate
Scope: A6 capability-half planning only
Runtime: not started
Companions:
- `docs/development/run-governance-forward-plan-20260528.md`
- `docs/development/multitable-automation-run-governance-todo-20260527.md`
- `docs/development/multitable-automation-a6-1-workflowjob-runtime-scout-20260530.md`
- `docs/research/approval-automation-convergence-rfc-20260526.md`

## Verdict

A6 can be opened only as a docs-only scout / scope-gate slice right now. A6
runtime remains frozen and demand-gated.

The next runtime step is not "build the workflow engine". The A6-1 persistent
`WorkflowJob` runtime scout is now recorded in
`multitable-automation-a6-1-workflowjob-runtime-scout-20260530.md`; runtime
still requires a separate implementation unlock with a feature flag /
compatibility gate and no default behavior change for existing automation rules.

This document records the sequence, boundaries, risks, and future test surface so
the next runtime unlock starts from a smaller, auditable shape.

## Grounding

Current `origin/main` already has the governance substrate:

- C1 `WorkflowJob` contract exists in
  `packages/core-backend/src/multitable/workflow-job-contract.ts`. It defines
  `queued/running/suspended/resolved/failed/skipped/rejected/errored`, suspend
  reasons, strict normalizers, and legacy status bridges.
- The automation runs API consumes C1 only at the read boundary:
  `packages/core-backend/src/routes/automation.ts` maps persisted steps with
  `toWorkflowJobView()` and accepts future statuses as legal empty filters.
- The automation executor is still linear and fail-stop:
  `packages/core-backend/src/multitable/automation-executor.ts` builds one
  `AutomationExecution`, runs `executeActions()` sequentially, and stops after
  the first failed action.
- A5 retry is whole-execution replay only:
  `packages/core-backend/src/multitable/automation-service.ts` re-runs the
  current enabled rule with the stored trigger event and stamps
  `rerunOfExecutionId` / `initiatedBy`.
- Approval already has its own graph runtime and parallel-state model in
  `packages/core-backend/src/services/ApprovalGraphExecutor.ts`; A6 must not
  collapse it into automation prematurely.
- The existing BPMN/Workflow Designer surface is a designer/product surface, not
  the automation execution engine. A6 must treat BPMN as compile/preview input,
  not as a fourth runtime.

## Scope Decision

This A6-0 slice is allowed to do:

- document the convergence sequence;
- name hard runtime gates and non-goals;
- define the first runtime scout shape;
- update run-governance TODO / forward-plan wording so future work has one
  canonical entry point.

This A6-0 slice must not do:

- add migrations or tables;
- add `automation_jobs` / `workflow_jobs` storage;
- add suspend/resume endpoints;
- add branch/parallel nodes;
- add BPMN import/compile code;
- add `start_approval`, approval trigger bindings, or approval completion event
  bridges;
- change existing automation execution, retry, or runs API behavior.

## A6 Decomposition

The dependency order is fixed, but it is not a schedule.

| Step | Name | First deliverable after opt-in | Gate |
|---|---|---|---|
| A6-0 | Scout / scope gate | This docs-only document | done by this slice |
| A6-1 | Persistent WorkflowJob runtime | design scout recorded; next is feature-flagged linear job persistence | named demand |
| A6-2 | Suspend/resume | external-event/webhook resume before delay/timer resume | named demand |
| A6-3 | Branch/parallel DAG | condition/parallel nodes with upstream/downstream graph fields | named demand |
| A6-4 | BPMN adapter | compile/preview + gap report only; no live BPMN runtime | named demand |
| A6-5 | Approval-as-job | `start_approval` + completion-event contract, then bridge | double-gated |

### A6-1 — Persistent WorkflowJob Runtime

Goal: persist per-step job state without changing default execution semantics.

The docs-only runtime scout is recorded in
`multitable-automation-a6-1-workflowjob-runtime-scout-20260530.md`. It recommends
a new `multitable_automation_jobs` table, rule-level opt-in, inline linear job
persistence, A1 redaction reuse, and A2/A3 mixed legacy/persisted rendering.
It does not start runtime.

Runtime unlock requirements:

- feature flag or explicit rule capability so existing fire-and-forget rules do
  not suddenly write one DB row per action;
- no branch, suspend, BPMN, or approval bridge in this slice;
- preserve existing `multitable_automation_executions` behavior and A2/A3
  response contract;
- reuse C1 statuses and `normalizeWorkflowJob()` instead of inventing another
  job vocabulary;
- inherit A1 redaction, A2 admin boundary, and A5 provenance conventions.

Primary risks:

- write amplification: every action becomes at least one durable write;
- transaction boundaries: side-effecting actions cannot be rolled back by the DB;
- compatibility: old rules and old execution rows must still render in A2/A3;
- observability drift: job rows must not create a second unredacted log plane.

### A6-2 — Suspend/Resume

Goal: let one persisted job enter `suspended` and resume from an external event.

Order:

1. external-event/webhook resume first;
2. delay/timer resume later.

Reason: delay resume introduces durable scheduling and leader/claim semantics.
External resume can validate the job/resume-token model before a scheduler owns
wakeups.

Non-goals:

- no in-memory timer for suspended jobs;
- no approval bridge yet;
- no branch/parallel yet.

### A6-3 — Branch/Parallel DAG

Goal: end the linear-only limitation once job persistence and resume are stable.

This is where graph fields belong:

- `upstreamJobId` / downstream edges;
- `branchIndex` or equivalent branch discriminator;
- branch join mode;
- branch result aggregation semantics.

This is also the real landing zone for BPMN gateways. Without A6-3,
`exclusiveGateway` / `parallelGateway` can only show as unsupported in an A6-4
gap report.

### A6-4 — BPMN Compile/Preview Adapter

Goal: use BPMN as a modeling/preview language, not as a runtime.

Allowed:

- parse a constrained BPMN subset;
- compile-preview into automation/approval definitions;
- return a gap report for unsupported nodes;
- prove that gateways map to A6-3 branch/parallel semantics.

Forbidden:

- live BPMN execution;
- a separate BPMN status model;
- a separate BPMN audit/log store;
- side-effecting compile preview.

### A6-5 — Approval-as-job

Goal: make an automation job start an approval instance and resume after the
approval completes.

This is the last A6 runtime step because it is the highest-risk crossing:

- approval remains the source of truth for approval graphs, assignments,
  records, permissions, and version freezing;
- automation stores only the waiting job and resume linkage;
- approval completion event contract must land before any bridge;
- rejection/return/cancel semantics must map to C1 statuses explicitly;
- no approval trigger bindings or result backwrite are pulled in implicitly.

## Re-entry Signals

A6 runtime may start only with a concrete demand such as:

- a DF/K3 pipeline needs `import -> validate -> wait for human approval -> export`;
- an external system callback must resume a paused automation after an async job;
- whole-execution retry proves too coarse and operators need step-level resume;
- a product workflow needs per-record branch/parallel execution with audit.

The phrase "continue automation" is not enough. The unlock should name which
A6 step is required and why A5/A3 cannot solve it.

## First Runtime Scout Template

When A6-1 is explicitly unlocked, the scout should answer before code:

1. What table shape is needed for persisted jobs, and can it be nullable /
   additive without migrating old executions?
2. Which rules opt into job persistence, and how is the feature flag stored?
3. What is the minimum worker/claim model, if any, for linear jobs?
4. How do job writes interact with side-effecting actions that cannot be rolled
   back?
5. Which A1 redaction helper is used for job result/error persistence?
6. How does A2/A3 render a mixed world of legacy `steps` and persisted jobs?
7. Which tests prove legacy rules are unchanged when the flag is off?

If those answers are not crisp, A6 runtime should not start.

## Required Test Surface After Runtime Unlock

### A6-1

- legacy automation execution still produces the same execution/log shape with
  the feature flag off;
- opt-in linear job persistence writes one job per action and maps statuses
  through C1;
- a failed action marks remaining actions consistently with current fail-stop
  semantics;
- job result/error persistence uses the same redaction invariant as executions;
- A2/A3 can render mixed old/new execution data.

### A6-2

- external event creates `suspended` job with a non-empty resume token;
- duplicate resume is idempotent or deterministically rejected;
- resume after job completion is rejected;
- invalid/expired token is rejected without leaking job details;
- delay/timer support, when later added, survives process restart.

### A6-3

- branch condition chooses exactly one branch;
- parallel fan-out creates independent jobs;
- join-all waits for all branches;
- join-any cancels or ignores siblings with explicit audit semantics;
- branch failures do not corrupt unrelated branch state.

### A6-4

- compile-preview is side-effect free;
- unsupported BPMN nodes return a deterministic gap report;
- supported gateway mappings are backed by A6-3 tests;
- no BPMN live execution route exists.

### A6-5

- `start_approval` creates a suspended automation job and one approval instance;
- approval approve/reject/return/cancel maps to C1 status without ambiguity;
- approval version freezing remains owned by approval;
- completion events resume exactly one waiting job;
- missing/deleted approval instance fails closed.

## Hard No

A6 must not:

- ship a monolithic engine rewrite;
- silently turn all existing automation rules into per-action DB writers;
- introduce a second status vocabulary beside C1;
- create unredacted job payload persistence;
- use BPMN as a live executor;
- fold approval state into automation tables;
- make approval-as-job the first runtime slice;
- treat post-GATE scoped K3 governance as a blanket unlock for workflow runtime.

## Current Recommendation

Stop after the A6-1 scout unless a named A6 runtime demand is provided.

The healthiest next technical action, when demand appears, is a small A6-1
runtime PR: feature-flagged persistent job runtime for linear automation, with
legacy rules unchanged by default. Anything beyond that is exciting, sharp, and
currently too large to sneak in through a side door.
