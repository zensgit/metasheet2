# Automation start_approval Scope Gate - 2026-06-10

Type: **W6-0 docs-only scope-gate**.

Grounded on: `origin/main@6690bade5`.

Companion:

- `docs/development/workflow-automation-completion-plan-20260609.md`
- `docs/development/approval-completion-event-contract-scope-gate-20260609.md`
- `docs/development/multitable-automation-a6-execution-plan-20260601.md`
- `docs/development/multitable-automation-a6-convergence-scout-20260529.md`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/src/multitable/automation-actions.ts`
- `packages/core-backend/src/multitable/automation-job-service.ts`
- `packages/core-backend/src/multitable/automation-suspension-service.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/services/ApprovalCompletionEvent.ts`

## 0. Verdict

W6 may start, but only as a tightly scoped `start_approval` bridge.

The next runtime PR may add an automation action that creates **one** approval
instance from a published approval template, records the linkage on the
automation job plane, suspends the automation execution, and resumes exactly
once from the W5 approval completion event.

It must **not** add approval result backwrite, approval trigger bindings, BPMN
mapping, public webhooks, a second approval runtime, or richer approval-template
authoring. W6 is the first explicit cross-surface bridge; it is not a blanket
unlock for the rest of approval Phase 2.

## 1. Current Code Facts

| ID | Fact | Evidence |
|---|---|---|
| F1 | Approval templates are started through `ApprovalProductService.createApproval({ templateId, formData }, actor)`, and the HTTP route requires `approvals:write`. | `packages/core-backend/src/services/ApprovalProductService.ts`, `packages/core-backend/src/routes/approvals.ts` |
| F2 | `createApproval()` loads the active published definition, validates/prunes form data, freezes `template_id`, `template_version_id`, and `published_definition_id` on the instance, inserts assignments, and returns the created approval. | `ApprovalProductService.createApproval()` |
| F3 | W5 emits typed terminal completion events after commit: `approval.approved`, `approval.rejected`, `approval.revoked`, and `approval.cancelled`. Payloads are versioned and redacted. | `ApprovalCompletionEvent.ts` and `ApprovalProductService.ts` |
| F4 | Automation rules already have an opt-in C1 job plane: `execution_mode = 'workflow_job_v1'` writes `multitable_automation_jobs` rows and exposes C1 views. | `automation-job-service.ts`, `automation-service.ts` |
| F5 | A6-2 suspend/resume keeps legacy execution status `running` while the C1 job carries `suspended`; the durable capability is stored in `multitable_automation_suspensions`. | `automation-suspension-service.ts`, `automation-executor.ts` |
| F6 | `wait_for_callback` is a generic admin-resume primitive. It has a single-use token, rule-drift guard, and current-record re-fetch. | `AutomationService.resumeExecution()` |
| F7 | `condition_branch` already requires `workflow_job_v1`; branch-local `wait_for_callback` is explicitly deferred to A6-3-3. | `automation-service.ts`, `automation-executor.ts` |
| F8 | The current event bus is in-process and synchronous from the caller's point of view; W5 guards approval emission so listener failures do not roll back approval actions. | `integration/events/event-bus.ts`, `ApprovalCompletionEvent.ts` |
| F9 | Auto-approved approvals can become terminal inside `createApproval()` and emit W5 completion before the method returns. | `ApprovalProductService.createApproval()` |
| F10 | `eventBus.subscribe()` catches synchronous listener throws, but raw async listener promise rejections are not awaited by the bus. | `integration/events/event-bus.ts` |

## 2. Scope

### In Scope For W6-1

- Add a canonical `start_approval` automation action type.
- Add service-level validation for the action in both single-action and
  `actions[]` multi-action paths.
- Require `execution_mode = 'workflow_job_v1'` for any rule containing
  `start_approval`.
- Create exactly one approval instance for one `start_approval` step.
- Persist a durable automation-to-approval linkage so approval completion can
  resume the suspended automation execution.
- Suspend the current automation job after the approval is created.
- Resume exactly one waiting automation job when the matching W5 completion
  event arrives.
- Expose C1 job output that is useful to operators without exposing submitted
  form values or approval internals.
- Add real-DB tests for the create -> suspend -> completion-event -> resume
  chain.

### Out Of Scope

- Approval result backwrite to multitable records.
- Approval trigger bindings as a user-facing trigger source.
- Public webhook/callback endpoint or token emitter.
- Workflow Designer / BPMN compile-preview or live execution.
- New approval authoring UI.
- New approval template runtime semantics.
- Durable event outbox / retry worker.
- Branch-local `start_approval` or `wait_for_callback` nesting changes.
- Treating `return` as approval completion.
- Folding approval assignment/runtime graph state into automation tables.

## 3. Action Contract

W6-1 should introduce a minimal action config:

```ts
type StartApprovalActionConfig = {
  templateId: string
  formDataMapping: Record<string, string>
  requester?: {
    mode: 'trigger_actor' | 'rule_creator'
  }
  titleTemplate?: string
  businessKeyTemplate?: string
}
```

Rules:

1. `templateId` is required and must reference a published approval template at
   runtime.
2. `formDataMapping` maps approval form field keys to automation template
   expressions or record paths. It must be explicit; W6 must not pass the full
   automation record into approval form data.
3. v1 requester mode should be narrow. Prefer `trigger_actor` when present and
   fall back to `rule_creator` for schedule/system triggers. The implementation
   must load a real approval actor snapshot for the chosen user id; it must not
   fabricate permissions, roles, email, or department data.
4. The chosen actor must be authorized to start approvals. The HTTP
   `/api/approvals` route enforces `approvals:write`, but W6-1 will call the
   service directly; therefore the bridge must enforce the equivalent
   permission boundary itself before `createApproval()`.
5. The implementation must not include a `resultMapping` field in W6-1. Result
   backwrite belongs to W7.

If the runtime needs a smaller v1, it may omit `requester`, `titleTemplate`, and
`businessKeyTemplate`, but it must not widen beyond this contract without a
separate scope update.

## 4. Runtime Model

W6-1 should behave as a specialized suspend action, not as a normal side-effect
step:

1. Validate the rule is opted into `workflow_job_v1`.
2. Render the explicit approval form data mapping from the current automation
   context.
3. Establish an idempotency/correlation guard before approval completion can be
   lost. Auto-approved-on-create is a required case: W6 must not rely on a W5
   event emitted before the bridge exists.
4. Create one approval instance through `ApprovalProductService.createApproval()`.
5. Persist a bridge row tying:
   - automation `execution_id`;
   - automation `step_index`;
   - automation `rule_id`;
   - approval `instance_id`;
   - approval `published_definition_id`;
   - the deterministic idempotency key;
   - current bridge state.
6. Write or update the C1 job for the `start_approval` step as `suspended`,
   with redacted output containing only non-sensitive approval identifiers.
7. Stop the automation execution with legacy status `running`, matching A6-2
   out-of-band suspended semantics.
8. On W5 terminal completion event, claim the bridge once, settle the suspended
   job, and continue the automation tail.

W6 should not reuse the admin `resume_token` as the approval bridge capability.
The approval completion event is the resume signal. The bridge must be keyed by
approval identity and automation step, not by a token that an admin copies from
the runs view.

### Auto-Approval Race

W6-1 must explicitly handle create-time terminal approvals. Acceptable designs
include either:

- extend the approval start path so a W6 correlation can be persisted before or
  inside the approval transaction that may emit the completion event; or
- after `createApproval()` returns, detect a terminal approval result and feed it
  through the same exactly-once bridge completion path that a W5 event would use.

The implementation PR must include a test where the approval auto-approves
during `start_approval`. The automation must not remain stuck `running` with a
suspended job that missed its completion.

## 5. Idempotency And Duplicate Starts

Duplicate approval creation is the sharpest W6 risk.

W6-1 must define and test a deterministic idempotency key before runtime ships.
Within one execution, the recommended action-run key is:

```text
start_approval:<executionId>:<stepIndex>:<templateId>
```

That key is not sufficient for A5 retry, because retry creates a new execution
id. W6-1 must also persist enough lineage to detect a retry of a step that
already created an approval. Acceptable designs include:

- store and query an `original_execution_id` / `root_execution_id` plus
  `step_index` and `template_id`; or
- fail closed when retrying an execution that contains a completed or pending
  W6 bridge; or
- reuse the existing bridge only if the implementation can prove exactly-once
  resume and no duplicate approval instance.

Minimum requirements:

- A retry or replay of the same automation step must not create a second
  approval instance.
- A5 whole-execution retry semantics must be explicit for executions that
  contain `start_approval`. If the original execution already created an
  approval, retry must either fail closed with a precise code or reuse the
  existing bridge; it must not silently create a second approval for the same
  business step.
- A listener receiving the same W5 event twice must resume at most one
  automation job.
- If approval creation succeeds but bridge persistence fails, the failure mode
  must be explicit and operator-visible. The implementation must not silently
  create an orphan approval that the automation can never observe.
- If bridge persistence succeeds but the job cannot be marked suspended, the
  implementation must fail closed and surface an inconsistent-state test.

The scope gate intentionally does not prescribe the table name, but the runtime
PR must use a durable store with a uniqueness constraint on the idempotency key
or `(approval_instance_id, execution_id, step_index)`.

## 6. Event Matching

The W5 event contains the approval identifiers and terminal outcome. W6 should
consume it only when all of these are true:

1. `version === 1`.
2. `source === 'approval-product'`.
3. `eventType` is one of the terminal completion events.
4. `approval.instanceId` matches a pending W6 bridge row.
5. The pending bridge row still points to the same automation execution and
   step.

Rejected/approved/revoked/cancelled should all be terminal for the waiting
`start_approval` job, but W6 must not write the outcome to multitable record
fields. It may expose a redacted outcome object in job result for runs-view
diagnosis.

`return` remains non-terminal and must not resume W6.

## 7. Failure Semantics

| Case | Required behavior |
|---|---|
| Template missing / unpublished | `start_approval` step fails before suspension; downstream actions are skipped. |
| Form data mapping invalid | Step fails before approval creation. |
| Approval permission denied for chosen requester | Step fails before approval creation/suspension; no bridge row. |
| Chosen requester snapshot cannot be loaded | Step fails before approval creation; no fake actor snapshot. |
| Approval created + bridge persisted | Step becomes suspended; execution remains running. |
| Approval auto-approves during creation | Bridge completion path consumes the terminal result exactly once; execution must not get stuck waiting for a missed event. |
| Duplicate approval completion event | No second resume; no duplicate tail side effects. |
| Approval completion event for unknown approval | Ignore or log; do not fail unrelated executions. |
| Rule disabled/changed while waiting | The runtime must define whether W6 follows A6-2's current-rule re-derive model or approval-bridge snapshot model. The implementation PR must test the chosen behavior. |
| Tail action fails after approval completes | Execution becomes failed; bridge remains consumed/resumed for audit, no auto-retry. |
| Event listener throws | Approval action remains successful; W5 already guards emitter failures. W6 listener must guard its own errors and avoid rolling back approval. |

The W6 implementation should prefer fail-closed behavior over best-effort
success whenever it cannot prove the bridge state.

The W6 event subscriber must not register a raw async handler that can reject
outside the event bus' synchronous try/catch. It should register a synchronous
wrapper and explicitly `catch`/log the async resume work.

## 8. Redaction And Observability

The bridge/job output may include:

- approval instance id;
- approval request number;
- template id;
- published definition id;
- terminal outcome;
- terminal event id.

The bridge/job output must not include:

- full approval form data;
- requester email, roles, department, or permissions;
- approval comments;
- approval assignment metadata;
- runtime graph;
- automation credentials or full rule snapshot.

Job persistence must continue to reuse the existing A1 automation redactor and
C1 status vocabulary. W6 must not add a second job/read model.

## 9. Test Matrix For W6-1

| ID | Test | Risk covered |
|---|---|---|
| T1 | Service validation rejects `start_approval` unless `execution_mode = 'workflow_job_v1'`. | Legacy path cannot half-run approval-as-job. |
| T2 | Service validation rejects missing `templateId` and invalid `formDataMapping`. | Invalid config fails before runtime. |
| T3 | Chosen requester without `approvals:write` fails closed even when the template is visible. | Route-bypass permission guard. |
| T4 | `executeRule()` with `start_approval` creates one approval instance, bridge row, and suspended C1 job. | Core happy path. |
| T5 | The persisted suspended job passes `normalizeWorkflowJob`. | C1 contract. |
| T6 | Auto-approved-on-create approval does not miss the completion and does not leave the job stuck suspended. | Create-time terminal race. |
| T7 | W5 `approval.approved` event resumes exactly one waiting job and continues the tail. | Event bridge happy path. |
| T8 | Duplicate W5 event does not resume twice and does not duplicate tail side effects. | Idempotency. |
| T9 | `approval.rejected`, `approval.revoked`, and `approval.cancelled` settle the waiting job with explicit outcome. | Outcome taxonomy. |
| T10 | `return` / pending approval state does not resume the job. | Rework is not completion. |
| T11 | Listener errors are swallowed/logged and do not roll back approval completion. | Event isolation. |
| T12 | Approval creation failure does not create bridge rows or suspended jobs. | Partial-write guard. |
| T13 | Approval-created-but-bridge-failed path is tested and operator-visible. | Orphan approval risk. |
| T14 | Redaction test proves job/bridge/run response excludes form values, comments, requester email, graph, and credentials. | Privacy. |
| T15 | A5 retry of an execution that already created a W6 approval does not create a duplicate approval. | Retry duplicate-start guard. |
| T16 | Real-DB integration traverses automation trigger -> `start_approval` -> approval completion event -> automation tail. | Wire-vs-fixture seam. |

At least one test must hit the actual `AutomationService.executeRule()` path and
the actual `ApprovalProductService.createApproval()` path. Hand-built fixtures
alone are not enough; this repo has repeatedly caught bugs at wire boundaries.

## 10. Runtime Red Lines

W6-1 must not:

- add `resultMapping` or write approval results into multitable records;
- expose approval completion as a generic automation trigger;
- add public webhook endpoints;
- route through BPMN or Workflow Designer runtime;
- change approval template publish semantics;
- change approval assignment resolver semantics;
- persist full approval form snapshots in automation tables;
- treat `return` as completion;
- enable the action for legacy/non-job rules;
- auto-enable every existing automation rule for `workflow_job_v1`.

## 11. Completion Criteria

W6 is complete only when:

1. The docs-only scope-gate is merged.
2. A runtime PR lands the `start_approval` action under this contract.
3. Real-DB tests prove one approval instance, one bridge, one suspended job, and
   exactly-once resume from W5 completion events.
4. Admin runs view can explain the waiting approval and terminal outcome without
   leaking sensitive approval data.
5. `docs/development/workflow-automation-completion-plan-20260609.md` is updated
   to mark W6 landed.

After W6 lands, W7 result backwrite may be scoped. W7 still needs a separate
gate because it writes business data and changes record state.
