# Data Factory Cleansed Export Verification - 2026-05-14

## Scope

This verification covers the Data Factory cleansed-result export slice:

- dry-run preview can be exported as CSV
- Excel export remains available through the same UI selector
- generated export content includes cleaned and target payload columns
- generated export content does not leak source/query secrets from preview data
- the Data Factory page keeps data-service publishing as a later-stage
  placeholder

## Local Verification

### Frontend focused test

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Result:

- `IntegrationWorkbenchView` passed, 1/1 test.
- The test creates a dry-run preview containing:
  - a source `password` field with a raw value
  - a target request `access_token` query value
- The CSV export blob contains:
  - `cleaned.FNumber`
  - `payload.Data.FNumber`
  - `MAT-001`
- The CSV export blob does not contain:
  - the raw source password value
  - the raw query token value
- The CSV export blob contains `[redacted]`.

### Existing workbench regression

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/IntegrationK3WiseSetupView.spec.ts tests/platform-shell-nav.spec.ts --watch=false
```

Result:

- 3 files passed.
- 7/7 tests passed.
- Data Factory title and navigation still render.
- K3 WISE preset entry remains available.
- Staging `打开多维表` links still render after staging install.
- Dry-run and Save-only payloads remain unchanged.

### Build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

- Frontend build passed.
- Existing Vite large chunk / dynamic import warnings are unchanged and
  acceptable for this slice.

### Integration regression

Commands:

```bash
pnpm -F plugin-integration-core test
pnpm verify:integration-k3wise:poc
pnpm verify:integration-erp-plm:deploy-readiness
```

Result:

- `plugin-integration-core` passed.
- K3 offline PoC passed.
- Deploy readiness passed after the latest `main` workflows completed.
- Internal deployment status: `ready-for-physical-machine-test`.
- Main workflow gates passed: Build and Push Docker Images, Plugin System
  Tests, Phase 5 Production Flags Guard, and Deploy to Production.
- Customer live remains `blocked-until-customer-gate-and-test-account`, which is
  expected before customer GATE inputs.

### On-prem package verification

Commands:

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
scripts/ops/multitable-onprem-package-build.sh
scripts/ops/multitable-onprem-package-verify.sh <generated-package.zip>
```

Result:

- Shell syntax checks passed.
- Local package build produced
  `metasheet-multitable-onprem-v2.5.0-20260513-194024.zip`.
- Package verifier returned `Package verify OK`.
- Package verifier checks the `导出清洗结果` and `发布 API 数据服务暂不开放`
  UI copy.

## Deployment Impact

- No database migration.
- No backend route change.
- No external-system call change.
- No real K3 Submit / Audit enablement.
- Windows on-prem package contents change only by including the new Data
  Factory export docs and verifier checks.
