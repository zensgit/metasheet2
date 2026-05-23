# Approval Phase 2 AssigneeResolver Hardening Development 2026-05-23

Base: `origin/main@2d50cc51d` (`test(multitable): basic-views logged-in UI smoke (#1780 follow-up) (#1798)`)
Branch: `codex/approval-assignee-resolver-hardening-20260523`
Scope: post-merge hardening for #1797 (`feat(approval): add dynamic assignee resolver`)
Predecessor: `docs/development/approval-phase2-assignee-resolver-development-20260523.md`

## Summary

This slice closes the three non-blocking observations (O1/O2/O3) flagged by Claude's independent review of PR #1797. It is a small, behavior-preserving hardening PR.

It does NOT unlock any further Phase 2 item.

## Scope

### In scope (per user spec)

- `packages/core-backend/src/services/ApprovalAssigneeResolver.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/tests/unit/approval-admin-jump-service.test.ts`
- `packages/core-backend/tests/unit/approval-product-service.test.ts` *(no change required — existing coverage already adequate)*
- `packages/core-backend/tests/unit/approval-assignee-resolver.test.ts` *(no change required — O2 is comment-only)*
- `docs/development/approval-phase2-assignee-resolver-hardening-development-20260523.md`
- `docs/development/approval-phase2-assignee-resolver-hardening-verification-20260523.md`

### Phase 2 후속项 — 仍冻结

The PR #1794 / #1797 forward gate remains intact. These items stay frozen pending K3 GATE PASS, a named K3 gate blocker, or a separate explicit user opt-in with its own scope gate:

- `approval_trigger_bindings`
- public-form / multitable approval trigger source-snapshot and trigger-event paths
- approval result backwrite to multitable records
- automation `start_approval` action
- approval completion event bridge for automation triggers

### Untouched (explicit)

- migrations
- routes
- UI
- automation (other than the still-frozen `start_approval`)
- SLA / breach
- Workflow Designer / BPMN
- add-sign / countersign

## Implementation

### O1 — adminJump dynamic-source end-to-end coverage

`tests/unit/approval-admin-jump-service.test.ts` gains:

- `buildDynamicTargetGraph()` — linear graph with `finance_review` carrying `assigneeSources: [{ kind: 'requester' }]`, no `autoApproval` policy. Used to prove the resolver runs at admin-jump entry without composing with PR2.
- `buildDynamicRequesterMergeGraph()` — same shape but policy enables `autoApproval.mergeWithRequester`, so admin-jump into the dynamic target triggers the existing PR2 cascade and advances past `finance_review` to `director_review`.
- `it('O1a admin jump into a dynamic assigneeSources target resolves via the resolver and persists metadata', ...)` — asserts:
  - no `approval_templates` / `approval_template_versions` / `active_version_id` reads;
  - old `manager-1` assignment deactivated;
  - new assignment for `finance_review` is `requester-1` with `metadata.resolvedFrom = { kind: 'requester', sourceIndex: 0 }`;
  - jump record metadata names `newAssignees` with the dynamically-resolved id and node;
  - no PR2 auto-approve audit record is emitted (graph has no policy).
- `it('O1b admin jump into a dynamic assigneeSources target composes with PR2 mergeWithRequester cascade past the dynamic node', ...)` — asserts:
  - cascade emits a `system:auto-approval` record with `reason: 'auto-merge-requester'` and `originalApprover: { type: 'user', id: 'requester-1' }`, proving the dynamic resolver fed the cascade;
  - the only DB assignment insert is the post-cascade `director-1` (static, no `resolvedFrom`);
  - instance update advances `currentNodeKey` to `director_review`, `current_step` to `3`;
  - no active-template reads.

`mockAdminJumpQueries` is extended with a mock branch for `SELECT assignment_type, assignee_id, node_key FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE` (returns `{ rows: [], rowCount: 0 }`). This SELECT is fired by `assertNoActiveAssignmentConflicts` whenever a dynamic-source assignment is inserted; pre-hardening the helper was never exercised through admin-jump in this test file because no dynamic-target admin-jump case existed yet.

