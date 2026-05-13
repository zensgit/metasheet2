# Generic Integration Workbench Frontend Shell Verification - 2026-05-12

## Files Changed

- `apps/web/src/services/integration/workbench.ts`
- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/router/types.ts`
- `apps/web/tests/integrationWorkbench.spec.ts`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/generic-integration-workbench-frontend-shell-design-20260512.md`
- `docs/development/generic-integration-workbench-frontend-shell-verification-20260512.md`

## Verification Matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| Service defaults | `tenantId=default`, blank workspace omitted | `integrationWorkbench.spec.ts` |
| Adapter discovery | Calls `/api/integration/adapters` | `integrationWorkbench.spec.ts` |
| System discovery | Calls scoped `/api/integration/external-systems` | `integrationWorkbench.spec.ts` |
| Object discovery | URL-encodes system ID and sends tenant scope | `integrationWorkbench.spec.ts` |
| Schema discovery | Sends `object` and tenant scope | `integrationWorkbench.spec.ts` |
| Preview service | POSTs to `/api/integration/templates/preview` | `integrationWorkbench.spec.ts` |
| Pipeline service | POSTs pipeline upsert and run/dry-run payloads | `integrationWorkbench.spec.ts` |
| Observation service | Lists staging descriptors, runs, and open dead letters | `integrationWorkbench.spec.ts` |
| Workbench view bootstrap | Loads adapters and systems on mount | `IntegrationWorkbenchView.spec.ts` |
| SQL advanced signal | Shows SQL Server adapter as `高级` | `IntegrationWorkbenchView.spec.ts` |
| Source/target object loading | Loads object lists and schemas | `IntegrationWorkbenchView.spec.ts` |
| Mapping seed | Seeds K3 Material-style mappings from target schema | `IntegrationWorkbenchView.spec.ts` |
| Payload preview | Sends template/mapping request and renders JSON result | `IntegrationWorkbenchView.spec.ts` |
| Pipeline execution panel | Saves pipeline, dry-runs, and Save-only runs with explicit guard | `IntegrationWorkbenchView.spec.ts` |
| Observation panel | Renders recent runs and open dead-letter errors after dry-run | `IntegrationWorkbenchView.spec.ts` |
| K3 setup regression | Existing K3 setup tests still pass | `IntegrationK3WiseSetupView.spec.ts`, `k3WiseSetup.spec.ts` |
| Production build | `vue-tsc -b && vite build` passes | `pnpm --filter @metasheet/web build` |

## Commands

Executed in `/Users/chouhua/Downloads/Github/metasheet2`:

```bash
pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Result

PASS.

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false` | PASS - 2 files, 3 tests |
| `pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false` | PASS - 2 files, 30 tests |
| `pnpm --filter @metasheet/web build` | PASS - existing chunk-size/import warnings only |
| `git diff --check` | PASS - no whitespace errors or conflict markers |

The frontend route is intentionally available at `/integrations/workbench` without changing the main application navigation in this slice. That keeps the rollout low-risk while the workbench is still preview-only.
