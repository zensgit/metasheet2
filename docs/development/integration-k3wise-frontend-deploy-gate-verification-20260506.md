# K3 WISE Frontend Deploy Gate - Verification

Date: 2026-05-06
Branch: `codex/erp-plm-deploy-gate-frontend-readiness-20260506`

## Verification Plan

Run the focused frontend helper tests, then build the web app:

```bash
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Expected Coverage

- Existing K3 WISE WebAPI, SQL Server, staging, pipeline, dry-run, and observation payload tests remain green.
- The new deploy checklist marks fields that can be filled after deployment as `missing` rather than external blockers.
- PLM source creation is marked `external` when only a source system ID can be pasted.
- Internal dry-run readiness only becomes true after source, target, staging, and pipeline IDs exist.
- Live pipeline execution remains disabled until the operator explicitly enables it.

## Results

### Focused Helper Tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
```

Result: passed, 22/22 tests.

### Frontend Build

```bash
pnpm --filter @metasheet/web build
```

Result: passed.

Vite printed existing warnings for `WorkflowDesigner.vue` being both dynamically and statically imported, plus chunk-size warnings for large bundles. The command exited 0.

### Diff Check

```bash
git diff --check
```

Result: passed.

## Deployment Test Interpretation

If these checks pass, the frontend is ready for an internal physical-machine setup test:

1. Deploy the app.
2. Open `/integrations/k3-wise` with a user that has `integration:write`.
3. Fill K3 WISE WebAPI and optional SQL Server fields.
4. Save configuration and run connection tests.
5. Install staging multitables.
6. Paste or seed a PLM source system ID.
7. Create draft pipelines.
8. Run dry-run first.

Customer live PoC remains blocked until the customer GATE JSON/evidence inputs are available.
