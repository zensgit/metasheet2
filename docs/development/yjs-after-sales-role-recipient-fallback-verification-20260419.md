# Yjs After-Sales Role Recipient Fallback Verification

Date: 2026-04-19

## Verification Method

This slice changed:

- one after-sales plugin runtime helper
- one focused unit test file

Verification therefore focused on:

1. proving the new legacy-schema fallback path with a direct unit test;
2. confirming the existing migration-provider / rollback / db hardening tests still pass;
3. confirming backend compilation still succeeds after editing the plugin runtime helper;
4. recording that the full after-sales integration still requires GitHub CI or a local PostgreSQL instance with the expected CI role layout.

## Commands Run

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/after-sales-workflow-adapter.test.ts tests/unit/migration-provider.test.ts tests/unit/migrations.rollback.test.ts tests/unit/db.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
rg -n "is_active" plugins/plugin-after-sales/lib/workflow-adapter.cjs packages/core-backend/tests/unit/after-sales-workflow-adapter.test.ts
```

## Results

- `tests/unit/after-sales-workflow-adapter.test.ts` + `tests/unit/migration-provider.test.ts` + `tests/unit/migrations.rollback.test.ts` + `tests/unit/db.test.ts`: `36 passed`
- backend build: passed
- grep confirmed:
  - the plugin runtime helper still prefers the `is_active`-aware query
  - the new unit test explicitly covers the legacy fallback path

## Environment Limitation

The full `after-sales-plugin.install.test.ts` integration suite still cannot be completed locally on this machine with the same connection string used in CI:

- local PostgreSQL does not expose the CI-style `postgres` role

So the final confirmation for this slice remains the GitHub jobs:

- `after-sales integration`
- `test (20.x)`
- `test (18.x)` if re-run in the same workflow matrix

## Conclusion

- the root cause for zero `service.recorded` notifications is now closed at the adapter level
- local focused verification is green
- final end-to-end confirmation depends on the re-run CI jobs for PR `#918`
