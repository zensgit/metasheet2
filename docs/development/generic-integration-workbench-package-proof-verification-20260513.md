# Generic Integration Workbench Package Proof Verification - 2026-05-13

## Scope

Verification for the package-level generic integration workbench and K3 WISE delivery guard.

## Local Package Built

```bash
PACKAGE_TAG=workbench-package-proof-20260513 \
INSTALL_DEPS=0 \
BUILD_WEB=0 \
BUILD_BACKEND=0 \
scripts/ops/multitable-onprem-package-build.sh
```

Result:

- `output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-workbench-package-proof-20260513.tgz`
- `output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-workbench-package-proof-20260513.zip`
- `output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-workbench-package-proof-20260513.json`
- `output/releases/multitable-onprem/SHA256SUMS`

## Results

| Command | Result | Notes |
| --- | --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS | Shell syntax check passed. |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-workbench-package-proof-20260513.tgz` | PASS | Verifier passed with the new frontend route and workbench contract checks. |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-workbench-package-proof-20260513.zip` | PASS | Windows zip verifier passed with the new frontend route and workbench contract checks. |
| `PACKAGE_JSON=output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-workbench-package-proof-20260513.json DELIVERY_OUTPUT_ROOT=output/delivery/multitable-onprem/workbench-package-proof-20260513 node scripts/ops/multitable-onprem-delivery-bundle.mjs` | PASS | Customer delivery bundle was generated from the package metadata. |
| `find output/delivery/multitable-onprem/workbench-package-proof-20260513/metasheet-multitable-onprem-v2.5.0-workbench-package-proof-20260513/docs -maxdepth 1 -type f \| sort \| rg 'k3\|integration-k3wise\|multitable-windows\|onprem-customer'` | PASS | Confirmed the delivery bundle contains the K3 internal-trial, live-gate, preflight, Windows easy-start, and customer checklist docs. |
| `git diff --check` | PASS | No whitespace errors in tracked changes. |

## Contract Assertions

- Packaged `apps/web/dist` contains `/integrations/workbench`.
- Packaged `apps/web/dist` contains `/integrations/k3-wise`.
- Packaged `apps/web/dist` contains `dictMap`.
- Packaged `apps/web/dist` contains `Save-only`.
- Packaged Windows on-prem guide documents both integration routes.
- Packaged K3 internal-trial runbook documents SQL Server as an advanced channel.
- Delivery bundle includes K3 operator docs:
  - `docs/k3-poc-onprem-preflight-runbook.md`
  - `docs/integration-k3wise-internal-trial-runbook.md`
  - `docs/integration-k3wise-live-gate-execution-package.md`

## Generated Artifact Paths

- Package proof release root: `output/releases/multitable-onprem/`
- Verify reports: `output/releases/multitable-onprem/verify/`
- Delivery bundle: `output/delivery/multitable-onprem/workbench-package-proof-20260513/metasheet-multitable-onprem-v2.5.0-workbench-package-proof-20260513/`

These output artifacts are generated evidence and are not intended to be committed.

## Notes

- No customer K3 endpoint was contacted.
- No secrets were used or written into tracked docs.
