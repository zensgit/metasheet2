# Platform Shell Wave 1 Tenant And Runtime Hardening Verification

## Verification Scope

This verification covers the three review findings closed by the tenant/runtime hardening slice:

1. normal auth paths preserve tenant context
2. platform app instance reads use tenant-aware shard routing
3. partial installs surface degraded platform shell actions

## Commands

### Backend targeted tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/platform-apps-router.test.ts \
  tests/unit/after-sales-plugin-routes.test.ts \
  tests/unit/auth-login-routes.test.ts
```

Result:

- `3` test files passed
- `138` tests passed

### Frontend targeted tests

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/api.spec.ts \
  tests/useAuth.spec.ts \
  tests/platform-app-actions.spec.ts \
  tests/platform-app-shell.spec.ts \
  tests/platform-app-launcher.spec.ts
```

Result:

- `5` test files passed
- `22` tests passed

### Backend build

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- build passed

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

Result:

- build passed
- existing Vite bundle-size warnings remain
- existing Vite websocket-port warning in Vitest remains non-blocking

## Assertions Covered

### Auth and tenant propagation

- login route accepts `x-tenant-id`
- login route accepts `tenantId` in request body
- dev-token refresh forwards stored tenant hint
- session bootstrap forwards `x-tenant-id` when a tenant hint is stored
- generic `apiFetch()` forwards `x-tenant-id`

Relevant tests:

- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `apps/web/tests/api.spec.ts`
- `apps/web/tests/useAuth.spec.ts`

### Tenant-scoped platform instance access

- platform app list reads through `queryForTenant(...)`
- authenticated users without explicit `tenantId` fall back to tenant `default`
- unauthenticated callers do not gain tenant access from raw headers

Relevant tests:

- `packages/core-backend/tests/unit/platform-apps-router.test.ts`
- `packages/core-backend/tests/unit/after-sales-plugin-routes.test.ts`

### Partial install handling

- runtime snapshot `partial` yields `Reinstall app`
- instance metadata `installStatus=partial` yields `Reinstall app` before runtime refresh
- launcher reflects degraded runtime state
- shell diagnostics continue to display degraded runtime information

Relevant tests:

- `apps/web/tests/platform-app-actions.spec.ts`
- `apps/web/tests/platform-app-launcher.spec.ts`
- `apps/web/tests/platform-app-shell.spec.ts`

## Residual Risks

- `default` tenant fallback is an explicit compatibility choice for authenticated-but-tenantless callers. If tenant selection becomes first-class in the shell, this fallback should be revisited.
- `platform_app_instances` still depends on tenant/workspace alignment for this Wave 1 cut.
- This slice does not introduce a global cross-app tenant picker. It only hardens propagation of the existing tenant hint model.
