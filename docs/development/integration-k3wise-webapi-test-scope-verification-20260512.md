# K3 WISE WebAPI test scope verification

## Scope

Verify the K3 WISE setup page sends tenant/workspace scope when testing a saved WebAPI system and shows `connected` immediately when the backend test succeeds.

## Local Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationK3WiseSetupView.spec.ts tests/k3WiseSetup.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Expected Assertions

- View test posts `tenantId: default` and `workspaceId: null` to `/api/integration/external-systems/:id/test`.
- View test renders `connected` after a successful test response.
- Existing K3 WISE setup helper tests remain green.
- Web build passes.
- Diff check is clean.

## Result

Executed on branch `codex/k3wise-webapi-test-status-20260512`:

```text
pnpm --filter @metasheet/web exec vitest run tests/IntegrationK3WiseSetupView.spec.ts tests/k3WiseSetup.spec.ts --watch=false
```

Result:

```text
Test Files  2 passed (2)
Tests       30 passed (30)
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
