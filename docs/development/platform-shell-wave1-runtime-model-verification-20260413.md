# Platform Shell Wave 1 Runtime Model Verification

Date: 2026-04-13
Branch: `feat/platform-shell-wave1`
Rebased head: `9328cc8e2`

## Verification Scope

This verification covers:

- app runtime model parsing
- tenant app instance registry behavior
- platform app router responses
- after-sales registry-first current/install compatibility
- frontend action resolution for direct vs instance apps
- production build health after rebase onto latest `main`

## Commands Executed

Backend targeted tests:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/platform-app-registry.test.ts \
  tests/platform-app-instance-registry.test.ts \
  tests/unit/platform-apps-router.test.ts \
  tests/unit/after-sales-plugin-routes.test.ts
```

Frontend targeted tests:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/usePlatformApps.spec.ts \
  tests/platform-app-actions.spec.ts
```

Backend build:

```bash
pnpm --filter @metasheet/core-backend build
```

Frontend build:

```bash
pnpm --filter @metasheet/web build
```

## Results

### Backend tests

Result:

- 4 test files passed
- 126 tests passed

Coverage of interest:

- `packages/core-backend/tests/platform-app-registry.test.ts`
- `packages/core-backend/tests/platform-app-instance-registry.test.ts`
- `packages/core-backend/tests/unit/platform-apps-router.test.ts`
- `packages/core-backend/tests/unit/after-sales-plugin-routes.test.ts`

Validated behaviors:

- manifest collection ignores missing and invalid app manifests
- `main-nav` entry remains preferred over `admin`
- `direct` runtime manifests are collected without tenant instance requirements
- instance registry upsert and lookup semantics remain stable
- platform apps router returns tenant-scoped instance state when tenant context exists
- after-sales `current` remains registry-first with ledger fallback after rebase
- after-sales install contract remains unchanged

### Frontend tests

Result:

- 2 test files passed
- 8 tests passed

Coverage of interest:

- `apps/web/tests/usePlatformApps.spec.ts`
- `apps/web/tests/platform-app-actions.spec.ts`

Validated behaviors:

- `fetchAppById(..., { force: true })` refreshes stale cached shell state
- `instance` apps resolve onboarding, reinstall, inspect, and open actions correctly
- `direct` apps resolve direct-open behavior and report `direct` install state

### Builds

Backend build:

- passed

Frontend build:

- passed

Observed non-blocking warnings:

- Vitest prints a Vite websocket `EPERM` warning in sandboxed frontend runs; tests still pass
- Vite build reports large chunk warnings for existing application bundles
- Vite reports one existing dynamic/static import overlap around `WorkflowDesigner.vue`

These warnings pre-existed this slice and did not block build success.

## Files Verified as Changed

Backend:

- `packages/core-backend/src/platform/app-manifest.ts`
- `packages/core-backend/src/platform/app-registry.ts`
- `packages/core-backend/src/routes/platform-apps.ts`
- `packages/core-backend/src/services/PlatformAppInstanceRegistryService.ts`
- `packages/core-backend/src/db/migrations/zzzz20260413130000_create_platform_app_instances.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/types/plugin.ts`
- `packages/core-backend/src/core/plugin-service-factory.ts`

Frontend:

- `apps/web/src/composables/usePlatformApps.ts`
- `apps/web/src/views/PlatformAppLauncherView.vue`
- `apps/web/src/views/PlatformAppShellView.vue`
- `apps/web/src/App.vue`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/views/AfterSalesView.vue`

Plugins:

- `plugins/plugin-after-sales/app.manifest.json`
- `plugins/plugin-after-sales/lib/installer.cjs`
- `plugins/plugin-attendance/app.manifest.json`

## Git State

The worktree branch was rebased successfully onto latest local `main`.

Post-rebase head:

- `9328cc8e2`

No rebase conflicts occurred.

## Remaining Gaps

- platform shell install/reinstall actions rely on manifest-declared bindings and still present only shell-level success/error messaging
- no generic platform-wide install protocol exists yet
- richer recovery diagnostics for failed instance apps remain a future slice

## Conclusion

Platform Shell Wave 1 is verified on the latest `main` baseline.

The platform shell now supports:

- app catalog discovery
- tenant app instance registry
- `instance` and `direct` runtime separation
- after-sales install/reinstall from the shell through existing plugin contracts
- attendance as a direct-runtime reference app

