# Data Factory Workbench Verification - 2026-05-14

## Focused frontend tests

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/IntegrationWorkbenchView.spec.ts \
  tests/IntegrationK3WiseSetupView.spec.ts \
  tests/platform-shell-nav.spec.ts \
  --watch=false
```

Result:

```text
Test Files  3 passed (3)
Tests       7 passed (7)
```

Coverage from this suite:

- Data Factory title and four-step flow render.
- SQL connector remains hidden until advanced connectors are enabled.
- Source/target selectors continue to load objects and schemas.
- Dataset cards render source, staging multitable, and target summaries.
- Staging install calls `/api/integration/staging/install` with tenant,
  workspace, project, and optional base scope.
- Returned staging open links render `打开多维表`.
- Template preview still sends `{ bodyKey: 'Data' }` for K3 Material.
- Pipeline save still stores `autoSubmit: false` and `autoAudit: false`.
- Dry-run and Save-only run paths are unchanged.
- K3 WISE setup page links back with `进入数据工厂`.
- Platform shell nav shows `数据工厂`.

## Full build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
PASS - vue-tsc -b and vite build completed.
Note: Vite emitted existing large chunk / dynamic import warnings.
```

## Backend/plugin regression

Commands:

```bash
pnpm -F plugin-integration-core test
pnpm verify:integration-k3wise:poc
pnpm verify:integration-erp-plm:deploy-readiness
```

Results:

```text
PASS - plugin-integration-core test suite completed, including staging open-link installer assertions.
PASS - K3 WISE PoC mock chain verified end-to-end.
PASS - ERP/PLM deploy readiness reports ready-for-physical-machine-test.
```

Deploy readiness still reports customer live as blocked until customer GATE and
test-account details are available. That is expected and unchanged by this UI
slice.

## Static checks

Commands:

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
git diff --check
```

Results:

```text
PASS - shell syntax checks completed.
PASS - git diff --check returned clean.
```

## Package verification expectation

Commands:

```bash
pnpm --filter @metasheet/core-backend build
scripts/ops/multitable-onprem-package-build.sh
scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-20260513-190504.zip
```

Results:

```text
PASS - core-backend dist built.
PASS - local multitable on-prem package built.
PASS - package verifier returned Package verify OK.
```

The generated `output/releases/` directory was removed after verification so it
does not enter the branch diff.

The verifier now requires:

- Data Factory copy in the built web dist;
- `/integrations/workbench` and `/integrations/k3-wise` routes;
- `打开多维表` staging entry copy;
- K3 SQL channel guidance;
- this Data Factory TODO/development/verification doc set.

## Manual smoke checklist

1. Log in as a user with `integration:write`.
2. Open `/integrations/workbench`.
3. Confirm the nav label is `数据工厂`.
4. Confirm the four-step flow is visible.
5. Confirm SQL is hidden before enabling advanced connectors.
6. Select a source and target system.
7. Load source/target datasets and schema.
8. Create staging tables with a valid project ID.
9. Open `物料清洗` or `BOM 清洗` through `打开多维表`.
10. Configure mappings, preview payload, dry-run, then explicitly opt into
    Save-only if needed.