These two tests turn the "adminJump + dynamic source + PR2 cascade" composition from transitive coverage (resolver, admin-jump-static, dispatch-with-dynamic each tested separately) into direct coverage.

### O2 — formSchema runtime semantics comments (no behavior change)

Two comment blocks added:

- `packages/core-backend/src/services/ApprovalAssigneeResolver.ts` — block above `assertFormUserSource` explains that publish-time `validateApprovalAssigneeSourcesAgainstFormSchema` is the source of truth, runtime callers (dispatch / adminJump / return) intentionally omit `formSchema` because they must read only the frozen runtime graph + instance snapshots, and the runtime check is belt-and-suspenders only. Explicit warning against converting this into an active-template lookup.
- `packages/core-backend/src/services/ApprovalProductService.ts` — block above `buildApprovalAssignmentResolver` documents why `formSchema` is optional: createApproval supplies it, dispatch/adminJump deliberately do not, and future refactors must not fetch a schema from active template tables at runtime.

### O3 — `isDynamicallyResolvedAssignment` helper + comments

`assertNoActiveAssignmentConflicts` previously used an inline `assignments.every(a => !isRecord(a.metadata) || !isRecord(a.metadata.resolvedFrom))` early return. That phrasing buries the contract that `metadata.resolvedFrom` is the dynamic-source discriminator.

This slice extracts a private predicate `isDynamicallyResolvedAssignment(assignment): boolean` and replaces the inline check with `if (!assignments.some(a => this.isDynamicallyResolvedAssignment(a))) return`. The predicate is logically equivalent to the previous inline check (`every(!A || !B)` ≡ `!some(A && B)` by De Morgan), so behavior is unchanged.

A multi-paragraph comment above the helper documents:

- `metadata.resolvedFrom` is written ONLY by `ApprovalAssigneeResolver` (sole producer);
- legacy static assignments never carry it;
- the guard intentionally skips the extra DB SELECT for legacy/static batches because static parallel-branch duplicates are refused at template validation time;
- explicit anti-refactor rule: do NOT strip `metadata.resolvedFrom` from dynamic assignments before they reach `insertAssignments`, and prefer adding a new explicit flag rather than reusing this one.

### Files Touched (3)

- `packages/core-backend/src/services/ApprovalAssigneeResolver.ts` — O2 comment only
- `packages/core-backend/src/services/ApprovalProductService.ts` — O2 comment (resolver builder) + O3 helper extraction + O3 comment block
- `packages/core-backend/tests/unit/approval-admin-jump-service.test.ts` — O1 graph builders + O1a + O1b tests + mock branch for conflict-guard SELECT

No other files in the in-scope list required changes for this slice.

## Code Anchors for the 3 Observations

| Observation | Anchor |
|---|---|
| O1 | `tests/unit/approval-admin-jump-service.test.ts` — `buildDynamicTargetGraph`, `buildDynamicRequesterMergeGraph`, `O1a admin jump into a dynamic assigneeSources target ...`, `O1b admin jump into a dynamic assigneeSources target ... cascade past the dynamic node` |
| O2 | `services/ApprovalAssigneeResolver.ts` — comment above `assertFormUserSource`; `services/ApprovalProductService.ts` — comment above `buildApprovalAssignmentResolver` |
| O3 | `services/ApprovalProductService.ts` — `isDynamicallyResolvedAssignment` predicate + documentation block; updated `assertNoActiveAssignmentConflicts` early return |

## Forward Gate (Unchanged from #1794 / #1797)

The Resolver implementation slice remains the ONLY unlocked Phase 2 item. Re-entry for any other Phase 2 surface requires:

1. K3 GATE PASS (lifts stage-1 lock), OR
2. A named K3 PoC requirement points to a specific item as gate blocker, OR
3. Explicit user opt-in unlocking that item with its own scope gate.

This hardening PR does NOT change the gate.
