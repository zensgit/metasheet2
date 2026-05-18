# Data Factory connector UX verification for issue #651

Date: 2026-05-17
Branch: `codex/issue651-data-factory-connector-ux-20260517`

## Local verification

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false` | PASS, 7/7 |
| `pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false` | PASS, 28/28 |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS |
| `pnpm --filter @metasheet/web build` | PASS, Vite emitted existing chunk-size / dynamic-import warnings |
| `git diff --check` | PASS |

Additional lint probe:

| Check | Result |
| --- | --- |
| `pnpm --filter @metasheet/web exec eslint "src/views/IntegrationWorkbenchView.vue" "tests/IntegrationWorkbenchView.spec.ts" --max-warnings=0` | FAIL: 0 errors, 18 pre-existing router-link stub warnings in `IntegrationWorkbenchView.spec.ts`; the new test suppresses its local stub warning |

## Assertions added

The new `IntegrationWorkbenchView` test verifies:

- source selector includes readable PLM source
- source selector excludes target-only K3 WISE WebAPI
- target selector includes K3 WISE WebAPI
- the page explains K3 WISE WebAPI read/list is GATE-blocked
- delete is visible but disabled because the backend route does not exist
- copy action creates an inactive draft
- duplicate warning appears for same adapter kind and role
- save draft uses existing external-system upsert API
- edit action updates an existing system
- deactivate action upserts `status=inactive`

## Stage 1 Lock check

This change touches only:

- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- this design/verification documentation

It does not touch:

- `plugins/plugin-integration-core`
- backend routes
- migrations
- K3 WISE read/list runtime
- Windows on-prem package scripts

## Deployment impact

Frontend-only. Existing deployments need a rebuilt web bundle to see the new explanatory copy and connection-management controls.

No DB migration is required.

## Remaining backend gap

Physical delete still requires a backend route such as `DELETE /api/integration/external-systems/:id`. The current safe alternative is deactivate via the existing upsert route.
