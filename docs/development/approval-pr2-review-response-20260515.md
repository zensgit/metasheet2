# Approval PR2 Review Response 2026-05-15

Reviewing PR2 `auto-approval-three-merge` (HEAD `fd58c7f19`) against scope gate `docs/development/approval-pr2-scope-gate-response-20260515.md` and Phase 1 §7.2 protocol.

Reviewer: Claude
Worktree: `/Users/chouhua/Downloads/Github/metasheet2-flow-auto-approval-three-merge-20260515`
Base verified: `9501d990c docs(approval): track phase1 followups`

## Verdict

CONDITIONAL APPROVE. One blocking finding (B1), trivially cheap to fix. Resolve B1, then merge.

Implementation quality is high. S1 version-freeze inheritance via `RuntimePolicy` snapshot is elegant and ships with zero migration. The cascade, double loop-guard, and cross-branch refuse-and-warn logic is careful and correct. R3 chain semantics are documented. All 9 Claude-required tests (T17-T25) are present; the two spot-checked (T17, T22) are effective.

## Blocking Correctness Issues

### B1. Empty-assignee actor_id change orphans a DB-gated integration assertion

What changed: `insertAutoApprovalEvents` (ApprovalProductService.ts diff lines 831-852) replaced the hardcoded `actorId: 'system', actorName: 'System'` with `actorId: actorIdForAutoApprovalEvent(event)`. For an `empty-assignee` event (no `actorMode`, no `originalApprover`), `actorIdForAutoApprovalEvent` returns `'system:auto-approval'`. So pre-existing empty-assignee auto-approval records now persist `actor_id = 'system:auto-approval'` instead of `'system'`.

This new value is correct and intended — scope gate S3 explicitly said `actor_id` defaults to `system:auto-approval` when `actorMode === 'system'`. The defect is not the behavior; it is the orphaned assertion.

Orphaned assertion: `packages/core-backend/tests/integration/approval-pack1a-lifecycle.api.test.ts:450`:

```js
const autoApproveRecord = historyResult.rows.find((row) =>
  row.action === 'approve' && row.actor_id === 'system' && row.metadata?.autoApproved === true)
expect(autoApproveRecord).toBeTruthy()
```

This finds the empty-assignee auto-approve record by `actor_id === 'system'`. Post-PR2 that record has `actor_id === 'system:auto-approval'`, so `find` returns undefined and `expect(...).toBeTruthy()` fails. PR2 did not update this file (confirmed: the file is not in the PR2 diff).

Why unit verification missed it: the unit suite (29 tests) does not assert `actor_id` on any auto-approval record (T22 asserts only `reason` and `nodeKey`). The assertion that breaks lives only in the integration suite, which is DB-gated (baseline failure: `database "chouhua" does not exist`) and was not run.

Why this is blocking, not a follow-up: `approval-pack1a-lifecycle.api.test.ts` was already red at baseline due to the DB environment, so in the current local run there is no "new" failure. But the failure reason changes: once the DB environment is repaired (or in CI with a real DB), this test fails on the assertion, not on connection. This is a latent regression masked by an unreachable-stack skip — the exact pattern documented in project memory ([[feedback_metasheet2_skip_when_unreachable_blind_spot]]) that let PR #1435 and #1436 escape. The Phase 1 merge gate intent is "do not introduce latent breakage." The fix is ~2 lines. Leaving it for later means whoever repairs the DB env gets a context-free failure.

Required fix (either is acceptable):

- Minimal: change line 450 to `row.actor_id === 'system:auto-approval'`.
- Better (recommended): drop the brittle actor_id literal and match on `row.action === 'approve' && row.metadata?.autoApproved === true && row.metadata?.reason === 'empty-assignee'`. This decouples the test from the actor-id taxonomy and is robust to future S3 evolution.

Also required (test-gap remediation, see Missing Tests M-T1): add a unit-level assertion pinning the auto-approval `actor_id` so future drift is caught locally without a live DB.

## Security/Permission Issues

None. The policy is read exclusively from the instance-bound `published_definition_id` runtime graph (verified: ApprovalProductService.ts:2392-2410 loads `runtime.runtime_graph` from `instance.published_definition_id`; the cascade consumes that `runtimeGraph`). No advance-time read of `approval_templates` or `approval_template_versions` for policy. T17 pins this.

## Missing Tests

No required test (T17-T25) is missing. Coverage map confirmed by test name:

- T17 — "uses the instance-bound runtime policy snapshot when auto-approving old instances" (line 1874). Spot-checked: line 1913 asserts the published-definition query param is the instance-bound `pub-old-policy`; line 1953-1954 throws if a human assignment is created (proving auto-merge fired from the frozen snapshot). Strong.
- T18 — "auto-approves adjacent same-user chains transitively after a human approval".
- T19 — "refuses and warns when adjacent merge would auto-approve duplicate parallel assignees".
- T20 — "uses deterministic requester precedence when multiple auto-approval rules match".
- T21 — "auto-approves independent parallel branches without duplicate active assignments".
- T22 — "does not double-emit when empty-assignee auto approval coexists with requester merge policy" (line 1590). Spot-checked: asserts exactly one auto record with `reason: 'empty-assignee'`. Effective for the double-emit concern.
- T23 — "keeps pre-pr2 runtime graphs without autoApproval behavior unchanged" (line 1646). Effective backward-compat.
- T24 — "rolls back when chained auto-approval exceeds the per-dispatch guard".
- T25 — "snapshots publish-time auto-approval policy into runtime_graph without a migration column".

