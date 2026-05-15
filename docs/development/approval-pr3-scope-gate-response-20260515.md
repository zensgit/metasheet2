# Approval PR3 Scope Gate Response 2026-05-15 (Revised)

Scope gate for PR3 `admin-jump-node`, per Phase 1 §7.1 and worksplit doc §5 PR3.
Revision: incorporates 4 blocking + 2 should-fix review items + 3 sharpenings. Verdict moved from CONDITIONAL GO to **GO-after-prerequisites**.

Reviewer: Claude
Worktree: `/Users/chouhua/Downloads/Github/metasheet2-flow-admin-jump-node-20260515`
Branch: `flow/admin-jump-node-20260515`
Base: `origin/main` @ `0eb8c9639` (rebased; behind 0; `#1594 feat(attendance)` absorbed, no approval overlap). Branched from origin/main per [[feedback_local_main_orphaned]].

## Verification Findings (Code-Grounded)

F1. No `adminJump` / `/jump` route or service method exists — PR3 is greenfield for this feature.

F2. RBAC pattern is `authenticate, rbacGuard('<perm>')` (import from `../rbac/rbac`). Existing: `approvals:read`, `approval-templates:manage`. No `approvals:admin` yet.

F3. Latest effective `approval_records.action` CHECK = `('created','approve','reject','return','revoke','transfer','sign','comment','cc','remind')`. **'jump' is invalid** → an `action='jump'` insert fails the constraint.

F4. `dispatchAction` reads runtime graph from `instance.published_definition_id` (~2396-2402; doc comment ~3073) — PR1 version-freeze invariant.

F5. Parallel state in `metadata.parallelBranchStates` (read ~865/~1181; resolution ~1490/~1605).

F6. `approval_records_action_check` is defined in **4 files** (full-repo sweep):
- `tests/helpers/approval-schema-bootstrap.ts:180` — LIVE sync point (no 'jump'); rebuilt for every DB-backed approval test.
- `db/migrations/zzzz20260411123000_*.ts:8`, `zzzz20260411120100_*.ts`, `zzzz20260423120000_*.ts:12/19` — APPLIED historical migrations. **Immutable — PR3 must NOT edit them.** The new PR3 migration supersedes them at runtime.
→ The only two points PR3 keeps in sync: the NEW migration and `approval-schema-bootstrap.ts:180`.

F7. `namespace-admission.ts` `NON_NAMESPACED_PERMISSION_RESOURCES` includes `'approvals'` → `approvals:admin` is non-namespaced; no namespace-admission switch needed.

## Scope Gate (boundary checklist)

1. Limited to admin-jump-node? — YES, conditional on PD1/PD2/PD3.
2. No new product surface beyond one admin `POST /api/approvals/:id/jump`? — YES.
3. No automation/SLA/breach/add-sign/auto-approval work? — YES.
4. Preserve PR1 version-freeze (validate target from instance-bound `published_definition_id`)? — YES, REQUIRED (F4).
5. Forward-only jump (backward = separate ADR)? — YES, already decided (worksplit §8).
6. Reject terminal instances + optimistic `version`? — YES, REQUIRED.
7. Deactivate active assignments + resolve target from bound runtime graph? — YES.
8. Parallel coherence per PD3? — YES, REQUIRED.
9. Emit `approval.admin_jumped` with full audit payload? — YES, REQUIRED.
10. Keep `ApprovalGraphExecutor` graph-local? — YES.
11. Migration rollback documented + tested (PD1=a → migration present)? — YES, REQUIRED.
12. Constraint sync (new migration + schema-bootstrap), historical migrations untouched? — YES, REQUIRED (F6, B3).

## Prerequisite Decisions (record in dev doc before code)

### PD1. Add `'jump'` action via new migration — ACCEPTED (a)

- `up()`: `DROP CONSTRAINT IF EXISTS approval_records_action_check` → `ADD CONSTRAINT approval_records_action_check CHECK (action IN (... ,'remind','jump'))`.
- `down()` (exact DDL, no interpretation): `DROP CONSTRAINT IF EXISTS approval_records_action_check` → `ADD CONSTRAINT approval_records_action_check CHECK (action IN (...,'remind')) NOT VALID`. `NOT VALID` so pre-existing `'jump'` rows do NOT block the rollback; new `'jump'` inserts are still rejected post-down.
- T11 must be the data-bearing cycle: `up` → insert a `jump` row → `down` (must succeed despite the jump row) → assert a fresh `jump` insert is rejected → `up` → assert `jump` insert accepted again.

### PD2. `approvals:admin` — ACCEPTED, concrete registration

- New migration inserts `permissions(code='approvals:admin', ...)` and `role_permissions` linking it to the admin role.
- Route gated `authenticate, rbacGuard('approvals:admin')`, consistent with the `approvals:` family.
- `approvals` is non-namespaced (F7) — no namespace-admission entry/switch required. Record exact permission code + migration location in the dev doc.

### PD3. Parallel-region jump boundary — NEW, ACCEPTED

