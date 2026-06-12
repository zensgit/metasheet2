# Multitable Automation A6-3-4 Parallel Fan-Out + Join-All Scope Gate - 2026-06-11

Type: **A6-3-4 docs-only scope-gate**.

Grounded on: `origin/main@699a1b15`.

Status refresh (2026-06-12): **runtime/editor/runs-readability landed** via
#2496 (`b161080b8`), #2500 (`4408239d0`), and #2501 (`88f5f538a`). This document
now serves as the historical contract for that slice; `join_any`, branch-local
waits, nested branches, BPMN, approval coupling, and public webhook emitters
remain out of scope / demand-gated.

Companion:

- `docs/development/multitable-automation-a6-3-branch-parallel-design-20260605.md`
- `docs/development/multitable-automation-a6-execution-plan-20260601.md`
- `docs/development/multitable-automation-run-governance-todo-20260527.md`
- `docs/development/workflow-automation-completion-plan-20260609.md`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/src/multitable/automation-job-service.ts`
- `packages/core-backend/src/multitable/automation-actions.ts`
- `apps/web/src/multitable/utils/conditionBranchAuthoring.ts`

## 0. Verdict

A6-3-4 was scoped as the next automation graph rung and later landed as
**fan-out + join-all only**.

The runtime PR may add a `parallel_branch` action that runs all configured
branches, records branch child jobs in the existing C1 job plane, and continues
only after all branches are terminal.

It must **not** add `join_any`, cancellation semantics, branch-local waits,
nested branches, BPMN, approval coupling, public webhooks, or a new workflow
runtime.

## 1. Current Code Facts

| ID | Fact | Evidence |
|---|---|---|
| F1 | A6-3-1 `condition_branch` landed exclusive first-match/default branch runtime. It reuses the C1 job plane and nested step keys for selected child jobs. | `automation-executor.ts`; `automation-job-service.ts`; `multitable-automation-a6-3-branch-parallel-design-20260605.md` |
| F2 | A6-3-2 frontend can author only flat branch conditions and the `update_record` / `send_notification` subset; richer branch shapes open read-only rather than flattening. | `conditionBranchAuthoring.ts`; `MetaAutomationRuleEditor.vue` |
| F3 | A6-2 suspend/resume still uses a top-level cursor and explicitly defers branch-local wait/nesting. | `multitable-automation-a6-2-suspend-resume-design-20260603.md` |
| F4 | The current executor is still effectively inline/sequential. A6-3-4 can model fan-out/fan-in in the job graph without promising worker-level concurrent execution. | `AutomationExecutor` |
| F5 | A6-4 BPMN preview depends on branch/parallel semantics. Without A6-3-4, BPMN parallel gateways must remain gap-report only. | `workflow-automation-completion-plan-20260609.md` |

## 2. Scope

### In Scope For A6-3-4

- Add one canonical action type: `parallel_branch`.
- Run every configured branch exactly once.
- Support only `joinMode: 'all'`.
- Persist a parent parallel job plus branch child jobs in the existing
  `multitable_automation_jobs` C1 plane.
- Continue to the next top-level action only after every branch is terminal.
- Fail the parent and execution if any branch fails.
- Continue sibling branches after one branch fails, so `join_all` still means
  every configured branch is attempted.
- Mark top-level downstream actions skipped when the parent fails.
- Preserve branch child outputs/errors through existing A1 redaction.
- Add backend real-DB tests for C1 lineage and failure/skip behavior.

### Out Of Scope

- `join_any` or first-winner cancellation.
- True worker-concurrent branch execution.
- Delay/timer resume.
- `wait_for_callback` inside parallel branches.
- `condition_branch` nested inside parallel branches.
- `start_approval` inside parallel branches.
- Approval result backwrite.
- BPMN parse/compile/preview.
- Public webhook endpoints or token emitters.
- New workflow runtime tables outside the automation job plane.
- New status vocabulary outside C1.

## 3. Action Contract

Recommended v1 config:

```ts
type ParallelBranchConfig = {
  joinMode: 'all'
  branches: Array<{
    key: string
    label?: string
    actions: AutomationAction[]
  }>
}
```

Rules:

1. `branches` must be a non-empty array.
2. Branch keys must be non-empty, unique, deterministic-id-safe strings.
3. `joinMode` must be exactly `all` in A6-3-4.
4. Every branch must contain at least one action.
5. Branch action types must be a minimal safe subset for v1. Recommended first
   subset: `update_record` and `send_notification`, matching A6-3-2 authoring.
6. `wait_for_callback`, nested `condition_branch`, nested `parallel_branch`,
   and `start_approval` must be rejected in A6-3-4.

The runtime PR may narrow the branch action subset further, but it must not
widen beyond this contract without updating this scope gate.

## 4. Runtime Model

A6-3-4 should be graph-shaped but may run inline in v1.

Recommended sequence:

1. Parent `parallel_branch` job starts as `running`.
2. Each configured branch is selected. There is no condition filter in A6-3-4;
   all branches run.
3. Branches run independently in the job graph. Inline execution is acceptable
   if the persisted graph still represents fan-out/fan-in.
4. Branch child jobs settle independently.
5. If all branch tails resolve, the parent settles `resolved` and the next
   top-level action upstreams from the parent.
6. If one branch fails, the rest of that branch settles according to fail-stop
   semantics, but sibling branches still run to terminal state.
7. After every branch is terminal, the parent settles `failed` if any branch
   failed; downstream top-level actions settle `skipped`.

The parent job is the join point. Do not model join-all by simply appending one
branch after another into the linear chain without explicit branch lineage.
The existing schema has a singular `upstream_job_id`, so v1 should model fan-in
by settling the parent join job only after all child branches are terminal and
by recording child job ids / branch summaries in parent output. Do not add a
second workflow table or status plane.

## 5. Job Identity And C1 Graph

Reuse the existing `multitable_automation_jobs` table.

Recommended deterministic ids:

```text
parent: ${executionId}:job:${stepIndex}
child:  ${executionId}:job:${stepIndex}:parallel:${branchKey}:${actionIndex}
```

Recommended step keys:

```text
parent: ${stepIndex}
child:  ${stepIndex}.parallel.${branchKey}.${actionIndex}
```

`upstream_job_id`:

- Parent upstream is the previous top-level job.
- First child in every branch upstreams to the parent job.
- Later children in the same branch upstream to the previous child in that
  branch.
- The next top-level job upstreams to the parent join job, not to an arbitrary
  child.

Parent job output should include:

```json
{
  "joinMode": "all",
  "branchCount": 2,
  "childJobIds": ["axe_1:job:0:parallel:ops:0"],
  "resolvedBranchKeys": ["ops", "finance"],
  "failedBranchKeys": [],
  "skippedBranchKeys": [],
  "branchStatuses": {
    "ops": "resolved",
    "finance": "resolved"
  }
}
```

Runs view may later group children under the parent using `stepKey`, but the
backend contract remains the C1 job list.

## 6. Failure Semantics

| Case | Required behavior |
|---|---|
| Invalid branch config | Reject at rule save/update, not at runtime. |
| Branch action fails | That child job fails; later actions in the same branch are skipped; sibling branches still run; parent fails after every branch is terminal; execution fails; downstream top-level actions skipped. |
| Branch action throws after side effects | Failure is recorded; no automatic rollback of already-run branch side effects. |
| One branch fails before sibling branches run | Sibling branches still run. `join_all` must not short-circuit the whole fan-out on the first failed branch. |
| Multiple branches fail | Parent output lists all observed failed branch keys. |
| All branches succeed | Parent resolves and execution continues. |
| Branch list empty | Reject at rule save/update. |
| Branch contains forbidden action | Reject at rule save/update. |

## 7. Side Effects And Ordering

Because v1 may execute inline, A6-3-4 must be honest about ordering:

- It may call the feature "parallel fan-out" because the persisted C1 graph fans
  out, but it must not claim worker-level concurrent execution unless branches
  truly run concurrently.
- If branch order is deterministic array order, document and test that order.
- If a later action in the same branch is skipped because an earlier branch
  action failed, the skipped job must make that explicit.
- Side effects from already-run successful branches are durable even if a later
  branch fails.
- All branches should read the same trigger event and rule snapshot captured for
  the execution. V1 must not promise sibling branches observe each other's
  writes unless a later runtime deliberately adds that contract.
- A5 whole-execution retry remains the only retry mechanism in scope. It reruns
  the whole execution with confirmation and must create a new execution/job
  graph; A6-3-4 must not add automatic branch-only retry.
- A6-2 / W6 resume remains top-level-cursor based. A6-3-4 must not introduce
  branch-local resume tokens, branch-local `start_approval`, or nested
  suspension cursor semantics.

## 8. Redaction And Observability

Parent and child job output may include:

- branch key;
- branch label;
- join mode;
- child action type;
- updated field ids or notification ids already allowed by those action outputs;
- aggregate lists of resolved/failed/skipped branch keys.

Output must not include:

- full record data;
- hidden field values;
- notification message bodies if existing action redaction excludes them;
- automation credentials or full rule snapshot;
- approval data.

All output must continue through existing A1 redaction and C1 normalization.
Do not add a branch-specific redactor or an unredacted branch input/result cache.

## 9. Validation Requirements

Service-level validation is mandatory. Route-level validation is not enough.

Validate:

- `parallel_branch` exists in the canonical action registry and database CHECK
  constraint.
- `parallel_branch` requires `execution_mode='workflow_job_v1'`.
- `branches` is non-empty.
- branch keys are unique and deterministic-id-safe.
- branch actions are in the allowed A6-3-4 subset.
- action configs inside branches pass the same validation used for top-level
  actions.
- branch count and total branch-action count are bounded by tested runtime
  limits, or the runtime PR explicitly proves it reuses an existing bounded
  automation action limit. Unbounded fan-out is not allowed.
- forbidden nested actions are rejected:
  - `wait_for_callback`;
  - `condition_branch`;
  - `parallel_branch`;
  - `start_approval`.

## 10. Test Matrix For A6-3-4

| ID | Test | Risk covered |
|---|---|---|
| T1 | Create/update rejects `parallel_branch` unless `executionMode='workflow_job_v1'`. | Legacy path cannot half-run graph jobs. |
| T2 | Valid two-branch `join_all` rule persists and executes. | Happy path. |
| T3 | All branches run exactly once; non-branch top-level next action runs after parent resolves. | Join-all success semantics. |
| T4 | Parent job has correct C1 output and child job `stepKey`/`upstreamJobId` fan-out shape. | Observability graph. |
| T5 | Failure in one branch still lets sibling branches run to terminal; parent fails only after all branches are terminal; downstream top-level actions are skipped. | Join-all failure semantics. |
| T6 | Failure inside one branch skips the rest of that branch while sibling branches still run. | Branch-local fail-stop. |
| T7 | Duplicate/retry execution does not duplicate jobs within one execution. | Idempotency inside job plane. |
| T8 | A5 whole-execution retry reruns the whole execution with confirmation and creates a new execution/job graph; there is no automatic branch-only retry. | Retry/provenance boundary. |
| T9 | Branch config containing `wait_for_callback`, nested `condition_branch`, nested `parallel_branch`, or `start_approval` is rejected at save time. | Boundary enforcement. |
| T10 | Redaction test proves parent/child job outputs exclude full record data, credentials, approval data, and hidden values. | Privacy. |
| T11 | Real-DB integration traverses opt-in rule trigger -> parallel parent -> branch children -> join-all parent resolution. | Wire-vs-fixture seam. |
| T12 | Admin runs detail can render the C1 job list without a second read model. | A2/A3 compatibility. |

At least one test must use the actual `AutomationService.executeRule()` path and
the actual job persistence path. Hand-built job fixtures alone are not enough.

## 11. Frontend Posture

No frontend builder is required in the first backend runtime PR unless the owner
explicitly asks for it.

The first frontend slice, when opened, should:

- use a form-based branch list, not a canvas;
- lock `workflow_job_v1` when `parallel_branch` is present;
- enforce the same action subset as the backend;
- show parent + branch child jobs in Admin runs;
- open richer/unknown loaded parallel shapes read-only rather than flattening.

## 12. Runtime Red Lines

A6-3-4 must not:

- add `join_any`;
- add cancellation semantics;
- add branch-local wait/resume;
- add nested branches;
- add approval start/backwrite inside parallel branches;
- add BPMN parse/compile/runtime;
- add public webhooks;
- create a second job/read/audit model;
- invent statuses outside C1;
- silently run in legacy/non-job rules.

## 13. Completion Criteria

W3-0 is complete when this docs-only scope gate is merged.

A6-3-4/W3-1 runtime is complete because:

1. Runtime PR #2496 landed `parallel_branch` with `joinMode: 'all'` under this
   contract.
2. Real-DB tests prove fan-out/fan-in C1 job shape and fail/skip behavior.
3. Admin runs can explain parent/child jobs without leaking sensitive data via
   #2501; editor authoring landed via #2500.
4. `workflow-automation-completion-plan-20260609.md`,
   `multitable-automation-run-governance-todo-20260527.md`, and
   `multitable-automation-a6-execution-plan-20260601.md` now mark W3-1 runtime
   landed.
