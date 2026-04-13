# Platform Shell Wave 1 Runtime Cache Follow-up Verification

## Verification Scope

This verification covers the residual fixes after the tenant/runtime hardening pass:

1. tenant hints are cleared together with auth state
2. runtime install-state cache no longer leaks degraded state across tenant scopes

## Commands

### Frontend targeted tests

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/api.spec.ts \
  tests/useAuth.spec.ts \
  tests/usePlatformApps.spec.ts \
  tests/platform-app-actions.spec.ts \
  tests/platform-app-shell.spec.ts \
  tests/platform-app-launcher.spec.ts
```

Result:

- `6` test files passed
- `27` tests passed

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

Result:

- build passed
- existing bundle-size warnings remain unchanged

## Assertions Covered

### Auth state clearing

- `clearStoredAuthState()` removes `tenantId` and `workspaceId`
- `authHeaders()` no longer forwards `x-tenant-id` after auth state is cleared

Relevant test:

- `apps/web/tests/api.spec.ts`

### Tenant-scoped runtime cache

- tenant A degraded runtime state does not bleed into tenant B
- failed runtime refresh clears scoped cache and falls back to the new tenant state

Relevant test:

- `apps/web/tests/usePlatformApps.spec.ts`

## Residual Notes

- This follow-up only hardens the current tenant-hint model.
- It does not introduce a user-facing tenant selector or tenant switch UX.
