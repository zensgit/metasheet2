# Generic Integration Workbench Advanced Connectors Verification - 2026-05-12

## Verification Matrix

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false` | PASS | 1/1 test |
| `pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts --watch=false` | PASS | 2/2 tests |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts --watch=false` | PASS | 3/3 tests |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS | Clean |
| `pnpm --filter @metasheet/web build` | PASS | `vue-tsc -b` plus Vite build |
| `pnpm -F plugin-integration-core test` | PASS | Full plugin integration-core test chain |
| `git diff --check` | PASS | Clean |

## Coverage Added

- SQL adapter pill is hidden by default.
- SQL source system is hidden from the default source selector.
- Advanced toggle reveals the SQL adapter and SQL source system.
- Advanced hint mentions allowlist table/view reads and middle-table writes.
- K3 SQL source plus K3 WebAPI target shows the two-logical-connections recommendation.
- Same-system bidirectional selection shows `same system, different business object`.

## Not Covered

- Backend SQL allowlist enforcement. That remains in adapter/backend tests and future configuration UI.
- Live K3 SQL/WebAPI connectivity.

## Additional Fix

The production web build surfaced a pre-existing service type issue in `listIntegrationPipelineRuns()` and `listIntegrationDeadLetters()`: `IntegrationPipelineObservationQuery` was being cast directly to `Record<string, unknown>`. This slice replaced that cast with a typed `buildObservationQueryString()` helper. No runtime behavior changed.

## Warnings Observed

- Frontend Vitest emitted the existing `--localstorage-file was provided without a valid path` warning.
- One frontend Vitest run emitted the existing `WebSocket server error: Port is already in use` warning.
- Vite build emitted existing dynamic/static import and chunk-size warnings.
