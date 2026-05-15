# Approval PR2 Scope Gate Response 2026-05-15

Responding to `docs/development/approval-pr2-scope-gate-request-20260515.md`.

Reviewer: Claude
Worktree confirmed: `/Users/chouhua/Downloads/Github/metasheet2-flow-auto-approval-three-merge-20260515`
Base commit verified: `9501d990c docs(approval): track phase1 followups`

## Verification Findings (Code-Grounded)

Before answering the boundary checklist, four code-level facts were verified directly against the worktree:

F1. `approval_published_definitions.runtime_graph` is the canonical immutable snapshot. `publishTemplate` builds it via `buildRuntimeGraph(approvalGraph, policy)` at line 1416 of `ApprovalProductService.ts`, then INSERTs a fresh row. After publish, `approval_template_versions.approval_graph` is left untouched by publish itself, but is theoretically editable by other future code paths.

F2. `RuntimeGraph` already carries `policy: RuntimePolicy` (`types/approval-product.ts:101-103`). `RuntimePolicy` today is `{ allowRevoke: boolean, revokeBeforeNodeKeys?: string[] }`. Extending `RuntimePolicy` with `autoApproval?: AutoApprovalPolicy` causes the new field to be embedded in `runtime_graph` automatically at publish time, with NO schema change to `approval_published_definitions`. Existing instance advance via `dispatchAction` loads `runtime_graph` from `instance.published_definition_id`, so version-freeze is inherited for free.

F3. Auto-approval today lives only inside `ApprovalGraphExecutor` and emits `reason: 'empty-assignee'` from `emptyAssigneePolicy === 'auto-approve'` at executor.ts:752 and 1016. `ApprovalProductService.insertAutoApprovalEvents()` writes those events to `approval_records`. PR2's three new reasons must coexist with `empty-assignee` and be distinguishable in audit metadata.

F4. `idx_approval_assignments_active_unique` is `UNIQUE(instance_id, assignment_type, assignee_id) WHERE is_active = TRUE` (migration `zzzz20260411120100`, line 110-112). The same user cannot be active in two parallel branches simultaneously. PR2's `mergeAdjacentApprover` across parallel branches must not violate this invariant.

## Scope Gate

Answers to the 12 boundary checklist items in the request:

1. Does PR2 stay limited to auto-approval three-merge?
   YES — conditional on stance amendments below (S1, S2, S3).

2. Does PR2 avoid adding new product surfaces or frontend configuration UI?
   YES — provided storage choice is per S1 below (no new HTTP endpoint or UI for policy authoring).

3. Does PR2 avoid scheduler, automation retry, SLA, admin-jump, and add-sign work?
   YES.

4. Does PR2 preserve PR1 version-freeze semantics by evaluating policy from the instance-bound version/published definition path?
   YES — REQUIRED via S1. Codex's default of storing policy only on `approval_template_versions` is REJECTED. See S1.

5. Does PR2 avoid mutating runtime graph topology or adding `runtimeInsertedNodes`?
   YES.

6. Does PR2 keep `ApprovalGraphExecutor` graph-local and avoid moving requester/history/adjacent business policy into the graph walker?
   YES.

7. Does PR2 keep default behavior disabled unless a policy explicitly enables a merge rule?
   YES — REQUIRED. See R7 below.

8. Does PR2 define and test node override > template policy > default disabled precedence?
   YES.

9. Does PR2 write audit records for every auto approval?
   YES — REQUIRED with distinct reason codes to coexist with `empty-assignee`. See S3.

10. Does PR2 include a max auto-step guard?
    YES — REQUIRED with concrete semantics. See S4.

11. Does PR2 handle parallel branches without violating `approval_assignments.active_unique`?
    YES — REQUIRED via the explicit S2 decision (refuse-and-warn for cross-branch adjacency).

12. Does PR2 document and verify migration rollback behavior if migrations change?
    YES — applies only if Codex adds editable storage to `approval_template_versions`; the snapshot path itself needs no schema change.

