# K3 WISE Generic Workbench Link Verification - 2026-05-12

## Files Changed

- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/IntegrationK3WiseSetupView.spec.ts`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/integration-k3wise-generic-workbench-link-design-20260512.md`
- `docs/development/integration-k3wise-generic-workbench-link-verification-20260512.md`

## Verification Matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| K3 page bridge | Header contains `打开通用工作台` | `IntegrationK3WiseSetupView.spec.ts` |
| Route target | Link points to `/integrations/workbench` | `IntegrationK3WiseSetupView.spec.ts` |
| Existing first-run copy | K3 setup guidance remains visible | `IntegrationK3WiseSetupView.spec.ts` |
| Existing WebAPI test flow | Saved WebAPI test still sends tenant scope | `IntegrationK3WiseSetupView.spec.ts` |
| Scope | No backend or migration changes | Diff limited to frontend/docs/TODO for this slice |

## Commands

Executed in `/Users/chouhua/Downloads/Github/metasheet2`:

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationK3WiseSetupView.spec.ts --watch=false
```

## Result

PASS.

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationK3WiseSetupView.spec.ts --watch=false` | PASS - 1 file, 2 tests |
| `pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false` | PASS - 2 files, 3 tests |
| `pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false` | PASS - 2 files, 30 tests |
| `pnpm --filter @metasheet/web build` | PASS - existing chunk-size/import warnings only |
| `git diff --check` | PASS - no whitespace errors or conflict markers |
