# Platform Shell Wave 1.1 Recovery Verification

Date: 2026-04-13
Branch: `feat/platform-shell-wave1`

## Verification Scope

This verification covers:

- shell-level runtime diagnostics rendering
- shell install action refresh behavior
- unchanged backend platform-shell and after-sales compatibility
- frontend build health after recovery UX changes

## Commands Executed

Frontend targeted tests:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/usePlatformApps.spec.ts \
  tests/platform-app-actions.spec.ts \
  tests/platform-app-shell.spec.ts
```

Frontend build:

```bash
pnpm --filter @metasheet/web build
```

Backend regression suite:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/platform-app-registry.test.ts \
  tests/platform-app-instance-registry.test.ts \
  tests/unit/platform-apps-router.test.ts \
  tests/unit/after-sales-plugin-routes.test.ts
```

## Results

### Frontend tests

Result:

- 3 test files passed
- 10 tests passed

Covered behaviors:

- force-refresh of app summary cache
- action resolution for direct and instance apps
- shell diagnostics rendering from `currentPath`
- install mutation execution and post-install refresh

Relevant files:

- `apps/web/tests/usePlatformApps.spec.ts`
- `apps/web/tests/platform-app-actions.spec.ts`
- `apps/web/tests/platform-app-shell.spec.ts`

### Frontend build

Result:

- passed

Observed warnings:

- existing Vite chunk size warnings
- existing dynamic/static import overlap around `WorkflowDesigner.vue`

These warnings were non-blocking and predate this slice.

### Backend regression

Result:

- 4 test files passed
- 126 tests passed

Reason for rerun:

- Wave 1.1 does not change backend code, but the shell now depends more directly on the stability of existing `after-sales` current/install behavior.

Relevant files:

- `packages/core-backend/tests/platform-app-registry.test.ts`
- `packages/core-backend/tests/platform-app-instance-registry.test.ts`
- `packages/core-backend/tests/unit/platform-apps-router.test.ts`
- `packages/core-backend/tests/unit/after-sales-plugin-routes.test.ts`

## Verified Outcomes

- `PlatformAppShell` renders runtime diagnostics when `currentPath` is declared
- diagnostics include current status, report reference, created object/view counts, and warnings
- install success keeps shell content visible and refreshes the runtime snapshot
- `after-sales` contract remains unchanged
- `attendance` direct-runtime path remains unaffected

## Files Changed in This Slice

- `apps/web/src/views/PlatformAppShellView.vue`
- `apps/web/tests/platform-app-shell.spec.ts`

## Conclusion

Wave 1.1 is verified.

The shell now provides:

- non-blocking install/reinstall notices
- plugin-owned recovery diagnostics
- component-level coverage for install-refresh behavior

