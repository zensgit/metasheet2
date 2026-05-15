# Integration Staging Install Project Scope Verification - 2026-05-15

## Local Verification

### Plugin integration-core targeted tests

Command:

```bash
node plugins/plugin-integration-core/__tests__/staging-installer.test.cjs
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
```

Result:

```text
staging-installer: all 9 assertions passed
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
```

Coverage added:

- total descriptor failure rejects with `STAGING_INSTALL_EMPTY`;
- unscoped route payload `project_1` is normalized to
  `tenant_1:integration-core`;
- missing project ID is accepted and normalized to
  `tenant_1:integration-core`;
- already-scoped `tenant_1:plugin-integration-core` is preserved.

### Full plugin package tests

Command:

```bash
pnpm -F plugin-integration-core test
```

Result:

```text
plugin-runtime-smoke passed
host-loader-smoke passed
credential-store passed
db.cjs passed
external-systems passed
adapter-contracts passed
http-adapter passed
metasheet-staging-source-adapter passed
metasheet-multitable-target-adapter passed
plm-yuantus-wrapper passed
pipelines passed
transform-validator passed
runner-support passed
payload-redaction passed
pipeline-runner passed
http-routes passed
http-routes-plm-k3wise-poc passed
k3-wise-adapters passed
erp-feedback passed
e2e-plm-k3wise-writeback passed
staging-installer passed
migration-sql passed
```

### Frontend targeted tests

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/IntegrationWorkbenchView.spec.ts \
  tests/IntegrationK3WiseSetupView.spec.ts \
  tests/k3WiseSetup.spec.ts \
  --watch=false
```

Result:

```text
Test Files  3 passed
Tests       48 passed
```

Coverage added or updated:

- Data Factory no longer tells operators Project ID is mandatory.
- K3 WISE setup helper allows staging install without project ID.
- Existing K3 WISE setup view staging-open-link behavior still passes.

### Frontend build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
vue-tsc -b passed
vite build passed
```

The build emitted the existing large chunk warnings, but exited with code 0.

### K3 WISE offline PoC chain

Command:

```bash
pnpm verify:integration-k3wise:poc
```

Result:

```text
K3 WISE PoC mock chain verified end-to-end (PASS)
```

This covers the live PoC preflight tests, evidence compiler tests, fixture
contract tests, mock K3 WebAPI, mock SQL executor, and mock Save-only chain.

### Deploy-readiness script

Command:

```bash
pnpm verify:integration-erp-plm:deploy-readiness
```

Result:

```text
ERP/PLM deploy readiness: FAIL
Build and Push Docker Images: workflow run not found for selected head SHA
Plugin System Tests: workflow run not found for selected head SHA
Deploy to Production: workflow is in_progress
Customer live: blocked-until-customer-gate-and-test-account
```

Interpretation: this is expected for a local branch before GitHub workflow runs
exist for the new head SHA. Source gates in that script passed, including
`k3-setup-deploy-checklist-service`, `k3-setup-deploy-checklist-view`,
`k3-offline-poc-chain`, and `k3-postdeploy-smoke`.

### Whitespace check

Command:

```bash
git diff --check
```

Result:

```text
exit 0
```

## Entity Machine Verification Plan

This local session could not complete a direct 142 rerun because SSH key
authentication was unavailable from this host session. The post-deploy
verification should be:

```bash
node scripts/ops/integration-issue1542-seed-workbench-systems.mjs \
  --base-url http://127.0.0.1:8081 \
  --token-file /tmp/<fresh-admin-token>.jwt \
  --tenant-id default \
  --install-staging \
  --out-dir artifacts/integration-k3wise/internal-trial/issue1542-staging-install
```

Expected result after deployment:

- `decision=PASS`;
- `staging.sheetIds.standard_materials` is present;
- `staging.targets` includes `standard_materials`;
- the emitted staging source system uses project ID `default:integration-core`
  when no explicit project ID is provided;
- secret-leak checks remain zero.

## Regression Notes

- This does not loosen host plugin-scope checks.
- This does not allow arbitrary plugin project IDs.
- Partial provisioning failures still return warnings so an operator can use
  successfully-created sheets.
- Total provisioning failure is no longer reported as a successful install.
