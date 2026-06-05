# Multitable Automation A6-3 Branch / Parallel DAG Design-Lock (2026-06-05)

Status: **A6-3-0 design-lock / scope gate**

Runtime: **not started**

Grounded on: `origin/main@83801c668`
Companions:

- `docs/development/multitable-automation-a6-convergence-scout-20260529.md`
- `docs/development/multitable-automation-a6-execution-plan-20260601.md`
- `docs/development/multitable-automation-a6-2-suspend-resume-design-20260603.md`
- `docs/development/multitable-automation-a6-2-suspend-resume-verification-20260603.md`
- `docs/development/multitable-automation-run-governance-todo-20260527.md`

## 0. Verdict

A6-3 can be opened as the next automation-only capability rung, but **only as
this docs-only design-lock first**. Runtime remains a separate explicit opt-in.

The first runtime slice must be **A6-3-1 `condition_branch` / exclusive branch
v1**, not full parallel DAG. Parallel fan-out and join semantics are important,
but they are a larger executor rewrite and should land after the branch
representation, C1 job view, and skip semantics are proven on real Postgres.

This slice must not pull in approval, BPMN, attendance, data-factory, K3, public
webhooks, or a new workflow designer runtime. It is automation-only.

## 1. Current Code Grounding

The current runtime has enough foundation for A6-3, but it is still linear:

- `AutomationExecutor.executeActions()` runs `rule.actions` by array index,
  sequentially, and stops after the first failed action.
- `wait_for_callback` is the only non-linear-ish step today. It suspends in
  opted-in `workflow_job_v1` rules and resumes from `suspendIndex + 1`.
- `AutomationJobService.lifecycleFor()` writes deterministic job ids as
  `${executionId}:job:${stepIndex}` and uses `upstream_job_id` as the previous
  step's job id. That is currently a linear chain.
- `AutomationJobService.listByExecution()` returns C1 WorkflowJob views and
  hydrates suspend descriptors for `suspended` jobs.
- `workflow-job-contract.ts` already has the needed C1 vocabulary:
  `queued/running/suspended/resolved/failed/skipped/rejected/errored`.
- `automation-conditions.ts` already supplies the condition evaluator used by
  rule-level filters. A6-3 should reuse it for branch predicates.
- A2/A3 admin runs detail already prefers persisted jobs when present. A6-3
  should extend that job plane rather than adding a second observability plane.

## 2. Hard Boundaries

A6-3-0 / A6-3-1 must not:

- add approval trigger bindings, approval result backwrite, `start_approval`, or
  approval completion events;
- add BPMN parse/compile/live execution;
- add public webhook endpoints or token emitters;
- add delay/timer resume, worker queues, or scheduler ownership changes;
- touch attendance, K3, data-factory, PLM, or approval-center runtime;
- change default behavior of existing legacy rules;
- invent statuses outside C1;
- persist unredacted branch inputs/results;
- introduce a new `workflow_*` runtime table outside the automation job plane.

## 3. Decomposition

### A6-3-0 — Design-lock (this PR)

Docs-only. Defines the staged shape and test bar. No runtime.

### A6-3-1 — `condition_branch` / exclusive branch v1

Goal: allow one automation rule to choose exactly one branch based on
conditions, then run that branch's actions and continue to the next linear step.

This is the first useful non-linear behavior and the smallest safe runtime
step.

### A6-3-2 — Branch editor + runs-detail visibility

Frontend support for the branch node and clearer admin run detail display.
This can be stacked after A6-3-1 or merged in the same runtime wave only if the
backend contract is already locked and tests are green.

### A6-3-3 — Branch-local suspend/resume cursor

Allow `wait_for_callback` inside a selected branch. This is not part of
A6-3-1 because current A6-2 stores `step_index` as a top-level integer cursor;
nested branch resume needs a stable `step_key` / branch cursor and a rule-drift
fingerprint for that nested path. Keep this as a separate sub-rung so exclusive
branch v1 does not smuggle in a suspension schema change.

### A6-3-4 — Parallel fan-out + `join_all`

Run multiple branches independently and continue only after all selected
branches finish. This is a separate runtime opt-in after exclusive branch v1.

