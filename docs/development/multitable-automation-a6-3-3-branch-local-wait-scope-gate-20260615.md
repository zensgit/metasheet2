# Multitable Automation A6-3-3 Branch-Local Wait Scope Gate - 2026-06-15

Status: docs-only scope gate; runtime/frontend not started.

Scope: allow `wait_for_callback` inside a selected `condition_branch` path so
only that branch suspends while ordinary branches continue without waiting.

Grounded on: `origin/main@d37e0b234`.

Companions:

- `multitable-automation-a6-3-branch-parallel-design-20260605.md`
- `multitable-automation-a6-2-suspend-resume-design-20260603.md`
- `multitable-automation-a6-execution-plan-20260601.md`
- `multitable-automation-run-governance-todo-20260527.md`

## 0. Verdict

A6-3-3 may be developed, but only as a branch-local extension of the already
landed A6-2 suspend/resume and A6-3-1 `condition_branch` runtime.

The demand signal for this scope gate is a simulated but product-plausible high
amount review flow:

- `amount <= 100000`: ordinary branch updates the record and finishes.
- `amount > 100000`: selected high-risk branch notifies an owner, suspends at
  `wait_for_callback`, and after admin resume updates the same record as
  approved after review.

The value being tested is specific: the whole rule must not suspend for every
record. Only the selected condition branch should suspend.

This document is not an authorization for public webhook callbacks, delay/timer
resume, `join_any`, approval result backwrite, or live BPMN runtime.

## 1. Current Code Grounding

Current main has the primitives but deliberately forbids combining them:

- A6-2 top-level `wait_for_callback` persists a suspension row plus a suspended
  C1 job, then resumes from `suspendIndex + 1`.
- A6-3-1 `condition_branch` runs one selected branch under nested step keys:
  `parentStep.branch.<branchKey>.<actionIndex>`.
- `AutomationService.validateConditionBranchConfig()` rejects branch-local
  `wait_for_callback` with `cannot contain wait_for_callback until A6-3-3`.
- `AutomationExecutor.executeConditionBranch()` also fails closed if a persisted
  branch config contains `wait_for_callback`.
- `multitable_automation_suspensions` currently stores only top-level
  `step_index`; `AutomationJobService.listByExecution()` hydrates suspend
  descriptors by `step_index`. That is insufficient for branch-local waits,
  because the suspended child job is identified by `step_key`, not by the parent
  top-level index alone.

Therefore A6-3-3 cannot be implemented by simply removing the validator guard.
It needs an explicit nested resume cursor and step-key-aware suspend hydration.

## 2. In Scope

### A6-3-3a Backend Runtime

Add backend support for exactly one new nested shape:

```text
condition_branch -> selected branch -> wait_for_callback -> later branch actions
```

Runtime must:

1. Allow `wait_for_callback` inside a selected `condition_branch` branch when
   the rule has `execution_mode = 'workflow_job_v1'`.
2. Keep legacy/off-path rules fail-closed.
3. Keep nested `condition_branch`, `parallel_branch`, and `start_approval` inside
   branch-local paths out of scope unless a later scope gate explicitly opens
   them.
4. Persist a branch-local suspension cursor that can resume the selected branch
   action after the suspended wait, then continue the top-level tail.
5. Hydrate the C1 `suspended` descriptor on the branch child job by `step_key`,
   not only by top-level `step_index`.
6. Preserve the existing admin-gated resume route. No public callback route and
   no token emitter.

### A6-3-3b Frontend Authoring And Readability

After the backend contract lands, the editor may allow `wait_for_callback` as a
branch action in the existing `condition_branch` builder.

Frontend must:

1. Continue auto-locking `workflow_job_v1`.
2. Continue read-only-never-flatten for loaded richer shapes.
3. Allow only the newly supported branch-local `wait_for_callback` addition; do
   not use this slice to unlock nested `condition_branch`, `parallel_branch`, or
   `start_approval` in branches.
4. Show branch-local suspended jobs clearly in Admin runs detail using the
   existing C1 job list.

## 3. Out Of Scope

A6-3-3 must not add:

- public webhook/callback endpoints or token emitters;
- delay/timer resume, worker queues, or scheduler ownership;
- `join_any` or cancellation semantics;
- nested `condition_branch` inside a branch;
- `parallel_branch` inside a branch;
- branch-local `start_approval`;
- approval result backwrite;
- BPMN live runtime or deploy/start behavior;
- a second job/status/audit store;
- unredacted trigger, record, job, or resume payload persistence.

## 4. Runtime Shape

### 4.1 Suspension Cursor

Top-level A6-2 suspensions keep their current meaning.

Branch-local suspensions need an additional cursor. A6-3-3a should add a
nullable structured cursor to the suspension row, for example:

```ts
type AutomationResumeCursor =
  | { kind: 'top_level'; stepIndex: number }
  | {
      kind: 'condition_branch'
      parentStepIndex: number
      branchKey: string
      branchActionIndex: number
      stepKey: string
      parentJobId: string
      branchJobId: string
      upstreamJobId: string | null
      branchActionFingerprint: { count: number; hash: string }
    }
```

`null` or missing cursor means the existing A6-2 top-level path.

