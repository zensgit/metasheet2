# Automation Approval Result Backwrite Scope Gate - 2026-06-11

Type: **W7-0 docs-only scope-gate**.

Grounded on: `origin/main@578d4883f`.

Companion:

- `docs/development/workflow-automation-completion-plan-20260609.md`
- `docs/development/automation-start-approval-scope-gate-20260610.md`
- `docs/development/approval-completion-event-contract-scope-gate-20260609.md`
- `docs/development/multitable-automation-a6-execution-plan-20260601.md`
- `docs/development/multitable-automation-run-governance-todo-20260527.md`
- `packages/core-backend/src/services/ApprovalCompletionEvent.ts`
- `packages/core-backend/src/multitable/automation-approval-bridge-service.ts`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/src/multitable/record-service.ts`

## 0. Verdict

W7 may be scoped, but runtime must remain gated until the W6 operator smoke is
accepted or the owner gives a named runtime unlock.

The W7 runtime may write selected approval terminal results back to the
multitable record that triggered the `start_approval` bridge. It must do so only
through explicit mapping, idempotent bridge state, and field-level validation.

W7 must **not** turn approval completion into a generic trigger, write the full
approval form or comments to records, reuse hidden W5 payload data, or silently
convert every `start_approval` action into a record writer.

## 1. Current Code Facts

| ID | Fact | Evidence |
|---|---|---|
| F1 | W5 completion events are identity/result signals only: version, event id/type, approval ids, transition outcome, actor id/name, and requester id. They intentionally exclude approval form values, comments, assignments, runtime graph, policy, and automation credentials. | `ApprovalCompletionEvent.ts`; `approval-completion-event-contract-scope-gate-20260609.md` |
| F2 | W6 `start_approval` persists a bridge row keyed by execution/root execution, rule, step index, template, approval instance, trigger event, and outcome. It intentionally does not include result mapping. | `AutomationApprovalBridgeService.startApproval()`; `automation-start-approval-scope-gate-20260610.md` |
| F3 | W6 completion handling claims one pending bridge row and either continues the automation tail on `approved` or fails the bridge step and skips downstream actions on `rejected/revoked/cancelled`. | `AutomationService.handleApprovalCompletionEvent()` |
| F4 | Existing automation `update_record` is a normal action that directly JSON-merges fields into `meta_records` and emits `multitable.record.updated`. It is not an approval-result audit mechanism. | `AutomationExecutor.executeUpdateRecord()` |
| F5 | The richer record service path validates edit capability, hidden/read-only fields, select/multi-select/link values, and expected version semantics. W7 writes business data and must choose its write guard explicitly. | `RecordService.patchRecord()` |
| F6 | A5 retry blocks retry after any approval instance exists in the bridge lineage. W7 must preserve that no-duplicate-approval invariant and add no duplicate-write loophole. | `AutomationService.retryExecution()`; `AutomationApprovalBridgeService.hasCreatedApprovalForAnyExecution()` |
| F7 | W6 operator UAT is tracked separately. W7 scope can be documented now, but runtime should not be used as a substitute for proving W6's start/suspend/resume path. | Issue #2480 |
| F8 | The production record write pipeline records revisions, emits realtime/update events, and can trigger automation. W7 must decide whether to use that path and how to avoid uncontrolled recursion. | `RecordWriteService.patchRecords()`; `AutomationService.handleRecordEvent()` |

## 2. Scope

### In Scope For W7-1

- Add explicit result-backwrite configuration for `start_approval`.
- Write selected terminal outcome data to the original triggering multitable
  record after the W6 bridge receives a terminal approval completion.
- Support only the W5 terminal outcomes:
  - `approved`;
  - `rejected`;
  - `revoked`;
  - `cancelled`.
- Persist backwrite attempt state so duplicate completion events and process
  retries cannot write twice.
- Validate mapped target fields before writing.
- Emit normal multitable record update events when a write succeeds, so existing
  downstream automation/realtime behavior stays coherent.
- Record redacted, operator-readable C1 job output for the backwrite attempt.
- Add real-DB tests that traverse:
  `start_approval` -> W5 terminal event -> W7 mapped record write.

### Out Of Scope

- Approval result backwrite for manually started approvals that did not come
  through `start_approval`.
- Approval trigger bindings as a standalone automation trigger.
- Public webhook/callback endpoint or token emitter.
- BPMN/workflow-designer compile or runtime changes.
- Branch-local `start_approval`, branch-local backwrite, or parallel/join
  backwrite semantics.
- Writing full approval form data, comments, assignment metadata, requester
  profile, actor profile, runtime graph, or policy snapshot.
- Treating `return` as terminal or writing a returned/rework state.
- Changing approval template publish, assignment, or completion-event semantics.
- Auto-enabling backwrite for existing `start_approval` rules.

## 3. Configuration Contract

W7 should extend the W6 `start_approval` config with an optional explicit
mapping:

```ts
type ApprovalResultBackwriteConfig = {
  enabled: true
  fields: Record<string, ApprovalResultValueExpression>
  writeOn?: Array<'approved' | 'rejected' | 'revoked' | 'cancelled'>
}