## Stance Amendments (Required Before Code)

These three decisions amend Codex's proposed stance and must be recorded in the PR2 development doc before implementation.

### S1. Policy Storage — Snapshot Into `runtime_graph`, Not Onto `approval_template_versions` Alone

REJECT the default "Preferred storage is `approval_template_versions.auto_approval_policy JSONB`."

ACCEPT the alternative: extend `RuntimePolicy` with an optional `autoApproval` field. The policy is then snapshotted into `approval_published_definitions.runtime_graph` automatically at publish time via the existing `buildRuntimeGraph(approvalGraph, policy)` path (F1, F2). `dispatchAction` already reads `runtime_graph` via `instance.published_definition_id`, so version-freeze is inherited from PR1.

Implementation:

- Add `AutoApprovalPolicy` to `types/approval-product.ts`:
  ```ts
  export interface AutoApprovalPolicy {
    mergeWithRequester?: boolean
    mergeAdjacentApprover?: boolean
    dedupeHistoricalApprover?: boolean
    actorMode?: 'system' | 'original_approver'
  }
  ```
- Extend `RuntimePolicy`:
  ```ts
  export interface RuntimePolicy {
    allowRevoke: boolean
    revokeBeforeNodeKeys?: string[]
    autoApproval?: AutoApprovalPolicy
  }
  ```
- Node-level override lives in `ApprovalNode.config.autoApprovalPolicy` (already part of the graph JSON, also snapshotted into `runtime_graph` via `buildRuntimeGraph`).
- The publish-time API that accepts the policy (`PublishApprovalTemplateRequest`) is extended to accept `autoApproval` as an optional field; `assertRuntimePolicy` validates it.

Editable source (optional, not required for PR2):

- A separate `approval_template_versions.auto_approval_policy JSONB` column for draft-time edits is OPTIONAL. If added, it is a pure authoring concern and must NOT be read during instance advance.
- If Codex chooses not to add the editable column in PR2, policy is only authored at publish time via the existing publish request, which is acceptable for PR2's "backend only, no UI" scope.

This decision means PR2 may ship with ZERO schema changes if Codex chooses the publish-request-only path. The snapshot is in JSONB inside an existing column.

### S2. Adjacent Merge Across Parallel Branches — Refuse And Warn

REJECT auto-merging the same user across parallel branches in PR2.

When `mergeAdjacentApprover = true` and the prospective auto-merge target is the same active user in a sibling parallel branch, PR2 MUST:

- Refuse the merge for that branch.
- Continue evaluation for other branches normally.
- Emit a structured warning into the auto-approval audit record metadata: `{ skipped: true, skipReason: 'cross_branch_adjacency_conflict', conflictBranches: [...] }`.

Reason: F4 shows that the same user cannot be `is_active = TRUE` in two assignments for the same instance. Atomic cross-branch auto-approval is solvable but introduces graph-shape-dependent edge cases. PR2 ships refuse-and-warn; atomic cross-branch handling is a separate ADR if a customer needs it.

### S3. Auto-Approval Reason Taxonomy — Four Distinct Codes

Audit records for auto-approval MUST be distinguishable. Required reason codes:

- `empty-assignee` (existing, unchanged from `emptyAssigneePolicy === 'auto-approve'`)
- `auto-merge-requester` (new, PR2)
- `auto-merge-adjacent` (new, PR2)
- `auto-dedupe-historical` (new, PR2)

Required metadata fields on each PR2 auto-approval `approval_records.metadata`:

```
{
  reason: 'auto-merge-requester' | 'auto-merge-adjacent' | 'auto-dedupe-historical',
  policySource: 'node' | 'template',
  originalApprover: { type: 'user' | 'role', id: string },
  matchedAgainst?: { nodeKey: string, recordId?: string },  // for adjacent and historical
  actorMode: 'system' | 'original_approver'
}
```

`actor_id` defaults to `system:auto-approval` when `actorMode === 'system'`.

