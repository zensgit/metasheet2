# Platform Shell Wave 1 Runtime Cache Follow-up Design

## Scope

This follow-up slice closes two residual review risks left after the tenant/runtime hardening pass:

1. `clearStoredAuthState()` did not clear tenant hints.
2. runtime install-state cache was global per `appId` and could leak degraded state across tenants.

## Fix 1: Clear Tenant Hints With Auth State

The frontend now treats tenant hints as part of the same auth envelope as the stored token and user snapshot.

### Change

`clearStoredAuthState()` now removes:

- `auth_token`
- `jwt`
- `devToken`
- `tenantId`
- `workspaceId`
- user feature and role snapshots

### Reason

Without this change, a stale `tenantId/workspaceId` could survive 401 handling or login failure and get reapplied to the next login attempt through `authHeaders()`.

## Fix 2: Scope Runtime Install Cache By Tenant

The original runtime cache used `appId` as its only key. That is insufficient for a platform shell that can switch tenants or recover from failed runtime refreshes.

### Change

Runtime install-state caching now uses a scoped cache key:

- prefer `instance.workspaceId`
- otherwise fall back to the stored/location tenant hint
- otherwise fall back to app-global only as a last resort

Runtime refresh failures now clear the scoped cache entry instead of preserving stale degraded state.

### Reason

This prevents:

- tenant A degraded state from leaking into tenant B
- stale `partial/failed` state surviving a later `currentPath` refresh failure

## Files Touched

- `apps/web/src/utils/api.ts`
- `apps/web/src/composables/usePlatformApps.ts`
- `apps/web/src/views/PlatformAppShellView.vue`
- `apps/web/tests/api.spec.ts`
- `apps/web/tests/usePlatformApps.spec.ts`
