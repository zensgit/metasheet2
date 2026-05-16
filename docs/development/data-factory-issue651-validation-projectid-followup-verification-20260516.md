# Data Factory Issue 651 Validation + Project ID Follow-up Verification

Date: 2026-05-16

## Local Verification

All commands were run from `/tmp/ms2-issue651-validation-projectid` on branch `codex/issue651-validation-projectid-20260516`.

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/IntegrationWorkbenchView.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false` | PASS: 3 files, 32 tests |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/field-validation-flow.test.ts tests/unit/record-service.test.ts` | PASS: 2 files, 32 tests |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS |
| `pnpm --filter @metasheet/core-backend build` | PASS |
| `pnpm --filter @metasheet/web build` | PASS |
| `git diff --check origin/main...HEAD` | PASS |

Notes:

- The frontend Vitest run printed `WebSocket server error: Port is already in use`, but all selected tests passed. This is a local Vitest server-port warning, not a test failure.
- The production web build printed existing chunk-size and mixed static/dynamic import warnings. Build exit code was 0.

## C1 Acceptance

Regression coverage:

- `field-validation-flow.test.ts` now verifies `POST /api/multitable/records` returns:
  - HTTP `422`;
  - `ok: false`;
  - `error.code: VALIDATION_ERROR`;
  - `error.fieldErrors.fld_code: Material Code is required`.
- `multitable-client.spec.ts` verifies the web client surfaces the first field error as the thrown message for create-record failures.
- A second client test verifies the legacy top-level array field-error shape is normalized into a field-error map.

Expected on-prem behavior:

- From the true `/multitable` entry, clicking `+ New Record` on a staging table with required fields should show the first required-field message, such as `Material Code is required`.
- The backend should no longer return `500 Failed to create meta record` for direct required-field validation failures.

## C3 Acceptance

Regression coverage:

- `IntegrationWorkbenchView.spec.ts` verifies:
  - blank Project ID shows the effective `default:integration-core` status;
  - entering `project_default` through input/change/blur shows the integration-scope warning;
  - the normalize button changes the value to `project_default:integration-core`;
  - clearing the field returns to the default scoped status.
- `IntegrationK3WiseSetupView.spec.ts` verifies the same warning and normalize flow on the K3 setup page.

Expected on-prem behavior:

- Data Factory Workbench and K3 setup page both show a visible Project ID scope status.
- Plain `project_default` shows a warning and a one-click normalize button.
- Blank remains valid and resolves to `tenant:integration-core`.

## Package Retest Guidance

After this PR is merged and a new on-prem package is generated, rerun the Issue #651 gate sequence:

1. Gate A: package verify confirms the new web bundle and backend route are included.
2. Gate B: deployment SOP migration/auth round-trip.
3. C1: open a real `/multitable` staging link and click `+ New Record`; expect required-field toast instead of `500`.
4. C3: enter `project_default` in Project ID; expect warning + normalize button.

