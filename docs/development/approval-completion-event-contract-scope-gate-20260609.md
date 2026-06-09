# Approval Completion Event Contract Scope Gate - 2026-06-09

Type: **W5-0 docs-only scope-gate**.

Grounded on: `origin/main@f43cfe44a`.

Companion:

- `docs/development/workflow-automation-completion-plan-20260609.md`
- `docs/development/approval-template-authoring-frontend-mvp-todo-20260604.md`
- `docs/development/multitable-automation-run-governance-todo-20260527.md`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/types/approval-product.ts`
- `packages/core-backend/src/services/ApprovalMetricsService.ts`

## 0. Verdict

W5 can start, but only as an event-contract slice first.

The next runtime PR must **not** add automation `start_approval`, result
backwrite, trigger bindings, BPMN mapping, or a new approval UI. Its only job is
to make approval completion observable through a typed, redacted, idempotent
contract that later automation slices can consume.

This document authorizes W5-1 implementation of the contract builder and
approval-side emission tests. It does **not** authorize W6 `start_approval`.

## 1. Current Code Facts

| ID | Fact | Evidence |
|---|---|---|
| F1 | Approval product status type is `draft | pending | approved | rejected | revoked | cancelled`. | `approval-product.ts` |
| F2 | Product terminal statuses are `approved`, `rejected`, `revoked`, and `cancelled`. | `APPROVAL_TERMINAL_STATUSES` |
| F3 | `createApproval()` can create an already-`approved` instance through auto-approval cascade and records terminal metrics after commit. | `ApprovalProductService.createApproval()` |
| F4 | `dispatchAction()` terminal paths currently include `approve` -> `approved`, `reject` -> `rejected`, and `revoke` -> `revoked`. | `ApprovalProductService.dispatchAction()` |
| F5 | `return` is not terminal in the current product runtime; it returns to a previous approval node and normally leaves the instance `pending`. | `dispatchAction('return')` and `approval-pack1a-lifecycle.api.test.ts` |
| F6 | `ApprovalMetricsService` records terminal observability rows separately, swallows metrics failures, and includes a historical `returned` metrics bucket. | `ApprovalMetricsService.recordTerminal()` |
| F7 | Existing in-process `eventBus` is synchronous from the caller's perspective and should not be allowed to roll back approval transactions. | `integration/events/event-bus.ts` |
| F8 | Automation already consumes internal event-bus records for multitable record events, but there is no approval completion bridge. | `AutomationService.init()` |

## 2. Scope

### In Scope For W5-1

- Add a typed approval completion event payload shape.
- Add a pure builder that converts a committed approval transition into that
  payload.
- Emit completion events only after the approval transaction commits.
- Add unit/integration coverage proving:
  - `approved`, `rejected`, and `revoked` terminal transitions produce the
    expected payload.
  - auto-approved-on-create instances produce the same completion contract.
  - `return`, `comment`, `transfer`, and incomplete all-mode approvals do **not**
    produce completion events.
  - payloads do not expose form snapshot values, requester email, comments, IP,
    user-agent, assignment metadata, or active credential/config material.
- Keep failures in the event path from breaking the approval action.

### Out Of Scope

- Automation `start_approval`.
- Automation subscription/trigger binding for approval events.
- Approval result backwrite into multitable fields.
- New event table, durable outbox, retry worker, or webhook dispatcher.
- New route/API surface.
- UI changes.
- BPMN / Workflow Designer mapping.
- Treating `return` as a terminal completion event.

## 3. Event Taxonomy

Use the actual approval runtime status as the source of truth.

| Product transition | W5 event type | Notes |
|---|---|---|
| `pending -> approved` | `approval.approved` | Includes normal approve, auto-approval cascade, and admin-jump paths that land terminal-approved. |
| `pending -> rejected` | `approval.rejected` | Reject comment is not included in the automation-facing event. |
| `pending -> revoked` | `approval.revoked` | This is the current product term for requester revoke. Downstream UI may label it "cancelled", but the event type must match stored state. |
| `* -> cancelled` | `approval.cancelled` | Reserved for existing status compatibility if a future route uses the `cancelled` state. |
| `pending -> pending` through `return` | no completion event | Return is a rework transition, not completion. A future `approval.returned` transition event may be designed separately, but it must not resume completion-only automation. |

This intentionally corrects the older shorthand
`approval.approved/rejected/returned/cancelled`: `returned` is not a v1
completion event in the current runtime.

## 4. Payload Contract

W5-1 should introduce a versioned payload similar to:

```ts
type ApprovalCompletionEventType =
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.revoked'
  | 'approval.cancelled'

