# Core: merge admin+observability+RBAC+views alignment (for #155)

## Purpose
Resolve #155 conflicts by combining admin/observability, config reload + metrics, and views RBAC/state alignment while preserving a single router (`/api/views`) and JSONB config model.

## Changes

### Metrics
- Added: `config_reload_total{result}`, `config_sampling_rate`, `view_data_latency_seconds{type,status}`, `view_data_requests_total{type,result}`.
- Preserved (from main): `rbac_perm_queries_real_total`, `rbac_perm_queries_synth_total`, `plugin_permission_denied_total`.

### Admin Endpoints
- `GET /api/admin/config` (sanitized config)
- `POST /api/admin/config/reload` (increments `config_reload_total{success|error}`)
- `GET /api/admin/db/health` (core tables presence; 503 on failure)

### Index Wiring
- Mounted `adminRouter()` and `observabilityRouter()`.
- `/api/plugins?verbose=1` returns `sanitizeConfig(getConfig())`.
- Flags via ConfigService (`auth.kanbanAuthRequired`, `ws.redisEnabled`).

### Views + RBAC
- Enforced `canReadTable`/`canWriteTable` for config/data/state/CRUD.
- Unified configs in `views.config` (JSONB). Create requires `tableId`.
- View state uses `view_states.state` (JSONB) with UPSERT.
- Gallery/Form create aligned to `views` with `tableId`; legacy form submission kept as-is temporarily.

### Changelog
- Added v2.1.3 (Unreleased) entry summarizing the above.

## Validation

### Local
- Env:
  - `export DATABASE_URL='postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2'`
  - `export JWT_SECRET='dev-secret-key'`
- Migrate/Run:
  - `pnpm -F @metasheet/core-backend db:migrate`
  - `pnpm -F @metasheet/core-backend dev:core`
- Pre-merge check (authenticated):
  - `API_ORIGIN=http://localhost:8900 pnpm -F @metasheet/core-backend pre-merge:check`
  - Verifies metrics presence and admin endpoints correctness.
- RBAC smoke:
  - `API_ORIGIN=http://localhost:8900 pnpm -F @metasheet/core-backend smoke:table-perms`
  - Expect 403 → grant → 200.

### Manual checks
- `/metrics/prom` contains: `config_reload_total`, `config_sampling_rate`, `view_data_latency_seconds`, `view_data_requests_total`.
- `GET /api/admin/config` → 200, sanitized.
- `POST /api/admin/config/reload` → 200, increments counter.
- `GET /api/admin/db/health` → 200 with `healthy=true` and tables flags.
- `/api/plugins?verbose=1` → sanitized config returned.

## Compatibility
- Single `/api/views` router; JSONB configs only; no new config tables.
- JWT secret via ConfigService.

## Risks/Notes
- Ensure DB has `view_states.state` (JSONB). If some envs still use `state_data`, add a migration or temporary compatibility layer.
- `/api/admin/db/health` currently returns optimistic table presence flags. It can be refined using `information_schema` in a follow-up.
- Clean up extra dev processes to avoid port conflicts; non-blocking plugin warnings can be ignored or fixed separately.

## Rollback
Revert these files if needed:
- `packages/core-backend/src/metrics/metrics.ts`
- `packages/core-backend/src/routes/admin.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/views.ts`
- `CHANGELOG.md`

## Files Changed
- `CHANGELOG.md`
- `packages/core-backend/src/metrics/metrics.ts`
- `packages/core-backend/src/routes/admin.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/views.ts`
