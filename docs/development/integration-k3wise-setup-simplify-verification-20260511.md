# K3 WISE Setup Page Simplification Verification - 2026-05-11

## Scope

This verification covers the frontend-only simplification of the K3 WISE setup page.

Changed files:

- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/IntegrationK3WiseSetupView.spec.ts`
- `docs/development/integration-k3wise-setup-simplify-design-20260511.md`
- `docs/development/integration-k3wise-setup-simplify-verification-20260511.md`

## Assertions

The new component test verifies:

- the first-run journey strip renders the K3 setup path
- `基础连接` remains visible by default
- `多维表清洗准备` remains visible by default
- advanced form sections are collapsed by default
- side-rail execution/observation panels are collapsed by default

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationK3WiseSetupView.spec.ts tests/k3WiseSetup.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

Targeted test result:

```text
Test Files  2 passed (2)
Tests       27 passed (27)
```

Build result:

```text
@metasheet/web build passed.
vue-tsc -b completed.
vite build completed.
```

Diff check:

```text
git diff --check returned 0.
```

Notes:

- The first attempt used workspace-root test paths while running inside the filtered `apps/web` package and Vitest correctly reported no files found.
- The component test initially assumed `localStorage.clear()` existed in the test environment. The guard now checks that the function is available before calling it.
- The production web build emitted pre-existing chunk-size and dynamic-import warnings, but exited successfully.

## Behavior Compatibility

No backend or service payload builder was changed. The existing `k3WiseSetup.spec.ts` suite still passed, covering:

- WebAPI external-system payloads
- authority-code token payloads
- credential preservation
- SQL Server channel payloads
- staging install payloads
- pipeline payloads and run queries
- deploy-gate helper behavior

## Deployment Impact

Runtime impact is limited to the web UI. There are no:

- migrations
- plugin changes
- backend route changes
- package-build changes
- secret-handling changes

The deployment package can include this as a normal frontend update.
