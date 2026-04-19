# Yjs CI Migration Exclude Alignment Verification

Date: 2026-04-19

## Verification Method

This slice only changed workflow configuration and migration-exclusion tracking docs. Verification therefore focused on:

1. confirming that all replay-sensitive workflows now carry the same exclusion list;
2. confirming that the already-fixed migration provider still honors `MIGRATION_EXCLUDE` at runtime.

## Commands Run

```bash
rg -n "MIGRATION_EXCLUDE: .*20250924200000_create_event_bus_tables.ts" .github/workflows
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/migration-provider.test.ts tests/unit/migrations.rollback.test.ts tests/unit/db.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
MIGRATION_EXCLUDE='056_add_users_must_change_password.sql,zzzz20260501100000_create_yjs_state_tables.ts' \
pnpm exec node --input-type=module -e "import path from 'node:path'; import { pathToFileURL } from 'node:url'; const moduleUrl = pathToFileURL(path.resolve('packages/core-backend/dist/src/db/migration-provider.js')).href; const { createCoreBackendMigrationProvider } = await import(moduleUrl); const runtimeDir = path.resolve('packages/core-backend/dist/src/db'); const provider = createCoreBackendMigrationProvider({ runtimeDir }); const migrations = await provider.getMigrations(); console.log(JSON.stringify({ hasMustChangePassword: Boolean(migrations['056_add_users_must_change_password']), hasYjsTables: Boolean(migrations['zzzz20260501100000_create_yjs_state_tables']), total: Object.keys(migrations).length }, null, 2));"
```

## Results

- workflow alignment grep:
  - matched `migration-replay.yml`
  - matched `plugin-tests.yml`
  - matched `observability-e2e.yml`
  - matched `observability-strict.yml`
  - matched `safety-guard-e2e.yml`
- `tests/unit/migration-provider.test.ts` + `tests/unit/migrations.rollback.test.ts` + `tests/unit/db.test.ts`: `21 passed`
- backend build: passed
- built runtime exclusion check:
  - `hasMustChangePassword: false`
  - `hasYjsTables: false`

## Conclusion

- The workflow layer is now aligned with the migration-provider runtime behavior.
- The specific replay-only failures seen in `migration-replay`, `observability-e2e`, `safety-guard-e2e`, and `plugin-tests` are covered by the updated exclusion list.
- No additional remote deployment or schema change was required for this hardening slice.
