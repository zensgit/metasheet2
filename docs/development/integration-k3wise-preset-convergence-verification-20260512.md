# K3 WISE Preset Convergence Verification - 2026-05-12

## Scope

Verification for the M8 K3 WISE page convergence slice:

- Tenant/workspace are advanced context fields.
- Blank tenant resolves to `default`.
- Base URL and endpoint-path `/K3API` duplication warning.
- SQL channel remains advanced.
- WebAPI connected status and Material/BOM template previews remain covered.

## Results

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false` | PASS | 2 files / 31 tests passed. Vitest emitted the existing `--localstorage-file` warning. |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts --watch=false` | PASS | 2 files / 3 tests passed. Vitest emitted the existing `--localstorage-file` warning. |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS | Frontend type check passed. |
| `pnpm --filter @metasheet/web build` | PASS | Frontend production build passed. Existing Vite dynamic-import and chunk-size warnings remained. |
| `pnpm -F plugin-integration-core test` | PASS | Backend integration-core regression passed. |
| `pnpm verify:integration-k3wise:poc` | PASS | 20 preflight tests, 37 evidence tests, and the mock PoC chain passed. |
| `git diff --check` | PASS | No whitespace errors. |

## Contract Assertions

- Blank tenant no longer creates `tenantId is required` validation failures.
- Blank tenant payload builders send `tenantId: "default"`.
- Workspace remains optional and advanced.
- Base URL `/K3API` plus endpoint `/K3API/...` produces a visible warning.
- WebAPI successful connection test still displays `connected`.
- SQL Server channel remains folded under an advanced details section.
- Material and BOM template preview tests remain green.

## Notes

- This is a frontend/service-helper convergence slice. It does not change backend routes or K3 adapter runtime behavior.
- The K3 setup page remains a quick-start preset; generic cross-system mapping work remains in `/integrations/workbench`.
