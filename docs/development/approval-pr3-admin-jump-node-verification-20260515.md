# Approval PR3 Admin Jump Verification 2026-05-15

Branch: `flow/admin-jump-node-20260515`  
Base: `origin/main@e0721ed25`  
Scope: PR3 `admin-jump-node`

## Summary

Implemented and locally verified the PR3 admin jump backend slice:

- `POST /api/approvals/:id/jump` with `approvals:admin`.
- `ApprovalProductService.adminJump()` using the instance-bound frozen runtime graph.
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
| Target service unit | PASS: 1 file / 6 tests |
| Target migration/bootstrap unit | PASS: 1 file / 5 tests |
| Target RBAC unit | PASS: 1 file / 24 tests |
| `@metasheet/core-backend build` | PASS: `tsc` clean |
| `@metasheet/core-backend test:unit` | PASS: 168 files / 2192 tests |
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

## Noise Handling

`pnpm install --frozen-lockfile` was required because this isolated worktree did not have `node_modules`. It rewrote a few tracked plugin/tool `node_modules` symlink files; those dependency-link changes were restored and are not part of the PR diff.

## Residual Risk

The remaining risk is DB-only: the migration's data-bearing rollback sequence must be run on a scratch PostgreSQL database before merge if the reviewer requires strict T11 completion. The unit/source checks make the intended DDL explicit, but they are not a substitute for the data-cycle run.
