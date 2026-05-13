# Generic Integration Workbench Contract Closeout Verification - 2026-05-12

## Scope

Verification for:

- Unknown external system discovery contract.
- K3 WISE BOM template preview contract.
- Regression coverage for the existing integration-core HTTP route suite.
- Frontend workbench regression after backend-only test additions.

## Results

| Command | Result | Notes |
| --- | --- | --- |
| `node plugins/plugin-integration-core/__tests__/http-routes.test.cjs` | PASS | Direct route contract suite passed. |
| `pnpm -F plugin-integration-core test` | PASS | Plugin package suite passed, including `http-routes`, PLM/K3 WISE mock chain, K3 WISE adapters, staging installer, and migration SQL checks. |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts --watch=false` | PASS | 2 files / 3 tests passed. Vitest emitted the existing `--localstorage-file` warning. |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS | Frontend type check passed. |
| `pnpm --filter @metasheet/web build` | PASS | Frontend production build passed. Existing Vite dynamic-import and chunk-size warnings remained. |
| `git diff --check` | PASS | No whitespace errors. |

## Contract Assertions

- Unknown system object discovery returns `404` with `ExternalSystemNotFoundError`.
- Unknown system schema discovery returns `404` with `ExternalSystemNotFoundError`.
- Unknown system lookups keep tenant/workspace scoping.
- Unknown system lookups do not instantiate adapters.
- K3 BOM preview returns `valid: true`.
- K3 BOM preview wraps payload under `Data`.
- K3 BOM preview transforms parent/child codes and numeric fields.
- K3 BOM preview redacts source secret fields.
- K3 BOM preview does not call integration services.

## Notes

- This slice adds tests only for backend contracts and documentation. It does not change runtime route handlers.
- The frontend gates were run because this branch already contains the generic workbench UI work; the new backend tests did not introduce frontend regressions.
