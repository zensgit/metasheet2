# Approval Wave 2 WP1 — 并行分支 (Parallel Gateway) Development Notes

> Date: 2026-04-22
> Branch: `codex/approval-wp1-parallel-gateway-20260422`
> Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/wp1-parallel`
> Base: `origin/main @ 27a9b9de1`
> Scope: Close the Wave 2 WP1 flow-control trilogy by shipping end-to-end
> support for the `parallel` ApprovalNodeType (会签 + 或签 already delivered
> in Pack 1A and PR #1015 respectively).

## Chosen approach

**Approach A (additive / non-breaking)** — `ApprovalGraphResolution` gains
an optional `currentNodeKeys?: string[]` and an optional
`parallelState?: ParallelInstanceState`. Legacy consumers keep
`currentNodeKey` unchanged. When `currentNodeKeys.length >= 2` the caller
knows the instance is inside a parallel region.

Why not Approach B: any-mode (#1015) and Pack 1A both read
`currentNodeKey` directly from the resolution; replacing the field would
force a cascade of audit-row / assignment-metadata changes on those
already-shipped flows. Additive keeps Pack 1A and or-mode behavior
byte-for-byte unchanged.

## Data model delta

`packages/core-backend/src/types/approval-product.ts`:

- `ApprovalNodeType` now includes `'parallel'` (union addition).
- New `ParallelJoinMode = 'all' | 'any'`.
- New `ParallelNodeConfig { branches: string[]; joinMode; joinNodeKey }`.
  `joinNodeKey` is **required** — the walker uses it as the terminal
  signal per branch, and validation enforces that every branch edge's
  downstream path reaches it.
- `UnifiedApprovalDTO` gains `currentNodeKeys?: string[] | null`.

`packages/core-backend/src/services/approval-bridge-types.ts` mirrors
`currentNodeKeys` onto the bridge DTO (for parity with the product DTO).

`packages/core-backend/src/services/ApprovalGraphExecutor.ts`:

- New exports `ParallelBranchState` and `ParallelInstanceState`
  describe the per-instance branch map persisted in
  `approval_instances.metadata.parallelBranchStates`.
- `ApprovalGraphResolution.currentNodeKeys` and
  `ApprovalGraphResolution.parallelState` are both optional.

**No new DB columns.** The parallel branch-state map lives entirely in
the pre-existing `approval_instances.metadata` JSONB column, keyed by
`parallelBranchStates`. This avoids a migration and side-steps index
churn on `approval_assignments` (see "Storage & lookup rules" below).

## Engine semantics

### Walk path

`resolveFromNode` now recognises `type: 'parallel'`:

1. For each branch edgeKey, call a shared `resolveBranchAdvance` helper
   that walks until it either hits a pending approval (returns that
   branch's frontier + assignments) or the join node (branch already
   auto-complete via cc / auto-approve chain).
2. Aggregate per-branch assignments / cc events / auto-approval events.
3. If *every* branch auto-completed, recurse past the join node
   (`resolveFromNode(joinNodeKey)`).
4. Otherwise return a resolution whose `currentNodeKey` is the parallel
   fork node, `currentNodeKeys` lists pending branch frontiers,
   `assignments` carries the flattened per-branch pending assignments,
   and `parallelState` carries the initial branch-state map.

### Post-approve path

- Linear state: `resolveAfterApprove(currentNodeKey)` unchanged.
- Parallel state: new `resolveAfterApproveInParallel(branchNodeKey,
  state)` walks the actor's branch one "advance step":
  - Branch reaches another approval before the join → return a
    pending resolution with `currentNodeKey = parallelNodeKey` and the
    sibling frontiers preserved in `currentNodeKeys`; `parallelState`
    carries the updated map.
  - Branch reaches the join → mark this branch complete. If siblings
    still pending, return pending resolution; otherwise recurse past
    the join (`resolveFromNode(joinNodeKey)`) and return a linear
    resolution.

### Storage & lookup rules

- `instance.current_node_key = parallelNodeKey` while the parallel
  region is open (per advisor Option α — keeps the parallel "address"
  stable and lets the dispatch route derive the actor's branch from
  their active assignment's `node_key`).
- `instance.metadata.parallelBranchStates` persists
  `{ parallelNodeKey, joinNodeKey, joinMode, branches: { [edgeKey]: { currentNodeKey, complete } } }`.
- The route reads that back, picks the actor's branch node by matching
  an active assignment whose `node_key` is one of the pending branch
  frontiers, and passes the derived `branchNodeKey` into
  `resolveAfterApproveInParallel`.
- Once all branches report complete, the metadata key is stripped with
  `jsonb - 'parallelBranchStates'` so subsequent actions run the linear
  path.

### Return-to-node

`resolveReturnToNode` and `listVisitedApprovalNodeKeysUntil` are **not**
taught how to jump into or out of a parallel branch. The dispatch route
rejects `action: 'return'` while the instance is in a parallel region
with `APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED` (409). The linear walker
in `listVisitedApprovalNodeKeysUntil` still skips over a `parallel`
fork by jumping to its `joinNodeKey`, which keeps the post-join return
target set stable.

### Single-mode in a parallel branch

When the actor's branch is a default / single-mode approval node inside
a parallel region, `deactivateAllActiveAssignments` would nuke sibling
branches too. The route now scopes to
`deactivateActorAssignmentsAtNode(branchNodeKey, …)` while inside a
parallel region; linear state keeps the legacy blanket deactivation.

## Template-level validation

`normalizeApprovalGraph` grew a parallel post-pass:

- Every `branches` edgeKey must exist and must originate from the
  parallel node.
- `joinNodeKey` must reference a real node.
- Each branch's forward-reachable approval assignees are collected
  and **rejected if any assignee appears in two branches** — the
  `approval_assignments (instance_id, assignment_type, assignee_id)
  WHERE is_active=TRUE` unique index cannot represent the same user
  active in two branches at once (v1 limitation; see follow-ups).
- Nested parallel inside a branch is rejected.

The dev MD (you are reading) records this as a deliberate v1
trade-off. Integration test
`approval-wp1-parallel-gateway.api.test.ts` exercises the rejection.

## Route wiring (ApprovalProductService)

- `createApproval` copies `initial.parallelState` into the new
  instance's `metadata.parallelBranchStates` when the initial
  resolution lands inside a parallel region.
- `dispatchAction`:
  - Reads parallel state from `instance.metadata` at the start of the
    transaction.
  - Derives `actorBranchNodeKey` by scanning the actor's active
    assignments for one whose `node_key` matches a pending branch
    frontier.
  - Rejects `return` under parallel state with a typed error.
  - Keeps `revoke` unchanged (revokes the whole instance regardless).
  - Under parallel state with single-mode, deactivates only the
    actor's branch-node assignment instead of blanket-deactivating.
  - Selects `resolveAfterApproveInParallel` vs `resolveAfterApprove`
    based on `isInParallelRegion && actorBranchNodeKey`.
  - Updates `metadata.parallelBranchStates` (persist / refresh / strip)
    based on whether the resolution keeps us in, enters, or leaves a
    parallel region.
  - Adds `parallelNodeKey` and `parallelBranchComplete` markers to the
    approve-audit metadata for timeline UI.

## OpenAPI

`packages/openapi/src/base.yml`:

- `ApprovalNode.type` enum gains `parallel`.
- New `ApprovalParallelNodeConfig` schema documents `branches`,
  `joinMode`, `joinNodeKey`.
- `UnifiedApprovalDTO.currentNodeKeys` documented as the parallel
  frontier (length ≥ 2 signals parallel state).

## Frontend

- `apps/web/src/types/approval.ts` mirrors the new types, node type,
  and DTO field.
- `apps/web/src/views/approval/ApprovalDetailView.vue` renders a
  `并行中 · {labels}` badge in the header when `currentNodeKeys.length
  >= 2`, and switches the history timeline to a branch-grouped layout
  — one boxed section per branch approval node, plus an `其他` bucket
  for pre-fork (`created`, cc broadcasts). Linear-state rendering
  (`el-timeline` without groups) is used when the instance is not in
  a parallel region, so Pack 1A / or-mode detail views are unchanged.
- `apps/web/src/approvals/api.ts` mock factory grew a parallel
  fixture slot (`index % 7 === 3`) with two active branch
  assignments and a populated `currentNodeKeys` so dev mode exercises
  the UI branch without backend changes.

## Tests

- `packages/core-backend/tests/unit/approval-graph-executor.test.ts`
  gains two parallel cases: fork produces per-branch assignments +
  parallelState; fork-then-approve keeps instance pending with
  updated branch state, then join-all advances to the post-join
  frontier.
- `packages/core-backend/tests/integration/approval-wp1-parallel-gateway.api.test.ts`:
  - Template creation + publish + instance creation shows two active
    branches and `currentNodeKeys`.
  - First branch approval keeps instance pending, second closes.
  - Post-join `finance-review` completes the instance.
  - Audit records carry `parallelNodeKey` + `parallelBranchComplete`.
  - Return inside parallel → 409
    `APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED`.
  - Template validation rejects duplicate approver across branches
    with 400 `VALIDATION_ERROR`.

## Follow-ups (deferred)

1. `joinMode: 'any'` (first-branch-wins join) — executor currently
   throws. Needs sibling-branch cancellation audit trail similar to
   or-mode.
2. Return-to-node targeting an approval inside a closed parallel
   branch — requires the walker to pick a specific branch sub-region
   and replay it; the route currently rejects all returns while
   parallel is active.
3. Nested parallel (a branch whose internal sub-graph contains
   another parallel node) — rejected in template validation; would
   need recursive `parallelBranchStates` (tree instead of flat map).
4. Overlapping approvers across branches — blocked by template
   validation; could be unblocked by relaxing the unique index or by
   promoting each active assignment to carry a branch discriminator.
5. Any-mode (或签) inside a parallel branch whose sibling approvers
   also race — deactivation logic needs to be scoped to branch +
   actor, not just actor. Currently handled correctly via
   `deactivateActorAssignmentsAtNode(branchNodeKey, …)` so any-mode +
   parallel combination works, but there are no integration tests for
   that combo yet. Add a regression test in the next wave.
6. `RuntimePolicy.revokeBeforeNodeKeys` and parallel state —
   `instance.current_node_key` equals `parallelNodeKey` while
   parallel is active. Templates listing only branch-approval nodes
   in `revokeBeforeNodeKeys` will **block** revoke during the
   parallel region; template authors must include the parallel fork
   node key (or `finance_review` post-join) explicitly. Not
   automatically re-written by the service — revisit in a later wave
   if authoring ergonomics bite.

## Non-goals

- No DB schema change — all parallel state fits inside
  `approval_instances.metadata` JSONB.
- No changes to Pack 1A (`all` mode) or or-mode (`any` mode)
  semantics. Their integration tests pass unchanged on this branch.
- No visual flow diagram — existing timeline already separates per-
  `nodeKey` entries, which is sufficient for a minimum viable render.
