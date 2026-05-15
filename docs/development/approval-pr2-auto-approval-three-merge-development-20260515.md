# Approval PR2 Auto-Approval Three-Merge Development 2026-05-15

## Scope Gate Acknowledgement

Source gate:

- `docs/development/approval-pr2-scope-gate-request-20260515.md`
- `docs/development/approval-pr2-scope-gate-response-20260515.md`

Decision: conditional GO accepted. Codex will implement only after the following
three prerequisites are recorded here.

### P1. Storage Stance

PR2 stores `autoApproval` as part of `RuntimePolicy`, which is snapshotted into
`approval_published_definitions.runtime_graph` by the existing
`buildRuntimeGraph(approvalGraph, policy)` publish path.

Implementation stance:

- Extend `RuntimePolicy` with `autoApproval?: AutoApprovalPolicy`.
- Extend `PublishApprovalTemplateRequest.policy` validation to accept optional
  `autoApproval`.
- Do not add `approval_template_versions.auto_approval_policy` in PR2.
- During existing-instance advance, read policy only from the instance-bound
  `published_definition_id` runtime graph.

Reason:

This preserves PR1 version-freeze semantics without a migration. Mutable
template/version authoring storage can be added later, but it must never become
the advance-time source of truth.

### P2. Cross-Branch Decision

PR2 implements refuse-and-warn for cross-branch adjacent merge.

Implementation stance:

- Do not atomically auto-merge the same user across sibling parallel branches.
- When `mergeAdjacentApprover` would conflict with an active sibling branch for
  the same assignee, skip the merge for that target and record structured
  metadata:
  - `skipped: true`
  - `skipReason: 'cross_branch_adjacency_conflict'`
  - `conflictBranches: [...]`
- Atomic cross-branch merge is out of scope for PR2 and requires a separate ADR.

Reason:

`approval_assignments` has a partial active-unique index on
`(instance_id, assignment_type, assignee_id)`. PR2 must not weaken that invariant
or introduce ambiguous parallel branch state.

### P3. Audit Taxonomy And Consumer Check

Required reason codes:

- `empty-assignee`
- `auto-merge-requester`
- `auto-merge-adjacent`
- `auto-dedupe-historical`

Required metadata for PR2 auto-approval records:

```json
{
  "reason": "auto-merge-requester | auto-merge-adjacent | auto-dedupe-historical",
  "policySource": "node | template",
  "originalApprover": { "type": "user | role", "id": "..." },
  "matchedAgainst": { "nodeKey": "...", "recordId": "..." },
  "actorMode": "system | original_approver"
}
```

`matchedAgainst` is required only for adjacent and historical matches.

`actor_id` defaults to `system:auto-approval` when
`actorMode === 'system'`.

Reason consumer grep:

```bash
rg -n "empty-assignee|reason.*auto|autoApproved|metadata\\.reason|reason\\]" packages/core-backend/src packages/core-backend/tests
```

Result before code:

- Runtime consumers are limited to `ApprovalGraphExecutor` emitting
  `empty-assignee` and `ApprovalProductService.insertAutoApprovalEvents()`
  persisting metadata.
- Existing test consumers assert `empty-assignee` and `autoApproved` metadata.
- No production switch or exhaustive match on `metadata.reason` was found.

## Implementation Plan

- Add `AutoApprovalPolicy`, reason-code types, and
  `APPROVAL_TERMINAL_STATUSES` to `types/approval-product.ts`.
- Extend runtime policy normalization and snapshot construction in
  `ApprovalProductService.ts`.
- Add a small policy evaluator helper inside `ApprovalProductService.ts` or a
  dedicated `ApprovalAutoApprovalPolicyService` if the logic becomes too large.
- Apply auto-approval after graph resolution returns candidate assignments and
  before those assignments are inserted as active assignments.
- Loop through chained automatic resolutions until a human-pending node or a
  terminal state is reached, bounded by `APPROVAL_MAX_AUTO_STEPS = 50`.
- Keep `ApprovalGraphExecutor` graph-local; do not move requester/history/
  adjacent policy into the graph walker.
- Preserve existing empty-assignee auto-approval behavior and reason code.
- Absorb PR1 follow-ups A and B:
  - Extract `APPROVAL_TERMINAL_STATUSES`.
  - Add a short comment on the delete guard OR predicate.

## R3 Chain Semantics

Auto-completed approval nodes count as valid adjacent predecessors for later
`mergeAdjacentApprover` checks in the same `dispatchAction`.

Example:

- `A(U)` is approved by human `U`.
- `B(U)` has `mergeAdjacentApprover = true`, so B auto-approves against A.
- `C(U)` also has `mergeAdjacentApprover = true`, so C auto-approves against B.

This transitive behavior is intentional. It matches the customer expectation
that repeated consecutive approvals by the same person collapse after the first
human decision. The bounded loop is per dispatch and guarded by
`APPROVAL_MAX_AUTO_STEPS = 50`; exceeding the guard throws
`APPROVAL_AUTO_STEP_LIMIT_EXCEEDED` and rolls back the transaction.

When multiple rules match the same assignment, precedence is deterministic:

1. `mergeWithRequester`
2. `mergeAdjacentApprover`
3. `dedupeHistoricalApprover`

The selected reason is the one persisted to `approval_records.metadata.reason`.

## Test Matrix

Codex will cover the original PR2 scope tests plus Claude additions T17-T25:

- requester merge on first approval node.
- requester merge after condition routing.
- adjacent merge across a `cc` node.
- cross-branch adjacent refuse-and-warn.
- historical approver dedupe.
- `all` mode waits for remaining human approvers.
- `any` mode completes the node and cancels/avoids siblings consistently.
- node override disabled beats template enabled.
- node override enabled beats template disabled.
- deterministic precedence when multiple rules match.
- full audit metadata for every PR2 auto approval.
- max auto-step guard rollback.
- empty-assignee behavior remains distinct and single-emission.
- pre-PR2 runtime graphs without `policy.autoApproval` behave unchanged.
- policy version-freeze regression using instance-bound runtime graph.

## Verification Targets

```bash
pnpm --filter @metasheet/core-backend exec vitest run packages/core-backend/tests/unit/approval-product-service.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run packages/core-backend/tests/unit/approval-graph-executor.test.ts --watch=false
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend build
pnpm type-check
```

Integration tests remain subject to the baseline DB environment blocker recorded
in `docs/development/approval-phase1-baseline-20260515.md`.
