# Federation Config Update Verification (2025-12-31)

## Scope
- Validate federation config persistence to `system_configs`.
- Verify RBAC-protected federation endpoints without `RBAC_BYPASS`.
- Confirm audit + BPMN tables exist to avoid startup errors.

## Environment
- Backend: `DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet JWT_SECRET=dev-secret-key pnpm --filter @metasheet/core-backend dev:core`
- Port: `http://127.0.0.1:7778`
- DB: `metasheet-dev-postgres` (host port `5435`)
- Auth: JWT via `scripts/gen-dev-token.js` (USER_ID=`dev-federation-admin`)

## Prep / Fixes Applied
- `_patterns.checkTableExists/checkColumnExists` now filter `table_schema='public'`.
- `20250924140000_create_gantt_tables.ts` creates `update_updated_at_column()` before triggers.
- `20250924200000_create_event_bus_tables.ts` removes duplicate `plugin_event_permissions` creation.
- New migrations:
  - `z20251231_create_system_configs` (system configs)
  - `zz20251231_create_audit_tables` (audit logs)
  - `zz20251231_create_bpmn_tables` (BPMN runtime tables)
- Added seed: `packages/core-backend/scripts/seed-federation-admin.ts`.
- Added verifier: `scripts/verify_federation_config.sh`.
- Audit logging now ignores non-numeric user IDs to avoid NaN inserts.

## Steps + Results

1) Run migrations

```bash
cd packages/core-backend
DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet \
  pnpm exec tsx src/db/migrate.ts
```

Result: **OK**. `zz20251231_create_audit_tables` and `zz20251231_create_bpmn_tables` executed.

2) Seed RBAC (admin + federation perms)

```bash
DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet \
  pnpm --filter @metasheet/core-backend exec tsx scripts/seed-federation-admin.ts
```

Result: **OK**. `dev-federation-admin` seeded.

3) Start backend (RBAC enabled)

```bash
DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet \
JWT_SECRET=dev-secret-key PORT=7778 \
  pnpm --filter @metasheet/core-backend dev:core
```

4) Run federation verification script

```bash
DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet \
JWT_SECRET=dev-secret-key USER_ID=dev-federation-admin \
  scripts/verify_federation_config.sh http://127.0.0.1:7778
```

Result: **OK** (`Federation config verification passed`).

## Evidence
- `system_configs` rows now include `plm.url`, `plm.apiToken`, `plm.apiKey`.
- Backend log shows `Config 'plm.*' saved to database` and adapter reconnect.
- No `Audit] Failed to record audit log` errors after federation verification run.

## Overall
- Federation config updates persist to DB and work under RBAC enforcement.
- Audit/BPMN tables exist, removing startup errors for missing `audit_logs` and `bpmn_*` tables.
