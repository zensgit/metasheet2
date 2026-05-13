# Generic Integration Workbench Docs Closeout Verification - 2026-05-13

## Scope

Verification for the M9 documentation and delivery closeout:

- Windows on-prem runbook updated.
- K3 WISE runbook updated.
- Delivery checklist updated.
- Package verify/delivery scripts updated for K3 runbook and smoke artifact inclusion.
- K3 offline PoC run.

## Results

| Command | Result | Notes |
| --- | --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh scripts/ops/multitable-onprem-package-build.sh` | PASS | Shell syntax check passed for edited package verifier and adjacent build script. |
| `node --check scripts/ops/multitable-onprem-delivery-bundle.mjs` | PASS | Delivery bundle script parse check passed. |
| `pnpm verify:integration-k3wise:poc` | PASS | K3 offline PoC preflight/evidence tests and mock WebAPI/SQL chain passed. |
| `pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false` | PASS | 2 files / 31 tests passed. Vitest emitted the existing `--localstorage-file` warning. |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts --watch=false` | PASS | 2 files / 3 tests passed. Vitest emitted the existing `--localstorage-file` warning. |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS | Frontend type check passed. |
| `pnpm -F plugin-integration-core test` | PASS | Integration-core plugin regression passed. |
| `git diff --check` | PASS | No whitespace errors. |

## Contract Assertions

- Windows on-prem runbook documents both `/integrations/k3-wise` and `/integrations/workbench`.
- K3 WISE runbook documents quick-start preset vs generic workbench responsibilities.
- Delivery checklist includes the three K3 operator runbooks.
- Package verifier requires the internal-trial runbook and postdeploy smoke/summary scripts.
- Delivery bundle copies the K3 operator runbooks into customer-facing docs.
- K3 offline PoC remains green without customer credentials.

## K3 Offline PoC Details

`pnpm verify:integration-k3wise:poc` completed:

- `integration-k3wise-live-poc-preflight.test.mjs`: 20/20 pass.
- `integration-k3wise-live-poc-evidence.test.mjs`: 37/37 pass.
- `run-mock-poc-demo.mjs`: PASS, including WebAPI testConnection, SQL channel testConnection, Material Save-only upsert, BOM Save-only upsert, SQL readonly probe, SQL core-table write rejection, and evidence compiler PASS.

## Notes

- No customer K3 endpoint was contacted.
- No secrets were written into tracked docs.
