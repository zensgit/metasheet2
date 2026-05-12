# K3 WISE setup guidance verification

## Scope

Verify the setup page now explains the integration scope fields, the WebAPI Base URL/path split, and the K3 connection test result without changing backend behavior.

## Static Checks

Expected source updates:

- `apps/web/src/services/integration/k3WiseSetup.ts`
  - defaults `tenantId` to `default` when local storage has no tenant;
  - preserves stored local tenant when one exists.
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
  - labels `Tenant ID` as a scope field;
  - labels `Workspace ID` as optional;
  - changes Base URL placeholder to host-only form;
  - warns when Base URL includes `/K3API`;
  - adds WebAPI connection state messaging.

## Local Test Plan

Run:

```bash
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check origin/main...HEAD
```

Expected:

- helper tests pass, including default `Tenant ID = default`;
- setup view tests pass, including rendered guidance copy and `/K3API` warning;
- frontend build passes;
- diff check is clean.

## Manual Operator Acceptance

On the K3 WISE setup page:

1. New empty form should show `Tenant ID` prefilled as `default`.
2. `Workspace ID` should be visibly optional.
3. `WebAPI Base URL` should show a host-only placeholder.
4. If an operator enters `http://k3-host/K3API/`, the page should show a warning to remove `/K3API`.
5. Side rail should show `WebAPI 状态`.
6. Before saving, state should be `not saved`.
7. After saving and running `测试 WebAPI`, a successful backend test should show `connected` with the last test time.

## Result

Executed on branch `codex/k3wise-setup-guidance-20260512`:

```text
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false
```

Result:

```text
Test Files  2 passed (2)
Tests       29 passed (29)
```

```text
pnpm --filter @metasheet/web build
```

Result:

```text
vue-tsc -b && vite build
✓ built
```

```text
git diff --check
```

Result: clean.
