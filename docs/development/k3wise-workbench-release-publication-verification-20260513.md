# K3 WISE Workbench Release Publication Verification - 2026-05-13

## Scope

Verification for publishing the deployable K3 WISE + generic integration
workbench on-prem package as a durable GitHub prerelease.

## Package Build

```bash
gh workflow run multitable-onprem-package-build.yml \
  --repo zensgit/metasheet2 \
  --ref main \
  -f package_tag=k3wise-workbench-20548fe \
  -f publish_release=false
```

Result:

- Run: `25783182629`
- URL: `https://github.com/zensgit/metasheet2/actions/runs/25783182629`
- Head SHA: `20548fe6980a28cad8d6472312aea38a7caf99d6`
- Status: `success`
- Artifact: `multitable-onprem-package-25783182629-1`

## Local Pre-Publish Verification

| Command | Result | Notes |
| --- | --- | --- |
| `shasum -a 256 -c SHA256SUMS` | PASS | `.tgz` and `.zip` checksums match. |
| `scripts/ops/multitable-onprem-package-verify.sh output/playwright/ga/25783182629/metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.zip` | PASS | Windows package verifier passed. |
| `scripts/ops/multitable-onprem-package-verify.sh output/playwright/ga/25783182629/metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.tgz` | PASS | Linux package verifier passed. |
| `PACKAGE_JSON=output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.json DELIVERY_OUTPUT_ROOT=output/delivery/multitable-onprem/k3wise-workbench-20548fe node scripts/ops/multitable-onprem-delivery-bundle.mjs` | PASS | Customer delivery bundle generated. |

Package content spot-check confirmed:

- `scripts/ops/multitable-onprem-apply-package.ps1`
- `scripts/ops/integration-k3wise-onprem-preflight.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `plugins/plugin-integration-core/plugin.json`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs`
- `apps/web/dist/assets/IntegrationWorkbenchView-*.js`
- `apps/web/dist/assets/IntegrationK3WiseSetupView-*.js`

## Published Release

Release:

```text
https://github.com/zensgit/metasheet2/releases/tag/multitable-onprem-k3wise-workbench-20260513-20548fe
```

Release metadata:

- `isDraft=false`
- `isPrerelease=true`
- `targetCommitish=20548fe6980a28cad8d6472312aea38a7caf99d6`
- assets uploaded: 10

## Release Download Verification

The release was downloaded back into:

```text
/tmp/metasheet2-k3wise-workbench-release-20548fe/
```

Post-download checks:

| Command | Result | Notes |
| --- | --- | --- |
| `shasum -a 256 -c SHA256SUMS` | PASS | Release-downloaded `.tgz` and `.zip` match published checksums. |
| `scripts/ops/multitable-onprem-package-verify.sh /tmp/metasheet2-k3wise-workbench-release-20548fe/metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.zip` | PASS | Release-downloaded Windows package verifier passed. |
| `scripts/ops/multitable-onprem-package-verify.sh /tmp/metasheet2-k3wise-workbench-release-20548fe/metasheet-multitable-onprem-v2.5.0-k3wise-workbench-20548fe.tgz` | PASS | Release-downloaded Linux package verifier passed. |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs scripts/ops/integration-k3wise-postdeploy-summary.test.mjs` | PASS | 28/28 postdeploy smoke and workflow tests passed. |

## Deployment Answer

Yes, the release package can be used for Windows Server entity-machine
deployment testing.

The release gives field operators a stable download location, unlike the
short-lived GitHub Actions artifact. Use the `.zip` package for Windows Server.

## Notes

- No customer K3 endpoint was contacted.
- No secrets were used or written into tracked docs.
- The release is intentionally a prerelease, not a latest-stable promotion.
