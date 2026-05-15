# Approval PR3 Review Request 2026-05-15

Requesting §7.2 independent review for PR3 `admin-jump-node`.

Branch: `flow/admin-jump-node-20260515`  
Base: `origin/main@e0721ed25`  
Base recheck after §7.2 review: `git rev-list --count HEAD..origin/main` returned `0`.
Worktree: `/Users/chouhua/Downloads/Github/metasheet2-flow-admin-jump-node-20260515`

## Diff Summary

Adds backend-only admin jump support for platform approvals:

- New `POST /api/approvals/:id/jump` route gated by `approvals:admin`.
- New `ApprovalProductService.adminJump()` that locks the instance, validates stale version/terminal state, validates forward-only approval-node targets on the frozen runtime graph, deactivates old assignments, creates target assignments, clears parallel state when needed, writes a `jump` audit record, emits `approval.admin_jumped`, and returns the refreshed approval.
- PR2 auto-approval composition is intentional: after jump node-entry, enabled requester/adjacent/historical auto policies can advance the target node through the same cascade used by create/advance.
- New migration adding `approval_records.action = 'jump'` and seeding `approvals:admin`.
- Bootstrap CHECK sync and unit coverage for T1-T13 / T-bootstrap boundaries.

## Changed Files

Expected PR3 files only:

- `docs/development/approval-pr3-admin-jump-node-development-20260515.md`
- `docs/development/approval-pr3-admin-jump-node-verification-20260515.md`
- `docs/development/approval-pr3-review-request-20260515.md`
- `packages/core-backend/src/db/migrations/zzzz20260515130000_add_jump_action_to_approval_records.ts`
- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/tests/helpers/approval-schema-bootstrap.ts`
- `packages/core-backend/tests/unit/approval-admin-jump-migration.test.ts`
- `packages/core-backend/tests/unit/approval-admin-jump-service.test.ts`
- `packages/core-backend/tests/unit/approval-rbac-boundary.test.ts`

No UI, automation, SLA, breach, PR2 auto-approval region, or historical migration edits.

## Migration Summary

Migration: `zzzz20260515130000_add_jump_action_to_approval_records.ts`

- `up()` drops/recreates `approval_records_action_check` with `'jump'`.
- `up()` inserts `permissions(code='approvals:admin')`.
- `up()` inserts `role_permissions(role_id='admin', permission_code='approvals:admin')`.
- `down()` deletes `role_permissions` first, then `permissions`.
- `down()` restores the old action CHECK without `'jump'` using `NOT VALID`.
- `approval-schema-bootstrap.ts` was bumped and synced with the new action list.

## Tests Run

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-admin-jump-service.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-admin-jump-migration.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-rbac-boundary.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration
pnpm type-check
```

Results:

- Target units: PASS (`7 + 5 + 24` tests).
- Backend build: PASS.
- Full backend unit: PASS (`168 files / 2193 tests`).
- Workspace type-check: PASS.
- Integration: FAIL (`11 failed / 20 passed / 11 skipped` files) due local DB/baseline blockers, including `DATABASE_URL is required` and `database "chouhua" does not exist`; see verification doc.

## Known Gaps

- T11 data-bearing migration rollback was not executed because the local integration DB is unavailable. Source/unit checks cover DDL shape, `NOT VALID`, FK-safe down order, and bootstrap sync; a scratch PostgreSQL data-cycle remains required for strict DB verification.
- Full integration suite has existing unrelated failures/timeouts in multitable/spreadsheet/kanban/snapshot/admin-user areas on this machine.

## Review Focus

1. Version-freeze invariant: target graph validation must read only `instance.published_definition_id`.
2. Forward-only semantics and PD3 parallel base = join node.
3. Parallel cleanup: all active branch assignments deactivated and `parallelBranchStates` removed.
4. Audit/event payload: real admin `actor_id`, reason, old/new assignees, from/to nodes.
5. Migration DDL: `jump`, `approvals:admin`, FK-safe `down()`, `NOT VALID`.
6. B3 sync: new migration + bootstrap only; historical migrations untouched.
7. Scope boundary: no automation/SLA/breach/UI/PR2-auto-approval edits.
