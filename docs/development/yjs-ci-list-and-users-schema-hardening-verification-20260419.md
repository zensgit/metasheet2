# Yjs CI List And Users Schema Hardening Verification

Date: 2026-04-19

## Verification Method

This slice changed:

- one workflow step in `migration-replay.yml`
- one CI seed script
- one integration-test fixture
- one additional role seed in the same integration-test fixture

Verification therefore focused on:

1. confirming that `migration-replay` now passes the same `MIGRATION_EXCLUDE` list to `db:list`;
2. confirming that the edited backend files still compile;
3. confirming that the existing migration-provider hardening tests still pass;
4. confirming that the after-sales fixture now seeds its required role row before `user_roles`;
5. attempting the after-sales integration test locally and recording the environment blocker.

## Commands Run

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/migration-provider.test.ts tests/unit/migrations.rollback.test.ts tests/unit/db.test.ts --watch=false
rg -n "name: List migrations|MIGRATION_EXCLUDE:" .github/workflows/migration-replay.yml packages/core-backend/scripts/seed-rbac.ts packages/core-backend/tests/integration/after-sales-plugin.install.test.ts
DATABASE_URL=postgresql://postgres@localhost:5432/metasheet_test pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/after-sales-plugin.install.test.ts --reporter=dot
```

## Results

- backend build: passed
- `tests/unit/migration-provider.test.ts` + `tests/unit/migrations.rollback.test.ts` + `tests/unit/db.test.ts`: `21 passed`
- workflow/file grep confirmed:
  - `migration-replay.yml` now sets `MIGRATION_EXCLUDE` for both `Run migrations twice (replay)` and `List migrations`
  - the edited CI helpers no longer insert `is_active` / `is_admin`
  - the after-sales fixture now seeds `roles(id='supervisor')` before inserting into `user_roles`
- local after-sales integration attempt:
  - could not complete on this machine because local PostgreSQL does not expose role `postgres`
  - failure was environment access:
    - `role "postgres" does not exist`
  - it did not indicate a TypeScript or query-construction error in the edited fixture itself

## Conclusion

- The workflow-side `db:list` exclusion gap is closed.
- The edited CI helpers are now aligned with the legacy-compatible minimal `users` schema.
- Full after-sales integration verification still depends on CI or a local PostgreSQL instance with the expected `postgres` role.