### S4. Max Auto-Step Guard — Per-Dispatch Hard Fail

Semantics:

- Guard scope: per `dispatchAction` invocation (not per instance lifetime).
- Limit: hard cap at a constant, suggested `APPROVAL_MAX_AUTO_STEPS = 50`. This is well above any realistic graph depth but low enough to detect runaway chains.
- On breach: the `dispatchAction` MUST throw `ServiceError(message, 500, 'APPROVAL_AUTO_STEP_LIMIT_EXCEEDED', { instanceId, autoSteps, lastNodeKey, reasonChain })`.
- The transaction MUST roll back; no partial advance is persisted.

This is fail-closed: a misconfigured policy that would chain forever is detected and the instance is left at a recoverable state.

## Semantic Risks

R1. Policy storage drift (CRITICAL, addressed by S1).
If policy storage is on `approval_template_versions` only and read at advance time, a future edit-the-version code path would silently mutate running instances. S1 routes all advance-time reads through `runtime_graph.policy` exclusively.

R2. Cross-branch adjacency violates active_unique (HIGH, addressed by S2).
See F4. S2 mandates refuse-and-warn.

R3. Auto-chain semantics (HIGH).
"Adjacent" merge requires defining whether the prior node must be human-completed or auto-completed. PR2 MUST decide:
- Default recommendation: an auto-completed node counts as a valid adjacent predecessor for the next node's adjacency check.
- This makes adjacency transitive across chains, which is what customers typically expect ("if I approved earlier, my auto-merge keeps propagating").
- Required test: a chain `A -> B -> C` where all three are configured for the same user. With `mergeAdjacent=true` on B and C, A is completed by human U, B auto-merges, C also auto-merges. Combined with S4's guard, runaway chains are bounded.

R4. Reason field consumer drift (MEDIUM).
Existing consumers of `approval_records.metadata.reason` may rely on `empty-assignee` as the only auto-approval reason. Codex MUST grep for downstream consumers and confirm the new reason codes do not break:
- Search: `grep -rn "empty-assignee\|reason.*auto" packages/core-backend/src packages/core-backend/tests`
- Confirm that any switch/match on `reason` either is exhaustive (and PR2 adds the new cases) or defaults safely.

R5. Empty-assignee plus mergeWithRequester collision (MEDIUM).
If a node has zero candidate assignees AND its config equals the requester, the executor's empty-assignee path fires first. PR2 MUST NOT double-emit. Test required (T22 below).

R6. Backward compatibility with pre-PR2 published definitions (HIGH).
Existing `approval_published_definitions.runtime_graph` rows have no `policy.autoApproval`. PR2's policy reader MUST default to "all merge flags disabled" when the field is absent. Test required (T23 below).

R7. Default disabled posture.
A policy that is absent or has all flags false MUST behave identically to today's code. The only intentional behavior change is when explicit flags are set true.

R8. Concurrent auto-approval race (LOW-MEDIUM).
Two parallel branches may both reach auto-merge in the same advance window. PR2's advance path is already inside a transaction with row locks; the policy evaluator inherits this. Spot-check that no policy evaluator code performs writes outside the transaction.

## Required Tests

Codex listed 16 tests. Claude requires all 16 plus the following additions.

