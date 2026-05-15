# Approval PR1 Review Response 2026-05-15

Reviewing `c44fb72e8 feat(approval): harden template version freeze` against scope gate `docs/development/approval-pr1-scope-gate-response-20260515.md`.

Reviewer: Claude
Worktree: `/Users/chouhua/Downloads/Github/metasheet2-flow-version-freeze-hardening-20260515`
Base verified: `be699941f docs: record approval phase1 baseline`
Files touched: 4 (service + tests + dev doc + verification doc). Zero do-not-cross violations.

## Verdict

APPROVE for merge into `main`.

P1 (option a, internal helper) honored. P2 (T1-T11 coverage) complete. T12 correctly skipped because R5 mitigation was doc comment, not call-site split.

## Findings In §7.2 Priority Order

### 1. Blocking Correctness Issues

None.

The implementation correctly preserves instance-bound version freeze:
- `assertTemplateVersionDeletable` (ApprovalProductService.ts:1459-1499) defends both direct `approval_instances.template_version_id` and indirect `approval_instances.published_definition_id -> approval_published_definitions.template_version_id` references.
- `loadTemplateBundleWithClient` doc comment (ApprovalProductService.ts:2437-2443) explicitly forbids reuse for advance and points to `dispatchAction()` as the correct path.

Test invariants pin the right behavior:
- approval-product-service.test.ts:1253-1254 asserts `dispatchAction` does NOT issue any SQL touching `approval_templates` or `active_version_id`. This is the strongest possible mock-pool assertion of the source-of-truth invariant.
- approval-product-service.test.ts:1172 asserts the published-definition query uses `pub-old` (instance-bound), not the active definition.

### 2. Security/Permission Issues

None.

The guard is service-internal with no HTTP exposure. Multi-tenant filtering responsibility correctly remains with future callers (a comment explaining this would be a nice-to-have, see finding 5.3).

### 3. Missing Tests

None blocking. Two acknowledged forward-looking gaps:

3.1. **T9 explicit form-schema-violation coverage is implicit only**
   - Current test (line 1122) pins the snapshot via conditional routing on `form_snapshot.legacyAmount`. This proves the stored snapshot governs evaluation, but does not exercise a "form schema rejects old data / accepts new data" path because no such re-validation path exists today.
   - Verification doc line 91 correctly acknowledges this.
   - Forward action: when any future PR adds form resubmit/edit on existing instances, it must include an explicit T9 form-schema-violation test using the stored snapshot, not the template's current schema. Track in PR3/PR4 reviews and Phase 2 design.

3.2. **T8 concurrent publish is mock-pool, not real PG**
   - Verification doc line 38, 54 already calls this out. The virtual-lock simulation is contract-level.
   - Forward action: when integration env is repaired (current baseline failure is environmental, not approval-related), add an integration test that runs two concurrent real-PG `publishTemplate` calls and verifies the `is_active` constraint holds. Track as a Phase 1 follow-up.

### 4. Scope Creep

None. File diff list is:
- `packages/core-backend/src/services/ApprovalProductService.ts` (allowed)
- `packages/core-backend/tests/unit/approval-product-service.test.ts` (allowed)
- `docs/development/approval-pr1-version-freeze-development-20260515.md` (allowed)
- `docs/development/approval-pr1-version-freeze-verification-20260515.md` (allowed)

Zero edits to `ApprovalGraphExecutor.ts`, `routes/approvals.ts`, `multitable/*`, `approval-sla-*`, `approval-breach-*`, `apps/web/**`, or any migration file.

### 5. Naming/Maintainability

Three polishing items. None blocking PR1 merge. Track as PR2/PR3 follow-ups.

5.1. **Terminal status list hardcoded inline**
   - Location: `ApprovalProductService.ts:1468` and `approval-product-service.test.ts:1277` both literal `'approved', 'rejected', 'revoked', 'cancelled'`.
   - Risk: future addition of a terminal status (for example `'withdrawn'` or `'expired'`) will silently make the guard over-block, and the test will pass for the wrong reason.
   - Recommendation: extract `APPROVAL_TERMINAL_STATUSES` constant in `types/approval-product.ts` and reuse from both production code and test. Suggested to land in PR2 because auto-approval merge will also need this concept.

