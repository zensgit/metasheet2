# Generic Integration Workbench Observation Verification - 2026-05-12

## Files Changed

- `apps/web/src/services/integration/workbench.ts`
- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/integrationWorkbench.spec.ts`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/generic-integration-workbench-observation-design-20260512.md`
- `docs/development/generic-integration-workbench-observation-verification-20260512.md`

## Verification Matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| Staging descriptor service | Calls `GET /api/integration/staging/descriptors` | `integrationWorkbench.spec.ts` |
| Run history service | Calls `GET /api/integration/runs` with tenant, pipeline id, and limit | `integrationWorkbench.spec.ts` |
| Dead-letter service | Calls `GET /api/integration/dead-letters` with `status=open` | `integrationWorkbench.spec.ts` |
| Staging selector bootstrap | Defaults to `standard_materials` when descriptor exists | `IntegrationWorkbenchView.spec.ts` |
| Pipeline save payload | Includes selected `stagingSheetId` | `IntegrationWorkbenchView.spec.ts` |
| Auto observation refresh | Dry-run refreshes recent runs and open dead letters | `IntegrationWorkbenchView.spec.ts` |
| Manual observation shape | Observation panel renders run counters and dead-letter errors | `IntegrationWorkbenchView.spec.ts` |
| Payload redaction boundary | Dead-letter full payload is not requested | Service URL has no `includePayload=true` |

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

Full frontend regression, frontend build, plugin tests, and diff checks are run in the final combined verification pass.