type ApprovalCompletionOutcome =
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'cancelled'

interface ApprovalCompletionEventV1 {
  version: 1
  eventId: string
  eventType: ApprovalCompletionEventType
  occurredAt: string
  source: 'approval-product'
  approval: {
    instanceId: string
    requestNo: string | null
    templateId: string | null
    templateVersionId: string | null
    publishedDefinitionId: string | null
    businessKey: string | null
    workflowKey: string | null
  }
  transition: {
    action: 'created' | 'approve' | 'reject' | 'revoke' | 'jump' | 'auto_approve'
    fromStatus: string | null
    toStatus: ApprovalCompletionOutcome
    fromVersion: number | null
    toVersion: number
    nodeKey: string | null
  }
  actor: {
    id: string
    name: string | null
  } | null
  requester: {
    id: string | null
  }
}
```

### Required eventId

`eventId` must be deterministic and idempotent:

```text
approval:<instanceId>:<toVersion>:<eventType>
```

For auto-approved-on-create, use version `0`.

Consumers must be able to dedupe on `eventId`. W5-1 does not need to add a
consumer table, but tests must lock the deterministic id.

### Redaction / Privacy

The event payload must **not** include:

- full `form_snapshot`;
- requester email, roles, permissions, or department;
- approval comments;
- IP address or user-agent;
- active assignment metadata;
- `resolvedFrom` metadata;
- template runtime graph;
- approval policy snapshot;
- any automation rule config or credential material.

If a later result-backwrite slice needs form values, it must add an explicit
mapping and field-level permission/redaction gate. W5 completion events are
identity/result signals only.

## 5. Emission Boundary

W5-1 should emit after the approval transaction commits. The event path must be
best-effort and guarded:

- Approval state changes must not roll back because an event listener throws.
- No event may be emitted before commit.
- No event may be emitted for a transaction that rolls back.
- Multiple terminal hooks for the same `(instanceId, version, eventType)` must
  produce the same `eventId`.

Recommended shape:

- Add a small helper module, for example
  `packages/core-backend/src/services/ApprovalCompletionEvent.ts`.
- Inject or wrap the existing `eventBus.emit(...)` through a safe helper so
  listener errors are logged and swallowed.
- Keep the builder pure and separately testable.

Do not use `approval_metrics` as the event source. Metrics is an observability
row with its own swallowed-failure policy and a historical `returned` bucket;
it is not an automation event outbox.

## 6. Test Matrix For W5-1

| ID | Test | Risk covered |
|---|---|---|
| T1 | Pure builder maps `approved` to `approval.approved` with deterministic `eventId`. | Contract shape |
| T2 | Pure builder maps `rejected` to `approval.rejected` and excludes rejection comment. | Redaction/privacy |
| T3 | Pure builder maps `revoked` to `approval.revoked`, not `approval.cancelled`. | Runtime-state fidelity |
| T4 | Auto-approved-on-create approval emits one `approval.approved` event after commit. | Create-time terminal path |
| T5 | Normal final approve emits one `approval.approved` event after commit. | Main happy path |
| T6 | Reject emits one `approval.rejected` event after commit. | Negative terminal path |
| T7 | Revoke emits one `approval.revoked` event after commit. | Requester revoke path |
| T8 | Return-to-node emits no completion event and leaves the instance pending. | Rework is not completion |
| T9 | All-mode partial approve emits no completion event. | Aggregation not complete |
| T10 | Event listener failure does not fail the approval action. | Best-effort boundary |
| T11 | Payload body string does not contain submitted form values, comment text, requester email, IP, or user-agent. | Privacy guard |

At least one test must exercise the real service path, not only a hand-built
payload fixture. The recurring failure mode in this repository is
wire-vs-fixture drift; W5-1 must cross the actual approve/reject/revoke service
paths.

## 7. Runtime Red Lines

W5-1 must not:

- create an automation action;
- subscribe automation rules to approval events;
- write multitable records from approval completion;
- add an event/outbox table;
- add a public webhook endpoint;
- add a UI surface;
- change approval metrics semantics;
- change approval template publish semantics;
- treat `returned` as terminal.

## 8. Completion Criteria

W5 is complete only when:

1. The event payload type/builder exists.
2. Approval terminal paths emit guarded, post-commit events.
3. Tests prove event emission and non-emission across the matrix above.
4. The workflow completion plan is updated from "W5 not started" to "W5
   landed".

After W5 lands, W6 `start_approval` may be scoped. W6 still needs its own gate:
starting an approval from automation creates side effects, waits on W5 events,
and must prove idempotency/backwrite boundaries separately.
