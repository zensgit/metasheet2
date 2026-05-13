# K3 WISE Workbench Deploy Readiness Verification - 2026-05-13

## Scope

Verification for the latest deployable multitable on-prem package containing the
K3 WISE setup page and generic integration workbench.

## Official Package Build

```bash
gh workflow run multitable-onprem-package-build.yml \
  --repo zensgit/metasheet2 \
  --ref main \
  -f package_tag=k3wise-workbench-78ecad7 \
  -f publish_release=false
```

Result:

- Run: `25782457823`
- URL: `https://github.com/zensgit/metasheet2/actions/runs/25782457823`
- Head SHA: `78ecad71dae02d5936691e1f2d3819f584dd2121`
- Status: `success`
- Artifact: `multitable-onprem-package-25782457823-1`

## Downloaded Artifacts

```bash
gh run download 25782457823 \
  --repo zensgit/metasheet2 \
  -n multitable-onprem-package-25782457823-1 \
  -D output/playwright/ga/25782457823
```

Downloaded files:

- `SHA256SUMS`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.json`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.tgz`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.tgz.sha256`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.zip`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.zip.sha256`

## Verification Results

| Command | Result | Notes |
| --- | --- | --- |
| `shasum -a 256 -c SHA256SUMS` | PASS | `.tgz` and `.zip` checksums match. |
| `scripts/ops/multitable-onprem-package-verify.sh output/playwright/ga/25782457823/metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.zip` | PASS | Windows package verifier passed. |
| `scripts/ops/multitable-onprem-package-verify.sh output/playwright/ga/25782457823/metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.tgz` | PASS | Linux package verifier passed. |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs scripts/ops/integration-k3wise-postdeploy-summary.test.mjs` | PASS | 28/28 postdeploy smoke and workflow tests passed. |
| `PACKAGE_JSON=output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.json DELIVERY_OUTPUT_ROOT=output/delivery/multitable-onprem/k3wise-workbench-78ecad7 node scripts/ops/multitable-onprem-delivery-bundle.mjs` | PASS | Customer delivery bundle generated. |

## Package Content Assertions

The package contains:

- `scripts/ops/multitable-onprem-apply-package.ps1`
- `scripts/ops/integration-k3wise-onprem-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-evidence.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`
- `plugins/plugin-integration-core/`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs`
- `apps/web/dist/assets/IntegrationWorkbenchView-*.js`
- `apps/web/dist/assets/IntegrationK3WiseSetupView-*.js`

Packaged docs confirm:

- `/integrations/workbench`
- `/integrations/k3-wise`
- `dictMap`
- Save-only default
- SQL Server as an advanced channel

## Delivery Bundle

Generated bundle root:

```text
output/delivery/multitable-onprem/k3wise-workbench-78ecad7/metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7/
```

Bundle includes:

- `.zip` and `.tgz` packages
- `.sha256` files and `SHA256SUMS`
- `DELIVERY.md`
- `DELIVERY.json`
- verification reports
- K3 WISE runbooks
- Windows on-prem quick-start docs
- preflight/healthcheck env templates

## Deployment Answer

Yes, this build can be deployed for entity-machine testing.

Use the Windows `.zip` package when the customer wants MetaSheet on a Windows
Server near K3 WISE. After deploy:

1. Run the on-prem preflight.
2. Login and confirm `/integrations/workbench` and `/integrations/k3-wise`.
3. Run postdeploy smoke.
4. Use mock K3 PoC until customer GATE answers are available.
5. Run real K3 Save-only PoC only after GATE credentials and field mapping are
   confirmed.

## Notes

- No customer K3 endpoint was contacted during this verification.
- No secrets were used or written into tracked docs.
- GitHub artifact retention is 14 days unless the package is separately
  published as a GitHub Release.