### A6-3-5 — `join_any` / cancellation semantics

Only after `join_all` is stable. `join_any` needs explicit audit for ignored or
cancelled sibling branches, so it should not be bundled into the first parallel
slice.

## 4. A6-3-1 Shape

### 4.1 Action type

Add a new canonical action type:

```ts
condition_branch
```

Its config should be the only new runtime shape in A6-3-1:

```ts
type ConditionBranchConfig = {
  branches: Array<{
    key: string
    label?: string
    conditions: ConditionGroup
    actions: AutomationAction[]
  }>
  defaultBranch?: {
    key: string
    label?: string
    actions: AutomationAction[]
  } | null
}
```

Rules:

- Branch keys are stable non-empty strings and unique within the node.
- Branch conditions are evaluated in array order.
- The first matching branch wins.
- If no branch matches and `defaultBranch` exists, run it.
- If no branch matches and there is no default, the branch node resolves with no
  branch actions and is treated as a successful no-op with explicit output
  `{ selectedBranchKey: null }`.
- Only branch actions run; non-selected branch actions are represented as
  skipped jobs only if the branch action is opted into persisted jobs and the
  implementation can do so without fabricating side effects. If that cannot be
  represented cleanly in A6-3-1, non-selected branch internals stay absent and
  the parent branch job records the selected branch.

### 4.2 Execution semantics

For an opted-in `workflow_job_v1` rule:

1. The `condition_branch` parent job starts as `running`.
2. Conditions evaluate against the same `context.recordData` used by existing
   rule conditions.
3. The selected branch actions run sequentially with the same fail-stop
   semantics as top-level actions.
4. If a selected branch action fails, the parent branch job settles `failed` and
   the top-level execution fails; later top-level actions are skipped.
5. A6-3-1 rejects `wait_for_callback` inside branch actions. Branch-local
   suspend/resume is A6-3-3 because it needs a nested resume cursor rather than
   the current A6-2 top-level `step_index` integer.

For a legacy / opt-out rule:

- A6-3-1 should fail closed rather than silently emulate branches without the
  persisted job plane. A `condition_branch` action in a legacy rule returns a
  failed step explaining that it requires `execution_mode='workflow_job_v1'`,
  and remaining actions are skipped.

This mirrors the `wait_for_callback` precedent.

### 4.3 Job identity

A6-1 currently uses numeric `step_key` values (`"0"`, `"1"`, ...). A6-3-1
needs stable nested keys without a new table:

- Top-level job id remains `${executionId}:job:${stepIndex}`.
- Top-level branch parent `step_key` remains the top-level index, e.g. `"2"`.
- Selected branch child jobs use a nested step key:

```text
2.branch.<branchKey>.<actionIndex>
```

and deterministic ids:

```text
${executionId}:job:2:branch:${branchKey}:${actionIndex}
```

`upstream_job_id`:

- The branch parent upstream is the previous top-level job.
- The first selected branch child upstream is the branch parent job.
- Later selected branch children upstream to the previous child.
- The next top-level job upstreams to the last selected branch child, or to the
  branch parent if no branch action ran.

This keeps A2/A3 on the existing C1 job list shape while making the graph
visible.

### 4.4 Read view

A2/A3 must not invent a separate branch model for A6-3-1. The persisted jobs
list remains the source:

- Branch parent job `result` includes:

```json
{
  "selectedBranchKey": "manager",
  "selectedBranchLabel": "Manager approval",
  "matched": true
}
```

- No secrets are stored; result goes through A1 `redactValue`.
- A3 can render indentation from `stepKey` later, but backend contract does not
  depend on the frontend.

## 5. Parallel Shape (A6-3-4, Not A6-3-1)

Parallel fan-out is deferred. When opened, it should add a separate action type:

```ts
parallel_branch
```

Expected config:

```ts
type ParallelBranchConfig = {
  branches: Array<{
    key: string
    label?: string
    actions: AutomationAction[]
  }>
  joinMode: 'all'
}
```

`join_any` is explicitly not part of the first parallel runtime. `join_all`
means:

- every branch runs;
- all branch results must be terminal before the parent resolves;
- any failed branch fails the parent and execution;
- successful branches still keep their results for audit.

