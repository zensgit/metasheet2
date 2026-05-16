# Approval PR3 Admin Jump Verification 2026-05-15

Branch: `flow/admin-jump-node-20260515`  
Base: `origin/main@e0721ed25`  
Base recheck after §7.2 review: `git rev-list --count HEAD..origin/main` returned `0`.
Scope: PR3 `admin-jump-node`

## Summary

Implemented and locally verified the PR3 admin jump backend slice:

- `POST /api/approvals/:id/jump` with `approvals:admin`.
- `ApprovalProductService.adminJump()` using the instance-bound frozen runtime graph.
- Intentional composition with PR2 auto-approval policies when the jumped-to approval node qualifies for auto merge.
- New `approval_records.action = 'jump'` migration plus `approvals:admin` RBAC seed.
- `approval-schema-bootstrap.ts` action CHECK sync.
- Unit coverage for T1-T13 semantics except the DB-required data-bearing rollback cycle, which is explicitly blocked by the local integration DB environment.

## Commands Run

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-admin-jump-service.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-admin-jump-migration.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-rbac-boundary.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration
pnpm type-check
```

## Results

| Command | Result |
|---|---|
| Target service unit | PASS: 1 file / 7 tests |
| Target migration/bootstrap unit | PASS: 1 file / 5 tests |
| Target RBAC unit | PASS: 1 file / 24 tests |
| `@metasheet/core-backend build` | PASS: `tsc` clean |
| `@metasheet/core-backend test:unit` | PASS: 168 files / 2193 tests |
| `pnpm type-check` | PASS: workspace type-check completed |
| `@metasheet/core-backend test:integration` | FAIL: 42 files = 11 failed / 20 passed / 11 skipped; local DB/integration baseline blockers, not PR3-specific |

## Integration Blockers

The full integration suite remains blocked in this local environment. Final run result: 11 failed files, 20 passed files, 11 skipped files; 13 failed tests, 423 passed tests, 50 skipped tests. Key errors observed:

- `DATABASE_URL is required for after-sales plugin install integration tests`
- `database "chouhua" does not exist`
- `approval-pack1a-lifecycle.api.test.ts` failed while running `ensureApprovalSchemaReady()` at `approval-schema-bootstrap.ts:57`.

The run also surfaced existing non-approval integration failures/timeouts in multitable, spreadsheet, kanban, snapshot, and admin-user suites. Because `approval-pack1a-lifecycle.api.test.ts` cannot connect to a real DB here, the data-bearing T11 cycle was not executed.

## T11 / T-bootstrap Status

T11 was not silently skipped:

- Source/unit checks verify the new migration has `up()`/`down()`, includes `'jump'` in `up()`, restores the pre-jump CHECK with `NOT VALID` in `down()`, and deletes `role_permissions` before `permissions`.
- A real DB data cycle remains required: `up -> insert jump row -> down -> reject fresh jump -> up -> accept fresh jump`.
- The attempted integration run confirms the blocker is environment-level DB availability (`database "chouhua" does not exist`), not a green-but-unexecuted approval path.

T-bootstrap was verified by source/unit check:

- `approval-schema-bootstrap.ts` version was bumped to `20260515-pr3-admin-jump-action`.
- The rebuilt `approval_records_action_check` includes `'jump'`.

## T11 Scratch-PG Data Cycle — EXECUTED 2026-05-15 (closes #1600)

The DB-required residual was resolved. A bounded scratch PostgreSQL verification slice was run on a local Homebrew PostgreSQL 15.17 (scratch DB `ms2_phase1_verify`, `DATABASE_URL=postgresql://chouhua@localhost:5432/ms2_phase1_verify`). Scope strictly limited to approval Phase 1 — no multitable/spreadsheet/kanban/snapshot/admin-user work.

### Migrations on clean PG

`pnpm --filter @metasheet/core-backend migrate` applied ALL migrations on a fresh DB with zero errors, through the final migration `zzzz20260515130000_add_jump_action_to_approval_records`. Post-migrate schema verified:

- `approval_records_action_check` = `... 'cc','remind','jump'` (PR3 up() applied).
- `permissions` has `approvals:admin`; `role_permissions` has `(admin, approvals:admin)` (PD2 up()).
- PR1 freeze tables `approval_published_definitions` + `approval_template_versions` present.

