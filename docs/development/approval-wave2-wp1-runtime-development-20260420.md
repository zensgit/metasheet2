# Approval Wave 2 WP1 - Any-mode (或签) Runtime Wiring

- Date: 2026-04-20
- Branch: `codex/approval-wave2-wp1-runtime-202605`
- Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/wp1`
- Base: `origin/main` @ `0756ff61d`

## Scope

Deliver end-to-end `approvalMode='any'` (或签 / first-wins aggregation) on top of Pack 1A.
Pack 1A already shipped `'all'` (会签), `targetNodeKey` return, empty-assignee `auto-approve`,
and the `aggregateComplete` metadata flag. The `'any'` literal was present in the
`ApprovalMode` union but the route handler's approve path fell through to the generic
"deactivate all, resolve next node" branch, which worked visibly but left no audit trail
for sibling cancellations and did not surface the aggregation mode to downstream consumers.

## Design decisions

### Who owns `aggregateCancelled`?

The executor stays pure - it has no DB knowledge and no actor context (except for
`buildTransferAssignments`, which is isolated). The route handler already computes
`remainingAssignments = currentNodeAssignments - actorAssignments` for all-mode; we reuse
the same pattern to derive `aggregateCancelledAssigneeIds` from the DB-authoritative
active assignments, not from the static config's `assigneeIds`. This correctly accounts
for prior transfers: if `approver-a` transferred to `approver-z`, the DB row for
`approver-z` is the one that gets cancelled when a sibling wins.

To let the route branch cleanly, the resolution now carries:

```ts
interface ApprovalGraphResolution {
  // ...
  aggregateMode: 'single' | 'all' | 'any' | null
  aggregateComplete: boolean
}
```

- `resolveAfterApprove` sets both from the node being resolved away from
  (`aggregateMode` = that node's mode, `aggregateComplete` = true).
- `resolveInitialState` and `resolveReturnToNode` set `aggregateMode: null` and
  `aggregateComplete: false` (they do not represent aggregation completion events).

### Audit trail shape

For an any-mode resolution with siblings `approver-b, approver-c`, first approver
`approver-a`:

1. `approver-a`'s assignment row: deactivated via the existing
   `deactivateActorAssignmentsAtNode` helper. No `aggregateCancelled*` metadata on
   the actor's own row.
2. Sibling rows (`approver-b`, `approver-c`): deactivated via a targeted UPDATE that
   merges `aggregateCancelledBy`, `aggregateCancelledAt`, `aggregateMode: 'any'`
   into their existing `metadata` JSONB.
3. Approval record (`action='approve'`): includes `approvalMode: 'any'`,
   `aggregateComplete: true`, and the new `aggregateCancelled: [<sibling ids>]` array.
4. One aggregated sign record (`action='sign', actorId='system'`) with metadata
   `{ autoCancelled: true, aggregateMode: 'any', aggregateCancelledBy,
   cancelledAssignees: [...] }`. Single row per event rather than one-per-sibling -
   keeps the timeline compact and matches the existing auto-approval record pattern.

The sign action is already whitelisted in the `approval_records_action_check`
constraint (see pack 1A test helper) so no migration was needed.

### Sibling re-approval rejection

When `approver-b` tries to approve after `approver-a` has won, the existing
`actorCanAct` guard returns **403 APPROVAL_ASSIGNMENT_REQUIRED** because
`approver-b`'s row is no longer active. The task doc asked for 403 or 409;
we test for the actual current behavior (403).

### Parallel gateway (deferred)

The plan calls out parallel gateway (多分支并发审批) as a follow-up slice.
True parallel fan-out requires multi-currentNodeKey state, concurrent branch
completion tracking, and merge synchronization - none of which the current
`ApprovalGraphResolution.currentNodeKey: string | null` shape supports.
That is WP2 scope; this PR only adds any-mode first-wins on a single node.

## Files changed

### Backend

- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
  - `ApprovalGraphResolution` extended with `aggregateMode` and `aggregateComplete`.
  - `resolveFromNode` now accepts a completion context and threads it into every
    return shape.
  - `resolveAfterApprove` records `aggregateMode`/`aggregateComplete: true` derived
    from the current node.
  - `getApprovalNodeAssigneeIds()` added as a small accessor for callers that need
    the static configured list (kept unused in-route; retained for future WP2 use).

- `packages/core-backend/src/services/ApprovalProductService.ts` (dispatchAction approve path,
  around line 1252 onward)
  - Added an `approvalMode === 'any'` branch that:
    - Deactivates the actor's assignment via the existing helper.
    - Computes `aggregateCancelledAssigneeIds` from sibling active assignments.
    - Updates sibling rows with the new metadata merge SQL.
  - Kept the `'all'` short-circuit and the `else` (single / default) blanket deactivation.
  - Added `aggregateCancelled: string[]` to the approve record metadata when applicable.
  - Added the aggregated `action='sign'` audit record insertion.

### OpenAPI

- `packages/openapi/src/base.yml` - documented new optional metadata keys on
  `ApprovalAssignmentDTO.metadata`. No endpoint shape changes.

### Tests

- `packages/core-backend/tests/unit/approval-graph-executor.test.ts`
  - Added an any-mode test verifying `aggregateMode`, `aggregateComplete`,
    and `getApprovalNodeAssigneeIds()`.
- `packages/core-backend/tests/integration/approval-wp1-any-mode.api.test.ts`
  - New integration test covering first-wins resolution, sibling cancellation
    metadata, the 403 re-approval path, and timeline history content.

### Frontend

- `apps/web/src/views/approval/ApprovalDetailView.vue`
  - Timeline rendering: differentiated `会签完成` vs `或签完成` badges.
  - Added `aggregateCancelled` assignee list badge and the
    `已被 {approver} 的决定覆盖` muted note for `action='sign'` auto-cancel rows.
  - `hasTimelineMetadata()` extended to include the new keys.
  - `actionLabel()` now maps `'sign'` to `签字` (or `自动失效` when `autoCancelled`).

- `apps/web/src/approvals/api.ts`
  - `mockApproval()` emits an any-mode assignment shape on `index % 5 === 1`.
  - `mockHistory()` appends an any-mode approve event plus the matching sign
    audit row so the dev-mode timeline always exercises the new UI branch.

## Data shape - aggregateCancelled flow

```
DB approval_assignments row (sibling):
  is_active: false
  metadata: {
    aggregateCancelledBy: "approver-a",
    aggregateCancelledAt: "2026-04-20T12:32:23.123Z",
    aggregateMode: "any"
  }

DB approval_records row (approve):
  action: "approve"
  actor_id: "approver-a"
  to_status: "approved"
  metadata: {
    nodeKey: "approval_any",
    nextNodeKey: null,
    approvalMode: "any",
    aggregateComplete: true,
    aggregateCancelled: ["approver-b"]
  }

DB approval_records row (sign audit):
  action: "sign"
  actor_id: "system"
  to_status: "approved"
  metadata: {
    nodeKey: "approval_any",
    autoCancelled: true,
    aggregateMode: "any",
    aggregateCancelledBy: "approver-a",
    cancelledAssignees: ["approver-b"]
  }
```

## Follow-ups

- **Parallel gateway** (WP2): multi-branch fan-out + merge join.
- **Assignee name resolution on the cancelled note**: the UI currently renders the raw
  userId; once the approval store exposes a userId -> display-name map in detail view,
  swap `cancelledAssigneesLabel` to use the display name.
- **Quorum / majority voting**: possible extension of any-mode where N-of-M approvals
  are required. Not in WP1 scope; would need both an executor policy knob and a
  new aggregation state machine.
