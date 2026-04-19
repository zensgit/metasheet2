# Yjs Migration Exclude And CI Hardening Verification

Date: 2026-04-19

## Local Verification

Executed from the clean Yjs worktree:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/migration-provider.test.ts tests/unit/migrations.rollback.test.ts tests/unit/db.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
MIGRATION_EXCLUDE='056_add_users_must_change_password.sql,zzzz20260501100000_create_yjs_state_tables.ts' \
pnpm exec node --input-type=module -e "import path from 'node:path'; import { pathToFileURL } from 'node:url'; const moduleUrl = pathToFileURL(path.resolve('packages/core-backend/dist/src/db/migration-provider.js')).href; const { createCoreBackendMigrationProvider } = await import(moduleUrl); const runtimeDir = path.resolve('packages/core-backend/dist/src/db'); const provider = createCoreBackendMigrationProvider({ runtimeDir }); const migrations = await provider.getMigrations(); console.log(JSON.stringify({ hasMustChangePassword: Boolean(migrations['056_add_users_must_change_password']), hasYjsTables: Boolean(migrations['zzzz20260501100000_create_yjs_state_tables']), total: Object.keys(migrations).length }, null, 2));"
```

## Results

- `tests/unit/migration-provider.test.ts` + `tests/unit/migrations.rollback.test.ts` + `tests/unit/db.test.ts`: `21 passed`
- backend build: passed
- built runtime exclusion check:
  - `hasMustChangePassword: false`
  - `hasYjsTables: false`

This confirms:

- the restored exclusion path works in source tests;
- the built runtime artifact also honors `MIGRATION_EXCLUDE`;
- excluded names continue to work even when the input uses file extensions.

## CI Failure Mapping

The local hardening addresses the observed PR `#918` failures as follows:

- `migration-replay`
  - fixed by restoring `MIGRATION_EXCLUDE` handling in the combined migration provider;
- `observability-e2e`
  - fixed by restoring the same exclusion handling used in replay environments;
- `Plugin System Tests`
  - fixed by:
    - switching ESM migration fixtures to `.mjs`;
    - adding `MIGRATION_EXCLUDE` to both workflow migration steps.

## Conclusion

- The migration provider regression has a direct unit test, a built-runtime verification, and workflow alignment coverage.
- No additional remote deployment was required for this hardening slice.
- PR `#918` is ready for a fresh CI pass after these updates are pushed.