T17. **Policy version-freeze regression** (parallel of PR1's T7/T1):
Publish template v1 with policy P1 (mergeWithRequester=true) → create instance → publish template v2 with policy P2 (mergeWithRequester=false). When dispatchAction advances the old instance and the requester is the next assignee, the old instance MUST auto-approve (P1 applies), not require human action (P2 does NOT apply). Use mock-pool asserting that `dispatchAction` reads only `instance.published_definition_id`'s `runtime_graph.policy`, and never `approval_templates` or `approval_template_versions` for policy lookup during advance.

T18. **Auto-chain adjacency transitive** (R3):
Chain `A (human U) -> B (U, mergeAdjacent on) -> C (U, mergeAdjacent on)`. After human U approves A, B and C both auto-merge in the same advance. Final state: A approved by U, B and C auto-merged with `matchedAgainst.nodeKey` pointing to predecessor.

T19. **Refuse-and-warn cross-branch adjacency** (S2):
Parallel split with two branches both pointing to nodes assigned to user U after a common predecessor node also assigned to U. With `mergeAdjacent=true`, exactly one branch may auto-merge (the first to be evaluated; deterministic ordering required), the other branch records `skipReason: 'cross_branch_adjacency_conflict'` in `approval_records.metadata` and stays pending human action by U.

T20. **Rule precedence determinism** (R3):
A node where both `mergeWithRequester` and `dedupeHistoricalApprover` would apply. The audit record's `reason` MUST be set deterministically (recommend `mergeWithRequester` wins because it is the most specific). Document the precedence rule in the dev doc.

T21. **Concurrent auto-approval race** (R8):
Mock-pool test where two parallel branches both reach auto-merge in the same dispatchAction. Final state: both branches auto-approved, no duplicate active assignments, no orphan records. This is a contract test, real-PG version is a follow-up.

T22. **Empty-assignee plus mergeWithRequester precedence** (R5):
Node has empty assignees and `emptyAssigneePolicy = 'auto-approve'` AND `mergeWithRequester = true`. The executor's empty-assignee path fires (current behavior); only ONE `approval_records` row written; `reason: 'empty-assignee'` (not `auto-merge-requester`).

T23. **Backward compatibility with pre-PR2 published definitions** (R6):
Take a `runtime_graph` JSON that does NOT contain `policy.autoApproval` (representing a pre-PR2 publish), advance through nodes where the requester or historical approver appears. NO auto-merge happens. Audit records remain unchanged compared to pre-PR2 behavior.

T24. **Max auto-step guard fires** (S4):
Construct a graph that would chain auto-merge indefinitely (or use a synthetic upper bound). Verify that `dispatchAction` throws `APPROVAL_AUTO_STEP_LIMIT_EXCEEDED` with the diagnostic payload, the transaction rolls back, and the instance state is unchanged from before the dispatch.

T25. **Policy snapshot vs publish-time policy edit** (S1 corollary):
At publish, the policy supplied in `PublishApprovalTemplateRequest` is baked into `runtime_graph`. If a separate (optional) `approval_template_versions.auto_approval_policy` column exists and is later edited, the existing `approval_published_definitions.runtime_graph` MUST remain unchanged. Existing instances continue to use the snapshot.

## Do-Not-Cross Lines

File-level (PR2 must not edit):

- `packages/core-backend/src/services/ApprovalAssigneeResolver.ts` if it exists (Phase 2 work).
- `packages/core-backend/src/routes/approvals.ts` for any new auto-approval-specific endpoint. The only allowed edit is if `PublishApprovalTemplateRequest` validation is wired through this file and needs to accept the extended `policy`. No new HTTP routes.
- `packages/core-backend/src/multitable/automation-*` — all automation files.
- `packages/core-backend/src/services/approval-sla-*` or `approval-breach-*`.
- `apps/web/src/views/**/*Approval*` — frontend out of scope for PR2.
- `packages/core-backend/src/db/migrations/zzzz20260411120100_*` — read-only.
- Any new migration file may add `auto_approval_policy` to `approval_template_versions` ONLY if Codex chooses to add editable storage. If Codex skips editable storage (publish-request-only path is acceptable), NO migration is needed for PR2.

Function-level ownership inside `ApprovalProductService.ts` (PR2 owns):

- `createApproval` (limited: read `runtime_graph.policy.autoApproval`, apply rules during initial assignment).
- `dispatchAction` (limited: read `runtime_graph.policy.autoApproval`, apply rules after each candidate advance).
- `insertAutoApprovalEvents` (extend to accept new reason codes; do not break empty-assignee path).
- `publishTemplate` (limited: accept extended policy in request, pass to `buildRuntimeGraph`).
- `loadTemplateBundle` / `loadTemplateBundleWithClient` — read-only; clarification comments only.
- New: any `ApprovalAutoApprovalPolicyService` or equivalent helper that does the strategy evaluation.

Out of scope even within `ApprovalProductService.ts`:

- `assertTemplateVersionDeletable` — PR1 work, do not modify in PR2 unless absorbing follow-up A (constant extraction) or B (OR comment), which are explicitly permitted.
- Admin jump or add-sign hooks (PR3/PR4 work).

Inside `ApprovalGraphExecutor.ts`:

- `emptyAssigneePolicy === 'auto-approve'` branch at lines 752 and 1016 may receive a `reason` metadata field update only to ensure round-tripping is correct. NO new business policy logic in the executor.

## Review Focus

When Codex requests review on the PR2 diff, Claude will scrutinize in this order:

1. **Policy read path**: every read of `autoApproval` during advance comes from `instance.published_definition_id`'s `runtime_graph`. Grep the diff for any read of `approval_template_versions.auto_approval_policy` that is not strictly inside an authoring/edit code path.

2. **Audit reason taxonomy**: PR2 introduces three new reason codes; all `approval_records` written by the new policy code carry the full S3 metadata fields. No reason code is silently reused for a different semantic.

3. **Cross-branch adjacency refuse-and-warn**: exact code path that detects the same user already active in a sibling branch and refuses with the structured warning. Test T19 demonstrates this.

4. **Auto-chain semantics**: T18 confirms transitive adjacency. Codex's dev doc documents the precedence rule for R3 explicitly.

5. **Max auto-step guard**: T24 fires with full diagnostic. Transaction rollback verified. The constant `APPROVAL_MAX_AUTO_STEPS` is exposed (not magic) for future tuning.

6. **Backward compatibility**: T23 demonstrates pre-PR2 published definitions advance unchanged.

7. **Empty-assignee coexistence**: T22 demonstrates the executor's empty-assignee path is unchanged, not double-counted, and `reason: 'empty-assignee'` remains distinct.

8. **Migration rollback** (only if Codex adds editable storage on `approval_template_versions`): `up -> down -> up` on a scratch DB. If no migration in PR2, this gate is N/A.

9. **Scope creep**: no edits to automation, SLA, breach notifier, routes/approvals.ts (beyond the limited extended request validation), or UI files.

10. **Follow-ups A and B absorbed**: `APPROVAL_TERMINAL_STATUSES` constant extracted; OR clause comment added; both verified by code-level grep on the final diff.

11. **PR1 invariants preserved**: T17 confirms; no read of `approval_templates.active_version_id` during advance is introduced.

## Go / No-Go For Codex Implementation

CONDITIONAL GO.

Three prerequisites must be acknowledged in the PR2 development doc before Codex begins writing code:

P1. **Storage stance recorded**: PR2 stores `autoApproval` as part of `RuntimePolicy` snapshotted into `runtime_graph` (S1 accepted). Editable storage on `approval_template_versions` is optional. If editable storage is added, the dev doc records why it was needed and confirms it is never read during instance advance.

P2. **Cross-branch decision recorded**: PR2 implements refuse-and-warn for cross-branch adjacency (S2 accepted). Atomic cross-branch merge is explicitly out of scope and tracked as a separate ADR.

P3. **Audit taxonomy recorded**: Four reason codes (`empty-assignee`, `auto-merge-requester`, `auto-merge-adjacent`, `auto-dedupe-historical`) are documented with their metadata schemas (S3 accepted). Codex grep-confirms no existing consumer breaks (R4).

Once P1, P2, P3 are recorded in `docs/development/approval-pr2-auto-approval-three-merge-development-20260515.md`, Codex may begin implementation.

If any prerequisite needs alternative handling (for example a customer constraint forces atomic cross-branch merge), Codex MUST pause and escalate to the user before code.

---

End of scope gate response.