5.2. **OR clause intent not documented**
   - Location: `ApprovalProductService.ts:1469-1477` uses `WHERE template_version_id = $1 OR published_definition_id IN (...)`.
   - Risk: a future reader may not understand why both columns are required (the legacy / migration intent — defending against rows where only one column is populated).
   - Recommendation: add a one-line comment above the OR clause. Suggested wording: "Defend against historical instances where only one of `template_version_id` or `published_definition_id` may have been backfilled."

5.3. **Guard helper has no production caller and no compile-time enforcement**
   - Location: `ApprovalProductService.assertTemplateVersionDeletable` is public but unreferenced in production code today.
   - Risk: when a future PR adds a delete or archive endpoint, the developer must remember to call this helper. There is no static guarantee.
   - Recommendation: add a stronger JSDoc warning at the helper definition: "Must be called by any future delete or archive code path before mutating `approval_template_versions`, `approval_templates`, or `approval_published_definitions` rows. Direct SQL bypasses this protection." Track a separate Phase 1 follow-up to add a grep-time CI check that no `DELETE FROM approval_template_versions` or status-flip-to-archived UPDATE exists outside this helper's caller graph. Phase 1 follow-up only, not PR1.

## Verification Cross-Check

- Unit suite delta is consistent: baseline 2136 → after 2143, exactly +7 new `it()` blocks (lines 1025, 1122, 1265, 1282, 1303, 1385, 1518).
- Build PASS, type-check is bundled inside backend build.
- No migration → rollback verification N/A is correct.
- Integration environment failures inherited from baseline are correctly excluded from PR1 responsibility. PR1 does not introduce any new integration failure.

## Test Effectiveness Spot-Check

Selected three claimed-strongest assertions and confirmed they exercise the right path:

E1. T7 negative-space assertion at line 1253-1254 — `statements.some(s => s.includes('approval_templates'))` and `.includes('active_version_id')` both `.toBe(false)`. This is the kind of test that fails noisily if any future refactor leaks a template lookup into `dispatchAction`. Strong.

E2. T10 graph independence at line 1247 — final `currentNodeKey: 'approval_old_high'` is a node that only exists in `frozenRuntimeGraph`. If `dispatchAction` had loaded a different graph, the advance would either crash with "node not found" or route to a different node, failing the assertion. The chosen node and assertion correctly distinguish frozen from current graph. Strong.

E3. T11 error shape at line 1291-1300 — both `details: { unfinishedCount: 2, sampleInstanceId: 'apr-pending-1' }` structured matcher AND `rejects.toThrow('apr-pending-1')` string-containment matcher. The string-containment ensures operator-visible message also carries the sample ID. Strong.

## Merge Gate Summary

Per worksplit §7.3:

- Worktree contains only PR1 files: PASS.
- Boundary checklist green: PASS (8/8 yes, P1 = option a, P2 commitments met).
- Claude review has no unresolved blocking findings: PASS.
- Targeted unit/integration tests pass: PASS for unit. Integration gated to baseline-failed environment, documented as residual.
- Build/type-check recorded: PASS.
- Migration rollback documented: N/A (no migration in PR1).
- Verification note committed under `docs/development/`: PASS.

Ready to merge.

## Forward-Looking Track List

For Phase 1 follow-up after PR1 merges (not blocking):

- Item A: extract `APPROVAL_TERMINAL_STATUSES` constant (finding 5.1).
- Item B: comment OR clause intent (finding 5.2).
- Item C: strengthen guard helper JSDoc (finding 5.3).
- Item D: real-PG concurrent publish integration test when env repaired (finding 3.2).
- Item E: explicit T9 form-schema-violation test when any form re-validation path is added (finding 3.1).

Items A and B are cleanest to bundle into PR2 (auto-approval-three-merge) since it will already touch related code and tests. Items C, D, E are independent.

---

End of review. Codex may proceed to merge PR1 into `main` and then cut PR2.
