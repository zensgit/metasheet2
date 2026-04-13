# Platform Shell Wave 1 Tenant And Runtime Hardening Design

## Scope

This slice hardens the Wave 1 platform shell against three concrete review findings:

1. Tenant-less web login flows could not reliably resolve platform app instances.
2. `platform_app_instances` reads and writes bypassed tenant sharding.
3. Partial after-sales installs were surfaced as healthy app instances in the launcher and shell.

The goal of this slice is to close those gaps without changing the existing plugin runtime contract.

## Problem 1: Tenant Context Was Not Preserved Across Normal Web Auth

The original platform shell path assumed `req.user.tenantId` would always exist. That assumption was too strong for existing web login flows:

- `/api/auth/login` did not consistently receive a tenant hint from the browser.
- `/api/auth/dev-token` only accepted tenant input if the caller provided it manually.
- successful login in `LoginView.vue` persisted the token directly instead of going through `useAuth.setToken()`, so tenant hints were not normalized or stored.
- generic `apiFetch()` requests did not forward any tenant hint.

### Design Adjustment

Tenant hint propagation is now normalized at three layers:

1. Auth routes accept tenant hints from header, query, and request body.
2. Frontend auth persistence stores `tenantId` and `workspaceId` hints alongside the token.
3. Generic API requests forward `x-tenant-id` whenever a tenant hint is present.

### Result

Normal browser login, dev-token refresh, and follow-up platform shell requests now use the same tenant hint source instead of relying on a plugin-specific workaround.

## Problem 2: Platform App Instance Registry Ignored Tenant Sharding

The first platform shell cut queried `platform_app_instances` with `poolManager.get()` directly. That was incorrect in sharded deployments because request-level tenant routing was already available through `tenantContext`.

### Design Adjustment

`platform_app_instances` access now routes through tenant-aware query functions:

- platform routes resolve tenant in this order:
  - `req.user.tenantId`
  - `tenantContext.getTenantId()`
  - authenticated-user fallback to `default`
- registry reads and writes use `tenantContext.getPoolManager().queryForTenant(...)` when a tenant is available
- fallback to `poolManager.get()` only remains for cases where no tenant-scoped pool manager exists

### Result

Platform shell instance state now follows the same shard selection model as the rest of the tenant-scoped backend.

## Problem 3: Partial Installs Were Surfaced As Healthy Instances

The initial after-sales installer wrote an `active` platform instance before the final install ledger status was known. If the install ended as `partial`, the platform shell still treated it as healthy and showed `Open app`.

### Design Adjustment

The installer and platform shell now use a consistent degraded-state contract:

- failed installs write instance metadata `installStatus: failed`
- successful installs write the final ledger first, then upsert the platform instance
- partial installs write:
  - `status: inactive`
  - `metadata.installStatus: partial`
  - `metadata.reportRef`
- current-state readers map instance metadata back into shell runtime state
- launcher and shell prefer runtime degradation state over raw instance status

### Result

`partial` and `failed` states now produce reinstall or recovery actions instead of a false `Open app` action.

## Compatibility Notes

- No new backend endpoint was introduced.
- No plugin install contract was changed.
- Existing after-sales current/install endpoints remain the runtime source of truth.
- Default authenticated fallback uses tenant `default` only when the caller is authenticated but has no explicit tenant. Anonymous calls still do not gain tenant access.

## Files Touched

- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/routes/platform-apps.ts`
- `plugins/plugin-after-sales/index.cjs`
- `plugins/plugin-after-sales/lib/installer.cjs`
- `apps/web/src/utils/api.ts`
- `apps/web/src/composables/useAuth.ts`
- `apps/web/src/composables/usePlatformApps.ts`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/PlatformAppLauncherView.vue`
- `apps/web/src/views/PlatformAppShellView.vue`