type ApprovalResultValueExpression =
  | { source: 'outcome' }
  | { source: 'event_id' }
  | { source: 'approval_instance_id' }
  | { source: 'approval_request_no' }
  | { source: 'completed_at' }
  | { source: 'actor_id' }
  | { source: 'static'; value: string | number | boolean | null }
```

Recommended v1 shape:

```ts
type StartApprovalActionConfig = {
  templateId: string
  formDataMapping: Record<string, string>
  requester?: {
    mode?: 'trigger_actor' | 'rule_creator'
  }
  resultBackwrite?: ApprovalResultBackwriteConfig
}
```

Rules:

1. `resultBackwrite` is optional and defaults to disabled.
2. `fields` maps target multitable field ids to safe value expressions.
3. v1 must not expose a free-form template expression that can read arbitrary
   approval form data.
4. `writeOn` defaults to all four W5 terminal outcomes when omitted.
5. `return` is not a valid `writeOn` value.
6. Unknown target fields, hidden fields, read-only fields, lookup/rollup fields,
   invalid select values, and invalid link values must fail closed before
   writing.

The first runtime PR may choose a narrower v1, for example outcome-only plus
completed-at-only, but it must not widen beyond this contract without updating
this scope gate.

## 4. Runtime Model

W7 should run as part of the W6 completion handling after the bridge claim and
before or together with the final C1 settlement for the `start_approval` step.

Recommended sequence:

1. W5 completion event arrives.
2. W6 claims exactly one pending bridge row.
3. W6 builds the terminal `start_approval` step result.
4. If the `start_approval` config has no enabled `resultBackwrite`, W6 behavior
   remains unchanged.
5. If backwrite is enabled and the outcome is in `writeOn`, W7 validates the
   mapped target fields against the current sheet schema.
6. W7 writes one patch to the original triggering record.
7. W7 stores a durable backwrite attempt result tied to the bridge id and event
   id.
8. W6 settles the C1 job and either continues the tail (`approved`) or fails and
   skips downstream actions (`rejected/revoked/cancelled`), preserving current
   W6 semantics.

Backwrite is an additional side effect of terminal approval completion. It must
not become a second way to resume the automation tail and must not bypass the
existing W6 exactly-once claim.

## 5. Idempotency And Duplicate Writes

Duplicate writes are the sharpest W7 risk.

The runtime PR must persist or derive a deterministic write key before writing:

```text
approval_result_backwrite:<bridgeId>:<eventId>:<targetRecordId>:<mappingHash>
```

Minimum requirements:

- Duplicate W5 events must not write twice.
- A process crash after record write but before job settlement must not write
  the same mapped values twice on recovery.
- A5 retry must not backwrite a previous bridge again.
- If the original approval bridge has no `approval_instance_id`, W7 must not
  run.
- If the target record is gone, W7 must fail the backwrite attempt explicitly
  and leave the W6 terminal handling operator-visible.
- If schema validation fails, W7 must fail closed before writing.
- If record write succeeds but C1 settlement fails, the write attempt remains
  durable and visible; a later retry path must not repeat the write silently.

Acceptable implementation options:

- add backwrite columns/state to `multitable_automation_approval_bridges`; or
- add a small `multitable_automation_approval_backwrites` table with a unique
  key on `(bridge_id, event_id)`.

The scope gate intentionally does not prescribe the table shape, but the runtime
PR must use a durable uniqueness constraint rather than in-memory de-dupe.

The `mappingHash` should be computed from the normalized target field mapping.
This keeps a future config edit from ambiguously sharing an old write attempt
key while still preventing duplicate delivery of the same event and same mapping.

## 6. Permission And Field Guards

W7 writes business data. It must not use the absence of an HTTP route as an
excuse to skip authorization and field guards.

The runtime PR must decide and test one of these authorization models:

1. **Rule-owner model:** the rule creator is the write actor and must still have
   permission to edit the target record/sheet at completion time.
2. **Requester model:** the approval requester is the write actor and must still
   have permission to edit the target record/sheet at completion time.
3. **Automation system model:** a system actor may write, but only if the
   target field mapping was saved by an authorized rule manager and all target
   fields pass field guards.

Whichever model is chosen, tests must prove:

- a user without record edit capability cannot configure or execute the write;
- hidden/read-only/lookup/rollup fields are rejected;
- select/multi-select/link values are validated;
- the write is attributed in audit/realtime output with a clear automation
  actor, not a misleading human actor if that human did not perform the write.

The runtime PR should prefer the existing guarded `RecordWriteService` /
`RecordService` path over direct SQL JSON merge. If it uses direct SQL, it must
re-implement and test the same field-guard, row-scope, revision, realtime, and
formula/lookup-rollup semantics explicitly.

W7 must not silently reuse automation `update_record` as the implementation. The
existing automation action is a side-effect step, not an approval backwrite
audit path.

## 7. Redaction And Observability

W7 may include these fields in C1 job output:

- approval instance id;
- approval request number;
- terminal outcome;
- terminal event id;
- target record id;
- list of updated target field ids;
- backwrite attempt id/status.

W7 must not include:

- approval form values;
- approval comments;
- requester email, roles, departments, or permissions;
- actor email, roles, departments, or permissions;
- approval runtime graph or policy snapshot;
- full target record data before or after write;
- automation credentials or full rule snapshot.

All persisted attempt output and Admin runs responses must continue to flow
through the A1 redaction invariant.

Record history/revision source should be explicit, for example
`approval-backwrite`, so operators can distinguish approval-result writes from
ordinary REST edits and generic automation `update_record` actions.

## 8. Automation Loop Control

A successful W7 write may emit `multitable.record.updated`. That is desirable
for realtime and dependent automation only if it is deliberate.

The runtime PR must decide and test one of these loop-control models:

1. **Normal event model:** emit the standard record update event with a bounded
   automation depth/source marker, allowing downstream automations to react.
2. **Suppressed automation model:** publish realtime/audit but suppress
   automation trigger handling for approval-backwrite updates.
3. **Restricted downstream model:** allow only rules that explicitly opt into
   approval-backwrite-sourced updates.

Whichever model is chosen, tests must prove W7 cannot create an uncontrolled
record-update loop with the same rule or a downstream rule.

## 9. Failure Semantics

| Case | Required behavior |
|---|---|
| `resultBackwrite` missing/disabled | W6 behavior unchanged. |
| Outcome not in `writeOn` | No write; W6 behavior unchanged for that outcome. |
| Target record missing | Backwrite fails explicitly; W6 terminal handling remains operator-visible. |
| Target field missing/hidden/read-only | Fail closed before writing. |
| Invalid mapped value for field type | Fail closed before writing. |
| Duplicate event | No second write, no second tail continuation. |
| Write succeeds, tail later fails | Record write remains durable and visible; tail failure is separate. |
| Write fails on approved outcome | Runtime PR must choose fail-closed vs continue-tail-with-backwrite-failed and test it. Recommended: fail closed for approved backwrite because the mapped record state is part of business closure. |
| Write fails on rejected/revoked/cancelled outcome | Runtime PR must choose whether failure changes the already-failed bridge status or records an additional backwrite failure; must be visible in C1 output. |
| Approval `return` / still pending | No W7 write. |

## 10. Test Matrix For W7-1

| ID | Test | Risk covered |
|---|---|---|
| T1 | Config validation rejects `resultBackwrite` on legacy/non-job rules if the rule cannot run W6. | Cannot half-enable W7 without W6. |
| T2 | Missing/disabled `resultBackwrite` leaves W6 approved/rejected paths byte-identical. | No accidental writes. |
| T3 | Approved completion writes mapped `outcome`, `event_id`, and `completed_at` to the triggering record. | Happy path. |
| T4 | Rejected/revoked/cancelled completion writes only when included in `writeOn`. | Outcome filter. |
| T5 | Duplicate completion event does not write twice. | Idempotency. |
| T6 | A5 retry after a W6 bridge with backwrite does not repeat the write. | Retry duplicate-write guard. |
| T7 | Missing target record fails the attempt visibly. | Deleted record. |
| T8 | Hidden/read-only/lookup/rollup field mapping is rejected before writing. | Field guard. |
| T9 | Invalid select/multi-select/link values are rejected before writing. | Type guard. |
| T10 | Unauthorized writer cannot execute the write under the chosen permission model. | Permission boundary. |
| T11 | Redaction test proves runs output excludes form values, comments, full record data, actor profile, requester profile, runtime graph, and credentials. | Privacy. |
| T12 | Real-DB integration traverses `start_approval` -> W5 event -> W7 record write -> C1 output. | Wire-vs-fixture seam. |
| T13 | Record update event/realtime/audit behavior is emitted once and does not recurse uncontrollably. | Downstream automation/realtime coherence. |
| T14 | Write succeeds but tail action fails; record write is not repeated and tail failure remains explicit. | Split side-effect semantics. |

At least one test must use the actual W6 bridge path and actual record write
path. Hand-built bridge rows alone are not enough.

## 11. Runtime Red Lines

W7-1 must not:

- write approval form values unless a later scope gate adds a field-level value
  release policy;
- write approval comments;
- write requester/actor profile details;
- treat `return` as terminal;
- create a generic approval-completed trigger;
- create a public webhook/callback route;
- change W5 completion event payload shape;
- change W6 start/resume/fail semantics except to add explicit backwrite
  attempt state;
- auto-enable backwrite for existing rules;
- bypass record field guards through raw JSON merge without equivalent tests;
- hide backwrite failure behind a successful automation status.
- create an unbounded `multitable.record.updated` automation loop.

## 12. Completion Criteria

W7 is complete only when:

1. This docs-only scope gate is merged.
2. The W6 operator smoke in #2480 is accepted or the owner explicitly unlocks
   W7 runtime before #2480 closes.
3. A runtime PR lands the explicit result-backwrite config and durable attempt
   state under this contract.
4. Real-DB tests prove one terminal completion event produces at most one mapped
   record write.
5. Admin runs view can explain the backwrite attempt without leaking approval
   form data or full record data.
6. `workflow-automation-completion-plan-20260609.md`,
   `multitable-automation-run-governance-todo-20260527.md`, and
   `multitable-automation-a6-execution-plan-20260601.md` are updated to mark W7
   landed.

Until then, W7 remains scoped but not implemented.