Test gap (remediation tied to B1):

- M-T1: No unit test pins the persisted `actor_id` of any auto-approval record. Add to T22 (or a dedicated test) an assertion that the empty-assignee record carries `actor_id === 'system:auto-approval'`, and add a merge-rule test asserting that with `actorMode: 'original_approver'` the record carries the original user id. Had this existed, B1 would have been caught in the unit run.

## Scope Creep

None.

- `ApprovalGraphExecutor.ts`: +4 lines, type-only (import `ApprovalAutoApprovalReason`, widen `reason` union, add optional `metadata?`). No business policy moved into the graph walker. Graph-local preserved per scope gate.
- No edits to automation, SLA, breach notifier, admin-jump, add-sign, UI, or routes.
- Zero migration. `autoApproval` rides existing `runtime_graph.policy` JSONB (S1).
- PR1 follow-ups A (`APPROVAL_TERMINAL_STATUSES` constant, reused via `status <> ALL($2)`) and B (OR-predicate comment) absorbed as agreed.

## Naming/Maintainability

Non-blocking. Recommend addressing M1 and M2 in this PR if cheap; M3, M4 may be doc-only.

- M1: Skipped cross-branch events are written with `action: 'sign'` (diff line 840). `'sign'` is constraint-valid (migration `zzzz20260423120000` CHECK includes it) but semantically `'sign'` is a countersign action (PR4 territory). A skipped record is informational ("this branch was NOT auto-merged"). `metadata.skipped=true` + `skipReason` disambiguates, so this is non-blocking, but document the choice in the dev doc or consider `action: 'comment'`.
- M2: Deliberate dual identity — in-memory `appendAutoApprovalHistory` and DB-replay `loadApprovalHistory` both reconstruct `actorId = originalApprover.id`, while the persisted `approval_records.actor_id = 'system:auto-approval'`. This is necessary for transitive adjacency across dispatch boundaries and is correct, but subtle. Add a code comment at `loadApprovalHistory` and `appendAutoApprovalHistory` explaining the intentional divergence so a future maintainer does not "unify" them and silently break chains.
- M3: `asRuntimeGraph` now validates policy before graph (diff lines 217-232) to compute `allowParallelDuplicateAssignees`. Behavior-equivalent for valid stored graphs; only changes which error surfaces first for a doubly-malformed system-generated graph. Acceptable; a one-line note in the dev doc suffices.
- M4: A present-but-empty node override (`autoApprovalPolicy: {}`) yields `hasEnabledAutoApprovalRule({}) === false`, so `getEffectiveAutoApprovalPolicy` returns null and the node does NOT inherit the template policy. This is a defensible "explicit empty override = disabled" semantic and is consistent with the node-override-wins precedence, but it is not currently stated. Document it next to the precedence rule in the dev doc.

## Merge Gate (§7.3)

- Worktree clean: PASS
- Boundary checklist: PASS — S1 (snapshot in runtime_graph, zero migration), S2 (refuse-and-warn), S3 (4 reason codes + metadata), S4 (per-dispatch guard, hard fail + rollback) all honored. T17-T25 present.
- Claude review blocking findings: 1 (B1) — must resolve before merge.
- Targeted unit tests pass: PASS (approval-product-service 29, approval-graph-executor 14, full unit 2156).
- Integration: not run (DB-gated). B1 exists precisely because this gate is environmentally masked; B1 fix is mandatory for that reason.
- Build/type-check: PASS.
- Migration rollback: N/A (no migration) — correct.
- Verification doc committed: PASS.

## Required Before Merge

1. Fix B1: update `approval-pack1a-lifecycle.api.test.ts:450` (recommend the metadata-based matcher, not the actor_id literal).
2. Add M-T1: a unit assertion pinning auto-approval `actor_id` (empty-assignee → `system:auto-approval`; `actorMode: 'original_approver'` merge → original user id).
3. Re-run `pnpm --filter @metasheet/core-backend test:unit` and confirm still green after adding M-T1.
4. Record B1 + M-T1 resolution in `docs/development/approval-pr2-auto-approval-three-merge-verification-20260515.md`, and note in the verification doc that `approval-pak1a-lifecycle` remains DB-gated locally but the assertion was corrected to match the S3 actor taxonomy (so the next env repair does not surface a surprise failure).

## Recommended (Non-Blocking, Track If Not Done Here)

- M1 action-type choice for skipped events: document or switch to `comment`.
- M2 code comments on the intentional history actorId divergence.
- M4 document the empty-override-disables semantic in the dev doc.

These can be bundled into the B1 fix commit since they are doc/comment-level and touch adjacent code.

---

End of review. Once B1 and M-T1 land and unit suite is re-confirmed green, PR2 is merge-ready.