Even if the implementation is inline rather than worker-parallel in v1, the job
graph must represent the fan-out/fan-in shape. Do not call it "parallel" if the
job graph cannot show independent branches.

## 6. Data / Migration Posture

A6-3-1 should try to avoid a new table. Preferred minimal path:

- widen `automation_rules` action type CHECK for `condition_branch`;
- keep `multitable_automation_jobs` table;
- use existing `step_key` and `upstream_job_id` for graph shape;
- optionally add nullable columns only if the runtime scout proves they are
  required:
  - `parent_job_id TEXT NULL`
  - `branch_key TEXT NULL`
  - `branch_index INT NULL`

If optional columns are added, they must be nullable and only populated for
opted-in A6-3 jobs. Existing rows remain valid.

The runtime scout must answer whether nested `step_key` is sufficient before any
migration is written.

## 7. Failure Semantics

A6-3-1 inherits current fail-stop behavior:

- condition evaluation error -> parent branch job `failed`, execution `failed`;
- selected branch action failure -> that action job `failed`, parent branch job
  `failed`, execution `failed`;
- top-level actions after a failed branch are `skipped`;
- no-match-without-default -> parent branch job `resolved` with
  `selectedBranchKey: null`, execution continues;
- `wait_for_callback` nested inside a branch config -> reject at rule save in
  A6-3-1;
- invalid branch config at rule save -> reject; do not wait until runtime.

The branch parent job should not be marked `resolved` until its selected branch
tail is finished. A6-3-1 has no branch-local suspension, so a selected branch is
terminal in the same execution call.

## 8. Validation Requirements

Service-level validation is mandatory. Route-level validation alone is not
enough because direct service callers exist.

Validate:

- action type exists in `ALL_ACTION_TYPES`;
- `condition_branch.config.branches` is a non-empty array;
- every branch key is unique and safe for deterministic ids;
- every branch condition normalizes through `normalizeConditionGroupInput`;
- every branch action type is in `ALL_ACTION_TYPES`;
- nested branch action configs pass the same action-specific validation used for
  top-level `actions`;
- no branch contains `condition_branch` recursively in A6-3-1;
- no branch contains `wait_for_callback` in A6-3-1.

This closes the class of issue where top-level `actionType` is validated but
`actions[]` / nested actions drift.

## 9. Test Surface for A6-3-1

Minimum runtime PR tests:

1. Rule create/update accepts valid `condition_branch` only with
   `executionMode: 'workflow_job_v1'`.
2. Legacy/off-path `condition_branch` fails closed and writes no branch jobs.
3. First matching branch wins; later matching branches are not executed.
4. Default branch runs when no branch matches.
5. No-match/no-default resolves no-op and continues.
6. Selected branch action failure fails execution and skips later top-level
   actions.
7. Top-level action after successful branch receives upstream from the last
   selected branch child.
8. Branch config containing `wait_for_callback` is rejected at save time in
   A6-3-1.
9. Non-selected branch side effects do not run.
10. A2 detail returns C1-normalized job views for nested branch jobs.
11. Redaction applies to branch job result/error.
12. Real Postgres integration: opt-in rule trigger -> branch jobs -> admin runs
    detail; opt-out rule -> no jobs / fail-closed.

## 10. Frontend Posture

Frontend should follow backend, not lead it.

First acceptable frontend slice:

- add a minimal `condition_branch` editor block;
- force / lock `workflow_job_v1` when the action is present, matching the
  `wait_for_callback` precedent;
- display branch parent and selected branch jobs in the admin runs detail;
- do not add a canvas editor;
- do not introduce BPMN language or gateway vocabulary yet.

## 11. Acceptance for This Design-Lock

- Docs-only diff.
- Creates this A6-3 design-lock.
- Updates tracker pointers only.
- No runtime, migration, route, UI, OpenAPI, or test changes.
- States that A6-3 runtime still requires a separate explicit owner opt-in.

## 12. Recommended Next Opt-In Phrase

If accepted, the runtime unlock should be explicit:

> Start A6-3-1 condition_branch runtime v1 only: opt-in
> `workflow_job_v1`, exclusive branch, no parallel, no BPMN, no approval bridge,
> real Postgres tests.
