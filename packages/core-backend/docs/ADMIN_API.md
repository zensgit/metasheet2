# Admin API

Admin endpoints for inspecting plugin infrastructure and operational state. These APIs are protected and intended for operators.

## Authentication & Authorization
- Protected by JWT middleware; not whitelisted.
- Requires RBAC permission: `permissions:read` (via `rbacGuard('permissions','read')`).
- In non-production, `/api/test/*` routes are open for smoke checks; admin routes are not.

## Endpoints

- List KV keys for a plugin
  - `GET /api/admin/plugin-kv/:plugin`
  - Query variant (for names with `/`): `GET /api/admin/plugin-kv?plugin=@metasheet/plugin-test-a`
  - Response: `{ ok: true, data: [{ key, updated_at }, ...] }`

- Get a KV value
  - `GET /api/admin/plugin-kv/:plugin/:key`
  - Query variant: `GET /api/admin/plugin-kv/value?plugin=@scope/name&key=lastPing`
  - Response: `{ ok: true, data: { plugin, key, value, updated_at } }`

- Read-only configuration snapshot (sanitized)
  - `GET /api/admin/config`
  - Response: `{ ok: true, data: { server, db: '<configured>', ws, auth, featureFlags, telemetry } }`

## Notes
- Backed by `plugin_kv` table (see PLUGIN_KV_AND_COMMUNICATION.md for schema/details).
- If `DATABASE_URL` is not configured, endpoints return `503 DB_UNAVAILABLE`.
- Typical use: debug plugin data or verify persistence in lower environments.
 - For observability, `/metrics/config` exposes the same sanitized configuration without RBAC.

## CLI Helper
- A simple CLI is available to query admin KV endpoints:
  - List keys: `pnpm -F @metasheet/core-backend admin:kv list --plugin @metasheet/plugin-test-a`
  - Get value: `pnpm -F @metasheet/core-backend admin:kv get --plugin @metasheet/plugin-test-a --key lastPing`
  - Env vars:
    - `API_ORIGIN` (default `http://localhost:8900`)
    - `JWT_TOKEN` (Bearer for admin endpoints)
