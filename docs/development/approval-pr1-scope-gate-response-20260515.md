# Approval PR1 Scope Gate Response 2026-05-15

Responding to `docs/development/approval-pr1-scope-gate-request-20260515.md`.

Reviewer: Claude
Worktree confirmed: `/Users/chouhua/Downloads/Github/metasheet2-flow-version-freeze-hardening-20260515`
Base commit verified: `be699941f docs: record approval phase1 baseline`

## Verification Findings (Code-Grounded)

Before answering the boundary checklist, three code-level facts were verified directly against the worktree:

F1. `ApprovalProductService.dispatchAction` already reads instance-bound `published_definition_id` and loads `runtime_graph` from `approval_published_definitions` directly (lines 1750-1770). It does NOT consult `approval_templates.active_version_id`. → Source-of-truth invariant is structurally correct at baseline.

F2. `loadTemplateBundle` / `loadTemplateBundleWithClient` (lines 2391-2440) use `preferredVersion: 'active' | 'latest'` only at four call sites: lines 1162 (latest, get-detail), 1167 (explicit version), 1356 (latest, inside publish path), 1508 (latest, clone), 1597 (active, `createApproval`). None of these is an instance-advance path. → No latent regression bypass.

F3. There is NO existing code path for deleting or archiving an `approval_template`, `approval_template_version`, or `approval_published_definition` in `ApprovalProductService.ts`. Grep on `deleteTemplate|archiveTemplate|deleteVersion|archiveVersion|DELETE FROM approval_template` returns empty. → "Add service guard for hard-delete/archive" in PR1 (worksplit §5 line 119) cannot harden an existing path; it must add a new internal helper or a new endpoint. This is a scope decision Codex/user must resolve before code starts. See R1 and P1 below.

## Scope Gate

Answers to the 8 boundary checklist items in the request:

1. Does PR1 stay limited to version-freeze hardening?
   YES — conditional on R1 below. If the delete/archive guard becomes a new HTTP endpoint, that conditional flips to NO.

2. Does PR1 avoid adding new product surfaces?
   YES — provided R1 resolves to "internal service helper, no new endpoint, no UI."

3. Does PR1 avoid scheduler, automation, SLA, add-sign, and admin-jump work?
   YES. Codex's Expected Files list excludes all such modules.

4. Does PR1 use instance-bound `published_definition_id` as the runtime source of truth?
   YES — already structurally true (F1). PR1's job is to add regression tests that pin this invariant against future drift.

5. Does PR1 prevent or guard destructive version operations when unfinished instances reference the version?
   YES — conditional on R1.

6. Does PR1 prove stale published definitions remain readable for running instances?
   YES — required via T5/T10 below.

7. Does PR1 avoid reading template `active_version_id` when advancing an existing instance?
   YES — already true (F1, F2). PR1 must add a mock-pool test that asserts `dispatchAction` issues `SELECT FROM approval_published_definitions WHERE id = $1` and zero `SELECT FROM approval_templates ... active_version_id` during advance.

8. Does PR1 keep migration rollback behavior documented and tested if migrations change?
   YES — required if PR1 introduces any schema change. If guard is purely service-internal with no schema delta, no migration is needed.

## Semantic Risks

R1. Delete/archive scope ambiguity (high impact).
There is no existing delete/archive code path (F3). PR1 must choose:
   (a) Add an internal helper such as `assertVersionDeletable(templateVersionId)` that throws when unfinished instances reference the version. No new endpoint, no UI. This keeps PR1 strictly hardening.
   (b) Add a new HTTP endpoint such as `DELETE /api/approval-templates/:id/versions/:versionId` plus the guard.
Claude recommends (a). If (b) is taken, it is arguably a new product surface and must be raised to the user before PR1 starts.

R2. Concurrent publish race.
`publishTemplate` performs `SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE` (line 1389), serializing per-template publishes. However, `approval_template_versions` and `approval_published_definitions` rows are not separately locked. The template-row lock should be sufficient, but PR1 should pin it via a concurrent-publish regression test.

R3. Form snapshot vs runtime graph independence.
`approval_instances.form_snapshot` and `approval_published_definitions.runtime_graph` are two version-frozen artifacts that must remain stable for an instance's lifetime. PR1 tests must cover both independently. Editing the template's form schema must not change `formData` validation on existing instances; editing the template's graph must not change advance behavior on existing instances.

R4. Rollback completeness on publish failure.
`publishTemplate`'s try/catch invokes `rollbackQuietly(client)`. If the function swallows errors silently, an orphaned `approval_published_definitions` row could persist. PR1 should add a test that injects a failure mid-transaction and asserts no orphaned rows in any of the three tables involved.

R5. `loadTemplateBundle` 'active' preference reuse risk.
Line 2420 chooses `latest_version_id || active_version_id` (or the reverse) based on `preferredVersion`. This is correct for new instance creation and for editing/cloning. A future developer might mis-use `preferredVersion: 'active'` to "load the template state for an existing instance" — silently picking up a newer `active_version_id`. PR1 should either:
   - Add a strong doc comment on `loadTemplateBundle` warning against use during instance advance, OR
   - Split the helper into two named functions (e.g., `loadBundleForNewApproval`, `loadBundleForEditing`).
Either is acceptable. Renaming is preferred for long-term clarity but the doc comment is sufficient for PR1.

R6. DB-level safety residual.
Any service-layer guard PR1 adds does not protect against direct SQL (`DELETE FROM approval_published_definitions WHERE id = ...` via psql or admin tools). Out of scope for PR1. PR1's verification doc should note this residual risk and recommend an `ON DELETE RESTRICT` FK or DB trigger as a future hardening.

## Required Tests

