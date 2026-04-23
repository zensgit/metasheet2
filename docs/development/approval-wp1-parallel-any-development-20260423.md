# Approval WP1 Parallel Join-Any Development - 2026-04-23

## Scope

This change closes the first deferred follow-up from the WP1 parallel gateway delivery: `joinMode='any'`.

Before this change the type and template-validation layers accepted `joinMode='any'`, but runtime execution rejected it:

- initial parallel fork path threw for non-`all`;
- post-approve parallel branch advancement threw for non-`all`.

## Runtime Semantics

`joinMode='any'` means first branch to reach the configured `joinNodeKey` wins.

Implemented behavior:

- Parallel fan-out still creates active assignments for all pending branch frontiers when no branch reaches the join immediately.
- If a branch reaches the join during initial fan-out through only cc / auto-approval work, that branch wins immediately and no sibling approval assignments are created.
- Initial fan-out join-any preserves any cc / auto-approval events accumulated before the parallel node.
- If an active branch reaches the join after an approval action, the executor advances past the join immediately instead of waiting for sibling branches.
- The service cancels sibling branch assignments before inserting post-join assignments.
- The instance metadata key `parallelBranchStates` is stripped after leaving the parallel region.

Deferred behavior remains unchanged:

- return-to-node while inside an active parallel region is still rejected with `APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED`;
- nested parallel remains rejected by template validation;
- overlapping approvers across branches remain rejected.

## Service-Layer Cancellation

The executor is pure and does not mutate assignments. `ApprovalProductService.dispatchAction()` now handles join-any sibling cancellation after it receives a post-join resolution from `resolveAfterApproveInParallel()`.

Cancellation rules:

- only applies when the current instance is in a parallel region;
- only applies when `parallelState.joinMode === 'any'`;
- only applies when the resolution leaves the parallel fork node;
- marks active sibling branch assignments inactive before new post-join assignments are inserted;
- annotates cancelled assignment metadata with `parallelCancelledBy`, `parallelCancelledAt`, `parallelJoinMode`, and `parallelNodeKey`;
- emits a `sign` audit row with `parallelAutoCancelled=true`.

This mirrors existing approval-node `approvalMode='any'` first-wins cancellation without changing assignment uniqueness constraints.

## Files

- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/tests/unit/approval-graph-executor.test.ts`
- `packages/core-backend/tests/integration/approval-wp1-parallel-gateway.api.test.ts`

## Non-Goals

- No database migration.
- No OpenAPI schema change; `joinMode='any'` was already part of the contract.
- No frontend UI change; the post-join DTO returns to linear state just like join-all.
