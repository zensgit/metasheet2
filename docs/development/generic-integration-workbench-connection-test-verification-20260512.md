# Generic Integration Workbench Connection Test Verification - 2026-05-12

## Verification Matrix

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false` | PASS | 3/3 tests |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS | Clean |
| `git diff --check` | PASS | Clean |
| `pnpm -F plugin-integration-core test` | PASS | Full plugin integration-core test chain |
| `pnpm --filter @metasheet/web build` | PASS | Vite build complete |

## Coverage Added

- Service wrapper calls `POST /api/integration/external-systems/:id/test` with scoped query params and an empty JSON body.
- Source connection success updates the displayed source badge to `已连接`.
- Target connection failure updates the displayed target badge to `异常：...` using the sanitized backend message.
- Existing object discovery, schema discovery, mapping seed, and preview assertions still run in the same view test.

## Not Covered

- Live vendor connectivity. This is intentionally left to staging or customer environment verification because local tests use mocked `apiFetch`.
- Backend credential redaction. Existing plugin route tests already cover that route behavior.

## Warnings Observed

- Frontend Vitest emitted the existing `--localstorage-file was provided without a valid path` Node warning. Tests passed.
- Frontend build emitted existing Vite chunk-size and mixed dynamic/static import warnings. Build passed.