- When the instance has `metadata.parallelBranchStates`, forward-reachability MUST be computed with the base = the parallel **JOIN node, not `current_node_key` (the fork)**. From the fork every branch node is reachable, which would wrongly admit sibling-branch targets.
- MVP: a jump target inside ANY parallel branch → 400. Only targets that are post-join downstream of the join node are valid. All active branch assignments are deactivated and `parallelBranchStates` cleared on a valid (post-join) jump.
- Jump-into-a-specific-branch is explicitly OUT OF SCOPE → separate ADR.

## Semantic Risks

R1. Version-freeze drift (HIGH) — validate target on the instance-bound frozen graph only (F4).
R2. Forward-only correctness (HIGH) — reachability on frozen graph; reject backward/lateral/terminal (T6); in parallel, base = join node (PD3).
R3. Parallel coherence (HIGH) — deactivate all branch assignments, clear `parallelBranchStates`, re-resolve target; partial clear corrupts later advance (T9).
R4. Audit completeness (MED) — `approval.admin_jumped` + record carry fromNode/toNode/old+new assignees/admin actor/reason/instanceId; `actor_id` is the real admin (not `system:*`).
R5. Concurrency (MED) — `SELECT ... FOR UPDATE` + optimistic `version` (T12).
R6. Double-jump (LOW-MED) — version bump serializes; 2nd → 409.
R7. Constraint-definition drift (MED, B3) — new migration + schema-bootstrap must both include `'jump'`; historical migrations untouched. A future migration/bootstrap edit must keep both in sync.

## Required Tests

T1. Authorization separation (STRENGTHENED): plain non-admin → 403; AND a user holding `approvals:act` / `approval-templates:manage` but NOT `approvals:admin` → still 403 (prevents accidental reuse of existing action-route perms; existing action route ref `routes/approvals.ts:1148`).
T2. Terminal instance → rejected.
T3. Stale `version` → 409.
T4. Jump uses instance-bound runtime graph (mock-pool: published-def query keys on `instance.published_definition_id`; zero `approval_templates`/`active_version_id` read).
T5. Invalid target nodeKey → 400.
T6. Backward / lateral (non-downstream) target → 400.
T7. Valid forward jump: old assignments deactivated; target assignments created from bound graph; advances from target.
T8. Old assignee cannot act post-jump → rejected.
T9. Parallel-region jump (STRENGTHENED per PD3): in-branch target → 400; valid post-join target → all branch assignments deactivated + `parallelBranchStates` cleared + coherent subsequent advance; reachability base asserted = join node.
T10. Audit payload complete; actor_id = admin user (not system).
T11. Migration rollback data-bearing cycle (per PD1): up → insert jump row → down (succeeds w/ jump row present) → fresh jump insert rejected → up → jump insert accepted.
T12. Concurrency: FOR UPDATE + optimistic version; 2nd concurrent jump → 409.
T13. Jump does NOT mutate `template_version_id` / `published_definition_id`.
T-bootstrap (NEW, B3): assert `approval-schema-bootstrap.ts` rebuilt CHECK includes `'jump'` (prevents PR2-B1-class latent DB-test breakage when integration env is repaired).

## Do-Not-Cross Lines

- `multitable/automation-*`, `approval-sla-*`, `approval-breach-*` — untouched.
- PR2 auto-approval regions in `ApprovalProductService.ts` (`applyAutoApprovalCascade`, policy eval) — untouched.
- `apps/web/**` — backend-only.
- **Historical migrations** (`zzzz20260411123000`, `zzzz20260411120100`, `zzzz20260423120000`) — immutable, do NOT edit. New constraint = new migration file only.

PR3 owns: new `adminJump(...)` + downstream-validation helper (graph-local) in `ApprovalProductService.ts`; one `POST /api/approvals/:id/jump` in `routes/approvals.ts`; new migration (action constraint + `approvals:admin` permission/role_permission rows); `approval-schema-bootstrap.ts` CHECK sync.

## Review Focus

1. Version-freeze: jump validation reads only instance-bound frozen graph.
2. Forward-only incl. PD3 parallel base = join node; backward/lateral/in-branch rejected.
3. Parallel coherence: no orphaned branch assignments; parallelBranchStates cleared.
4. Audit: full payload, admin actor, action constraint-valid.
5. Migration: PD1 exact DDL; T11 data-bearing rollback green.
6. B3 sync: new migration + schema-bootstrap both carry 'jump'; historical migrations untouched; T-bootstrap green.
7. Authz separation: T1 strengthened case passes.
8. Scope: one additive route, no PR2/automation/SLA/UI edits.

## Go / No-Go

**GO after prerequisites.** Record in `approval-pr3-admin-jump-node-development-20260515.md` before code:
- PD1=(a) with exact up()/down() DDL + data-bearing T11.
- PD2 `approvals:admin` registration specifics (permission + role_permission migration rows; non-namespaced).
- PD3 parallel boundary (forward base = join node; in-branch → 400; jump-into-branch = separate ADR).
- B3 sync plan (new migration + schema-bootstrap; historical migrations untouched) in expected files + acceptance.
- T1–T13 + T-bootstrap commitment, each with fails-without-guard evidence.

Forward-only + reject-terminal already decided (worksplit §8) — implement + test, no re-decision. Once the above is recorded, implementation may begin.

---

End of revised PR3 scope gate.
