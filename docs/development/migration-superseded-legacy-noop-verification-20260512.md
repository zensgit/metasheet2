# Superseded Legacy SQL No-op Migration Provider Verification

## Goal

Verify the migration provider fix that unblocks upgraded databases with existing
legacy migration history while still preventing superseded legacy SQL bodies
from replaying on fresh installs.

## Pre-fix Evidence

142 had all superseded legacy SQL names recorded in `kysely_migration`:

- `032_create_approval_records`
- `033_create_rbac_core`
- `034_create_spreadsheets`
- `035_create_files`
- `036_create_spreadsheet_permissions`
- `037_add_gallery_form_support`
- `038_config_and_secrets`
- `040_data_sources`
- `041_script_sandbox`
- `042_core_model_completion`
- `042a_core_model_views`
- `042b_external_data_model`
- `042c_audit_placeholder`
- `042d_audit_and_cache`
- `042d_plugins_and_templates`
- `043_core_model_views`
- `044_external_data_model`
- `045_audit_placeholder`
- `046_plugins_and_templates`
- `047_audit_and_cache`
- `047_create_event_bus_tables`
- `048_create_event_bus_tables`
- `049_create_bpmn_workflow_tables`
- `050_create_snapshot_core`
- `051_create_minimal_views`
- `052_recreate_minimal_views`
- `053_create_protection_rules`
- `054_create_users_table`
- `055_create_attendance_import_tokens`

The failed deploy path reported:

```text
failed to migrate
Error: corrupted migrations: previously executed migration 032_create_approval_records is missing
```

## Local Verification

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/migration-provider.test.ts \
  tests/unit/migrations.rollback.test.ts \
  tests/unit/db.test.ts \
  --watch=false
```

Observed:

```text
Test Files  3 passed (3)
Tests       23 passed (23)
```

```bash
pnpm --filter @metasheet/core-backend build
```

Observed:

```text
exit 0
```

```bash
pnpm exec tsx -e "import path from 'node:path'; import { createCoreBackendMigrationProvider } from './packages/core-backend/src/db/migration-provider.ts'; (async()=>{ const provider=createCoreBackendMigrationProvider({ runtimeDir: path.resolve('packages/core-backend/src/db') }); const migrations=await provider.getMigrations(); const names=Object.keys(migrations); const report={ has032:names.includes('032_create_approval_records'), has037:names.includes('037_add_gallery_form_support'), has055:names.includes('055_create_attendance_import_tokens'), has056:names.includes('056_add_users_must_change_password'), hasModernMustChange:names.includes('zzzz20260512100000_add_users_must_change_password'), has057:names.includes('057_create_integration_core_tables'), has058:names.includes('058_integration_runs_running_unique'), has059:names.includes('059_integration_runs_history_index'), total:names.length }; console.log(JSON.stringify(report,null,2)); })();"
```

Observed:

```json
{
  "has032": true,
  "has037": true,
  "has055": true,
  "has056": true,
  "hasModernMustChange": true,
  "has057": true,
  "has058": true,
  "has059": true,
  "total": 160
}
```

```bash
git diff --check
```

Observed:

```text
exit 0
```

## Acceptance Criteria

| Gate | Expected |
| --- | --- |
| Default provider returns `032`/`037`/`055` when files exist | Present as no-op markers |
| Default provider returns `056` through `059` | Present and executable |
| Explicit compatibility audit flag | Real superseded SQL migrations remain loadable |
| `MIGRATION_EXCLUDE` / `excludedNames` | Explicit exclusions still hide requested names |
| 142 deploy migration step | No Kysely corrupted-history failure |
| 142 runtime health | Backend `/api/health=200`, Web `/=200`, unauthenticated `/api/auth/me=401` |

## Post-merge Verification

Pending until this branch is merged and the production deploy workflow reruns.
