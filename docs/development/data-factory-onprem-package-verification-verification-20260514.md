# Data Factory on-prem package verification - verification - 2026-05-14

## Scope

This verification covers the official on-prem package artifact generated after
the Data Factory multitable source/target and postdeploy smoke closeout reached
`main`.

Validated behavior:

- GitHub package workflow completed successfully on `main@c120ae3fa`.
- Windows zip artifact was downloaded locally.
- package verifier passed on the downloaded zip.
- verifier confirmed checksum, required content, and no GitHub links in
  delivery docs.
- spot-check confirmed Data Factory postdeploy smoke and summary closeout files
  are physically present in the zip.

## GitHub Workflow

Command:

```bash
gh workflow run multitable-onprem-package-build.yml \
  --repo zensgit/metasheet2 \
  --ref main \
  -f package_tag=data-factory-c120ae3f \
  -f publish_release=false
```

Result:

```text
run:        25859650271
conclusion: success
headSha:    c120ae3fa4fe0ddfa118901da9cd77b987e57da6
job:        build-package success
```

Workflow steps completed successfully:

- checkout
- dependency install
- web/backend build
- on-prem package build
- package verify for tgz and zip
- artifact upload

## Downloaded Artifact

Command:

```bash
gh run download 25859650271 \
  --repo zensgit/metasheet2 \
  -n multitable-onprem-package-25859650271-1 \
  -D output/playwright/ga/25859650271
```

Downloaded files:

```text
SHA256SUMS
metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.json
metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.tgz
metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.tgz.sha256
metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.zip
metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.zip.sha256
```

Package metadata:

```text
name:    metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f
version: 2.5.0
tag:     data-factory-c120ae3f
plugins: plugin-attendance, plugin-integration-core
```

## Local Zip Verify

Command:

```bash
VERIFY_REPORT_JSON=output/playwright/ga/25859650271/verify-local/metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.zip.verify.json \
VERIFY_REPORT_MD=output/playwright/ga/25859650271/verify-local/metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.zip.verify.md \
scripts/ops/multitable-onprem-package-verify.sh \
  output/playwright/ga/25859650271/metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.zip
```

Result:

```text
metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.zip: OK
Package verify OK
```

Report summary:

```text
ok: true
archiveType: zip
checksum: PASS
required-content: PASS (59 paths)
no-github-links: PASS
```

## Data Factory Package Spot Check

Command:

```bash
unzip -l output/playwright/ga/25859650271/metasheet-multitable-onprem-v2.5.0-data-factory-c120ae3f.zip \
  | rg "data-factory-postdeploy-summary-adapter-details|data-factory-adapter-discovery-postdeploy|integration-k3wise-postdeploy-(smoke|summary)\\.mjs|plugin-integration-core/lib/http-routes\\.cjs|apps/web/dist/index.html"
```

Observed required entries:

```text
scripts/ops/integration-k3wise-postdeploy-summary.mjs
scripts/ops/integration-k3wise-postdeploy-smoke.mjs
docs/development/data-factory-postdeploy-summary-adapter-details-verification-20260514.md
docs/development/data-factory-adapter-discovery-postdeploy-development-20260514.md
docs/development/data-factory-adapter-discovery-postdeploy-verification-20260514.md
docs/development/data-factory-postdeploy-summary-adapter-details-development-20260514.md
plugins/plugin-integration-core/lib/http-routes.cjs
apps/web/dist/index.html
```

## Follow-Up Host Test

This verification proves the artifact is internally complete. The next
deployment host still needs the normal live checks:

1. apply the zip package on the target Windows/on-prem bridge host;
2. run the migration/startup path;
3. run the existing K3/Data Factory postdeploy smoke;
4. confirm `data-factory-frontend-route`, `data-factory-adapter-discovery`, and
   authenticated integration route checks pass on the host.

No host credentials, tokens, or environment values were captured in this
verification.