Codex listed 7 tests under "Tests Planned." Claude requires all 7 plus the following additions/strengthenings:

T1. (listed) Old instance advances with original `published_definition_id` after a new template version is published.

T2. (listed) Old instance keeps original form snapshot semantics after the template form schema changes.

T3. (listed) New instance uses the latest active published definition after publish.

T4. (listed; depends on R1) Destructive delete/archive of a referenced version is blocked when unfinished instances exist.

T5. (listed) Stale published definition remains readable even after another version is active.

T6. (listed, strengthened) Publish failure rolls back active definition changes AND leaves no orphaned `approval_published_definitions` row.

T7. (listed, specified) Mock-pool test asserting `dispatchAction` issues `SELECT FROM approval_published_definitions WHERE id = $1` exactly once per advance and issues zero `SELECT FROM approval_templates ... active_version_id` SQL during advance.

T8. (NEW — R2) Concurrent publish test: two parallel `publishTemplate` calls on the same template. Final state has exactly one row with `is_active = TRUE` in `approval_published_definitions` for that template; the losing call either succeeds (newer version becomes active) or fails cleanly (no orphan), but never leaves multiple active rows.

T9. (NEW — R3) Form snapshot independence: instance created with form schema F1; template form schema updated and republished to F2; submitting `formData` violating F1 but matching F2 must still be rejected for the existing instance.

T10. (NEW — R3) Runtime graph independence: instance created with graph G1; template graph updated and republished to G2 (with a new node or different routing); `dispatchAction` on the existing instance traverses G1's edges, not G2's.

T11. (NEW — R1 option (a)) Guard ergonomics: when `assertVersionDeletable` (or equivalent) throws, the error message must include the count of unfinished instances and a sample `approval_instance.id` so operators can investigate. Pin via exact error shape.

T12. (NEW — R5 if rename is taken) Static-style test: grep or AST check that ensures no file other than `createApproval` and clone/edit helpers calls `loadTemplateBundle` with `preferredVersion: 'active'`. If rename is taken, this becomes a typed call-site list. If only doc comment is added, this test is optional but recommended.

## Do-Not-Cross Lines

File-level (PR1 must not edit):

- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/routes/approvals.ts` — unless R1 resolves to (b) and a new endpoint is added; even then, additive only, no existing route changes.
- `packages/core-backend/src/multitable/automation-*` — all automation files.
- `packages/core-backend/src/services/approval-sla-*` or `approval-breach-*`.
- `apps/web/src/views/**/*Approval*` — frontend is out of scope for PR1.
- `packages/core-backend/src/db/migrations/zzzz20260411120100_approval_templates_and_instance_extensions.ts` — read-only. Any schema change must be a NEW migration file.

Function-level locks (PR1 owns within `ApprovalProductService.ts`):

- `publishTemplate`
- `createApproval`
- `dispatchAction` — regression tests only; no behavioral change.
- `loadTemplateBundle` and `loadTemplateBundleWithClient` — doc-comment clarification or careful split only; no semantic change to existing call sites.
- New: any `assertVersionDeletable` / `assertVersionArchivable` helper or equivalent.

Out of scope even within `ApprovalProductService.ts`:

- Auto-approval policy logic (PR2 owns).
- Admin jump logic (PR3 owns).
- Add-sign logic (PR4 owns).

## Review Focus

When Codex requests review on the PR diff, Claude will scrutinize in this order:

1. Source-of-truth invariant verified by grep on the final diff: every `SELECT * FROM approval_published_definitions` during instance advance uses `instance.published_definition_id` as the WHERE clause input. No `SELECT ... active_version_id` from `approval_templates` is introduced.

2. Migration rollback (if applicable): up → down → up sequence runs clean on a scratch DB. Schema constraints are reversible.

3. Test effectiveness: each new test fails when the guarded behavior is removed/mutated. Codex must demonstrate this in the verification doc with explicit before/after lines (for example: "test T1 fails at commit X with message Y; passes at commit Z").

4. Scope creep: no edits to `ApprovalGraphExecutor`, no edits to `routes/approvals.ts` other than the additive guard endpoint (if R1=b), no edits to UI files, no edits to automation or SLA files.

5. R1 option documented: the PR1 development doc must explicitly state which option (a or b) was chosen and the reasoning.

6. R2 concurrent-publish test exists (T8) and demonstrates correct serialization.

7. R3 independence tests exist (T9 and T10) and cover both form snapshot and runtime graph separately.

8. Verification report compares against baseline `docs/development/approval-phase1-baseline-20260515.md`. PR1 must not introduce new failures vs baseline. Existing baseline failures (DB env, mocked-SQL drift) are not PR1's to fix.

9. R5 mitigation taken (rename or doc comment) is documented in the development doc.

## Go / No-Go For Codex Implementation

CONDITIONAL GO.

Two prerequisites must be acknowledged in the PR1 development doc before Codex begins writing code:

P1. R1 decision recorded. Codex (or user, if escalated) declares whether PR1 implements the version-deletion/archive guard as:
   - (a) internal service helper, no new endpoint, no UI — Claude's recommended choice; OR
   - (b) new HTTP endpoint with guard — requires user sign-off as a small product-surface addition.

P2. Test plan acknowledgment. Codex commits to including T8, T9, T10, T11 in addition to the 7 tests listed in the scope gate request. For each test, the development doc must record that the test was demonstrated to fail without the corresponding hardening change (effectiveness evidence).

Once P1 and P2 are recorded in `docs/development/approval-pr1-version-freeze-development-20260515.md`, Codex may begin implementation.

If P1 lands on option (b), Codex must pause and surface the scope expansion to the user before any code change.

---

End of scope gate response.
