# Legacy SQL Migration Skip Verification

## Goal

Prove that the migration provider no longer applies superseded legacy numeric
core SQL migrations by default, while preserving the on-prem/K3 SQL migrations
needed by packaged deployments.

## Local Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/migration-provider.test.ts \
  --watch=false
```

Expected result:

- migration provider unit tests pass;
- `032_create_approval_records`, `037_add_gallery_form_support`, and
  `055_create_attendance_import_tokens` are absent from the default migration
  set;
- `056_add_users_must_change_password` and
  `057_create_integration_core_tables` remain present.

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/migration-provider.test.ts \
  tests/unit/users-must-change-password-migration.test.ts \
  tests/unit/gallery-form-sql-migration.test.ts \
  tests/unit/plugin-infrastructure-sql-migration.test.ts \
  --watch=false
```

Expected result:

- provider behavior remains green;
- `056_add_users_must_change_password.sql` no-ops safely when `users` does not
  exist yet;
- `zzzz20260512100000_add_users_must_change_password.ts` provides the modern
  timestamp bridge after users table creation;
- historical SQL compatibility tests remain available for audit coverage even
  though superseded legacy SQL is skipped by default.

Observed locally:

- `4 passed` test files;
- `16 passed` tests.

```bash
git diff --check origin/main...HEAD
```

Expected result:

- no whitespace errors;
- no conflict markers.

Observed locally:

- command exited `0`.

## Real Provider Smoke

```bash
pnpm exec tsx -e "import path from 'node:path'; import { createCoreBackendMigrationProvider } from './packages/core-backend/src/db/migration-provider.ts'; (async()=>{ const provider=createCoreBackendMigrationProvider({ runtimeDir: path.resolve('packages/core-backend/src/db') }); const migrations=await provider.getMigrations(); const names=Object.keys(migrations); const report={ has032:names.includes('032_create_approval_records'), has037:names.includes('037_add_gallery_form_support'), has055:names.includes('055_create_attendance_import_tokens'), has056:names.includes('056_add_users_must_change_password'), hasModernMustChange:names.includes('zzzz20260512100000_add_users_must_change_password'), has057:names.includes('057_create_integration_core_tables'), has058:names.includes('058_integration_runs_running_unique'), has059:names.includes('059_integration_runs_history_index'), total:names.length }; console.log(JSON.stringify(report,null,2)); })();"
```

Observed:

```json
{
  "has032": false,
  "has037": false,
  "has055": false,
  "has056": true,
  "hasModernMustChange": true,
  "has057": true,
  "has058": true,
  "has059": true,
  "total": 131
}
```

## Regression Matrix

| Case | Expected |
| --- | --- |
| Source-style runtime loads timestamp code migration plus `056` | Present |
| Dist-style runtime loads timestamp SQL migration plus `056` | Present |
| Default provider sees `032`, `037`, `055`, `056`, `057` in legacy folder | Only `056` and `057` remain |
| Fresh replay applies `056` before timestamp `users` creation | `056` is guarded and does not fail |
| Timestamp users migration has run | `zzzz20260512100000_add_users_must_change_password` adds the required column |
| Legacy event-bus SQL is skipped | CI allows `20250924200000_create_event_bus_tables` to run so later event-bus alignment has tables to alter |
| `includeSupersededLegacySqlMigrations: true` | `037` is visible for explicit audits |
| `MIGRATION_EXCLUDE` / `excludedNames` excludes `056` | Existing exclusion behavior preserved |
| Duplicate migration names across provider folders | Still fails fast |

## Package Verification Follow-up

After merge, the next on-prem package should be rebuilt from the new main SHA
and verified with:

```bash
scripts/ops/multitable-onprem-package-verify.sh <package.zip-or-tgz>
```

The package should still include the required K3/on-prem SQL files:

- `packages/core-backend/migrations/056_add_users_must_change_password.sql`
- `packages/core-backend/migrations/057_create_integration_core_tables.sql`
- `packages/core-backend/migrations/058_integration_runs_running_unique.sql`
- `packages/core-backend/migrations/059_integration_runs_history_index.sql`

## Deployment Acceptance

For the Windows/on-prem deployment that hit issue `#651`, acceptance is:

1. deploy package built from the merged SHA;
2. migration step no longer attempts superseded legacy SQL `032` through `055`;
3. `056` still supplies `users.must_change_password`;
4. `057` through `059` still supply integration runtime tables and indexes;
5. service starts without manual database patching.
