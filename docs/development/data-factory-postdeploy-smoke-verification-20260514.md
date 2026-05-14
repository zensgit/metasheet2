# Data Factory Postdeploy Smoke Verification - 2026-05-14

## Scope

This verification covers the Data Factory frontend-route extension inside the
existing K3 WISE postdeploy smoke script.

The smoke script should now prove that a deployed instance serves both:

- `/integrations/k3-wise`
- `/integrations/workbench`

## Local Verification

### Smoke unit test

Command:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
```

Result:

- 16/16 tests passed.
- Public smoke now reports 4 pass checks when no auth token is supplied.
- Authenticated smoke still validates the existing route contract and staging
  descriptor contract.
- Evidence still avoids token leakage.

### Full integration regression

Commands:

```bash
pnpm -F plugin-integration-core test
pnpm verify:integration-k3wise:poc
pnpm verify:integration-erp-plm:deploy-readiness
```

Result:

- `pnpm -F plugin-integration-core test` passed.
- `pnpm verify:integration-k3wise:poc` passed.
- `pnpm verify:integration-erp-plm:deploy-readiness` returned exit code 1
  because the latest main `Plugin System Tests` workflow was still
  `in_progress` at verification time. Source gates in the command output were
  still green: `k3-setup-deploy-checklist-service`,
  `k3-setup-deploy-checklist-view`, `k3-offline-poc-chain`, and
  `k3-postdeploy-smoke` all reported PASS.

### Frontend regression

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/IntegrationK3WiseSetupView.spec.ts tests/platform-shell-nav.spec.ts --watch=false
```

Result:

- 3 files passed.
- 7 tests passed.
- Data Factory route and K3 WISE preset route continued to render in frontend
  tests.

### Frontend build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

- Build passed.
- Vite emitted the existing large-chunk warning; no build failure.

### Package verification

Commands:

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
scripts/ops/multitable-onprem-package-build.sh
scripts/ops/multitable-onprem-package-verify.sh <generated-package.zip>
```

Result:

- Package verifier passes.
- Packaged smoke script contains `data-factory-frontend-route`.
- The Windows on-prem package carries this development and verification note.
- Locally generated package verified successfully:
  `output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-20260513-202152.zip`.

### Diff hygiene

Command:

```bash
git diff --check
```

Result:

- Passed with exit code 0.

## Deployment Impact

- No database migration.
- No backend route change.
- No frontend route change.
- No K3 WebAPI or SQL Server behavior change.
- Existing postdeploy command gains one extra public frontend route check.