### T11 data-bearing cycle (6/6 PASS)

Relevant FK confirmed present: `role_permissions_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES permissions(code) ON DELETE CASCADE` — so the Fix1 FK-safe `down()` order is materially relevant and correctly handled.

| Step | Action | Result |
|---|---|---|
| 1 up | migrate applied jump migration | constraint includes `'jump'` ✅ |
| 2 insert | `INSERT approval_records(... action='jump' ...)` | `INSERT 0 1`, jump_rows=1 ✅ |
| 3 down | `migrate rollback` (PR3 jump migration down(), with jump row present) | succeeded despite existing jump row; constraint → no-jump `NOT VALID`; `permissions`=0, `role_permissions`=0, **existing jump row survived (=1)** ✅ |
| 4 reject | fresh `action='jump'` insert post-down | `ERROR ... violates check constraint "approval_records_action_check"` ✅ |
| 5 up | `migrate` re-applied jump migration | constraint includes `'jump'`; `approvals:admin` perm+role_permission re-seeded (1/1) ✅ |
| 6 accept | fresh `action='jump'` insert | `INSERT 0 1`, total jump rows=2 ✅ |

NOT VALID semantics confirmed: existing `jump` rows do not block rollback; new `jump` inserts are rejected post-down; re-up restores acceptance. FK-safe down order confirmed effective (role_permissions deleted before permissions; FK exists).

### Approval-scoped integration (8 files / 44 tests — ALL PASS)

`vitest --config vitest.integration.config.ts run` on the 8 approval specs against the scratch DB:

`approval-pack1a-lifecycle` (3) · `approval-wp1-any-mode` (—) · `approval-wp1-parallel-gateway` (4) · `approval-wp2-source-filter` · `approval-wp3-pending-count` · `approval-wp3-reads` · `approval-wp3-remind` · `approval-wp4-template-categories` (10) → **8 files / 44 tests PASS**.

Notably `approval-pack1a-lifecycle.api.test.ts` PASSES on real DB — this empirically confirms the PR2 **B1** fix (auto-approval audit matched by `metadata.autoApproved + reason` instead of the brittle `actor_id` literal) works end-to-end, closing the DB-gated blind spot that was deferred across PR2/PR3.

Out of scope (left untouched, NOT failures of this slice): multitable/spreadsheet/kanban/snapshot/admin-user integration red items — explicitly excluded per the bounded-slice constraint.

### Disposition

T11 / T-bootstrap and the cross-PR DB-verification debt for approval Phase 1 are **closed by execution**. Issue #1600 may be closed once this backfilled doc lands on `origin/main`.

## Review Follow-ups

NB1 was handled in this PR:

- `adminJump()` now has an inline comment documenting that jump node-entry intentionally composes with PR2 auto-approval.
- `approval-admin-jump-service.test.ts` includes a jump-to-requester-merge test. It verifies that jumping to an approval node whose assignee is the requester auto-approves that target node, records an `auto-merge-requester` approval record, and persists the next active assignment.

NB2 was handled with an inline comment explaining the `currentStep ?? instance.total_steps` fallback for terminal cascades.

NB3 was rechecked after review. The branch is still based on `origin/main@e0721ed25` with `behind 0`, so the existing base string is current.

## Noise Handling

`pnpm install --frozen-lockfile` was required because this isolated worktree did not have `node_modules`. It rewrote a few tracked plugin/tool `node_modules` symlink files; those dependency-link changes were restored and are not part of the PR diff.

## Residual Risk

RESOLVED for approval Phase 1. The data-bearing T11 cycle was executed on a scratch PostgreSQL (see "T11 Scratch-PG Data Cycle — EXECUTED" above): all 6 steps pass, FK-safe `down()` order confirmed against a real `role_permissions → permissions` FK, and the 8 approval integration specs (44 tests) are green on real DB. The earlier DB-only residual no longer applies to PR1/PR2/PR3. Remaining out-of-scope items (non-approval integration red: multitable/spreadsheet/kanban/snapshot/admin-user) were deliberately not addressed — they are unrelated to approval Phase 1 and tracked elsewhere, not by this slice.