Why this shape:

- `parentStepIndex` is still needed to locate the top-level
  `condition_branch` action.
- `branchKey` locates the selected branch.
- `branchActionIndex` locates the suspended wait inside the branch.
- `stepKey` locates the C1 suspended job precisely.
- `branchActionFingerprint` guards the selected branch path. The existing
  top-level `action_fingerprint` only hashes top-level action types and cannot
  detect branch action drift.

The branch fingerprint should be non-secret and type-only, matching the A6-2
principle.

### 4.2 Job State While Suspended

When the high-risk branch suspends:

- legacy execution status remains `running`;
- top-level `condition_branch` parent job remains `running`;
- selected prior branch child jobs are `resolved`;
- selected branch wait child job is `suspended`;
- downstream branch and top-level actions are not run yet;
- non-selected branch internals remain absent, as in A6-3-1.

The suspended branch child job must carry C1 suspend metadata in the admin detail
view:

```json
{
  "stepKey": "0.branch.high.1",
  "status": "suspended",
  "suspend": {
    "reason": "external_event",
    "resumeToken": "..."
  }
}
```

### 4.3 Resume Semantics

Admin resume must:

1. Load the suspension by token.
2. Validate it is still `pending`.
3. Load the current rule and ensure it is still enabled.
4. Check the existing top-level action fingerprint.
5. For `condition_branch` cursors, also check the selected branch action
   fingerprint and branch/action cursor.
6. Re-fetch the current record; if missing, return the existing `RECORD_GONE`
   style failure.
7. Read the existing execution before token claim.
8. Claim the token once.
9. Settle the suspended branch child wait job to resolved.
10. Continue the selected branch tail after `branchActionIndex`.
11. Settle the top-level `condition_branch` parent job when the selected branch
    completes.
12. Continue top-level actions after the parent `condition_branch`.

If the branch tail fails, the top-level `condition_branch` parent job and the
execution fail. If the branch tail suspends again, the execution remains
`running` with a new pending suspension.

## 5. Failure Semantics

| Case | Expected result |
|---|---|
| legacy rule contains branch-local wait | fail closed; no suspension row |
| current rule missing or disabled | `409 RULE_MISSING_OR_DISABLED`, token not claimed |
| top-level action fingerprint changed | `409 RULE_CHANGED`, token not claimed |
| selected branch path changed | `409 RULE_CHANGED`, token not claimed |
| selected branch key removed | `409 RULE_CHANGED`, token not claimed |
| record deleted while waiting | `404 RECORD_GONE`, token not claimed |
| second resume | `409 ALREADY_RESUMED` |
| post-claim branch-tail failure | execution becomes terminal `failed`; no auto-retry |
| non-selected branch contains wait | no suspension; non-selected branch remains absent |

## 6. Acceptance Scenario

Use a real-DB integration scenario, not only a fixture:

1. Create fields `amount`, `status`, `reviewed_at`.
2. Create an opted-in rule with one `condition_branch`.
3. Low amount branch:
   - condition `amount <= 100000`;
   - action `update_record(status = auto_approved)`.
4. High amount branch:
   - condition `amount > 100000`;
   - action `send_notification`;
   - action `wait_for_callback`;
   - action `update_record(status = approved_after_review)`.
5. Trigger low amount record:
   - execution succeeds;
   - no suspended jobs;
   - record status is `auto_approved`.
6. Trigger high amount record:
   - execution remains `running`;
   - parent branch job is `running`;
   - branch wait child job is `suspended`;
   - record status is not yet `approved_after_review`.
7. Resume:
   - branch wait child job resolves;
   - later branch action runs;
   - parent branch job resolves;
   - execution succeeds;
   - record status is `approved_after_review`.

## 7. Required Tests

Backend runtime PR:

- service validation accepts branch-local `wait_for_callback` only in
  `workflow_job_v1` rules;
- service validation still rejects nested `condition_branch`,
  `parallel_branch`, and branch-local `start_approval`;
- executor suspends a selected branch-local wait and does not run later branch
  actions before resume;
- non-selected branch wait does not create a suspension;
- resume continues the selected branch tail and then top-level tail;
- stale top-level action fingerprint fails closed;
- stale selected branch fingerprint fails closed;
- second resume returns already-resumed;
- record-gone returns 404 without claiming;
- `listByExecution()` hydrates the suspend descriptor by branch `stepKey` and
  never attaches it to the parent branch job by top-level `step_index`.

Frontend PR:

- editor allows `wait_for_callback` inside condition branches and auto-locks
  `workflow_job_v1`;
- editor still blocks nested `condition_branch`, `parallel_branch`, and
  `start_approval`;
- loaded richer branch shapes remain read-only and are never flattened;
- admin runs detail shows a branch-local suspended job with the resume action in
  the existing admin-only detail surface.

## 8. Re-Entry

Runtime implementation requires a separate explicit build PR after this
scope-gate lands. The recommended split is:

1. A6-3-3a backend runtime + migration + real-DB tests.
2. A6-3-3b editor support + admin-runs readability tests.
3. Minimal tracker reconciliation after both land.

This scope gate does not authorize public webhook resume, `join_any`, W7 result
backwrite, or live BPMN runtime.
