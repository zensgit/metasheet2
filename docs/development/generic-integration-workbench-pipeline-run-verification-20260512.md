# Generic Integration Workbench Pipeline Run Verification - 2026-05-12

## Files Changed

- `apps/web/src/services/integration/workbench.ts`
- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/integrationWorkbench.spec.ts`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/generic-integration-workbench-pipeline-run-design-20260512.md`
- `docs/development/generic-integration-workbench-pipeline-run-verification-20260512.md`
- `docs/development/generic-integration-workbench-frontend-shell-design-20260512.md`
- `docs/development/generic-integration-workbench-frontend-shell-verification-20260512.md`

## Verification Matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| Pipeline service upsert | Calls `POST /api/integration/pipelines` | `integrationWorkbench.spec.ts` |
| Pipeline service dry-run | Calls `POST /api/integration/pipelines/:id/dry-run` with tenant/mode/sampleLimit | `integrationWorkbench.spec.ts` |
| Pipeline service Save-only run | Calls `POST /api/integration/pipelines/:id/run` | `integrationWorkbench.spec.ts` |
| View saves pipeline | Sends selected source/target objects, field mappings, idempotency fields, and active status | `IntegrationWorkbenchView.spec.ts` |
| Save-only default | Pipeline options force `autoSubmit=false` and `autoAudit=false` | `IntegrationWorkbenchView.spec.ts` |
| Template traceability | K3 template metadata is copied into `options.k3Template` | `IntegrationWorkbenchView.spec.ts` |
| Dry-run button | Uses saved pipeline ID and sample limit | `IntegrationWorkbenchView.spec.ts` |
| Save-only guard | Live run button requires explicit checkbox before execution | `IntegrationWorkbenchView.spec.ts` |
| Result panel | Shows submitted action and backend result JSON | `IntegrationWorkbenchView.spec.ts` |

## Commands

Executed in `/Users/chouhua/Downloads/Github/metasheet2`:

```bash
pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false
```

## Result

PASS.

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false` | PASS - 2 files, 3 tests |

Full K3 setup regression, frontend build, and diff checks are run in the final verification pass for the combined workbench slice.
