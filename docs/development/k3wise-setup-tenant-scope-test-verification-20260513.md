# K3 WISE Setup Tenant-Scope Test Verification - 2026-05-13

## Scope

Verification for fixing the K3 setup page WebAPI test button tenant-scope
contract.

## Commands

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS | Installed dependencies inside isolated worktree `/tmp/ms2-k3wise-tenant-test-20260513`. |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationK3WiseSetupView.spec.ts tests/k3WiseSetup.spec.ts tests/integrationWorkbench.spec.ts --watch=false` | PASS | 3 files, 35 tests passed. |
| `pnpm --filter @metasheet/web build` | PASS | `vue-tsc -b` and Vite production build passed. Existing chunk-size warnings only. |

## Regression Coverage

The targeted K3 setup view test now proves the page calls:

```text
/api/integration/external-systems/k3_sys_1/test?tenantId=default
```

while preserving the adapter test body:

```json
{
  "tenantId": "default",
  "workspaceId": null,
  "skipHealth": true
}
```

This matches the backend route order: tenant scope is available before the
external system is loaded, and adapter-specific test options remain in the body.

## Bridge-Machine Finding Addressed

The bridge-machine comment on PR #1510 reported:

- direct API/workbench-style K3 WebAPI connection test passed with tenant scope
- K3 setup page button failed with `tenantId is required`

This patch aligns the K3 setup page button with the passing workbench-style
contract.

## Not Verified In This Slice

- No live bridge-machine retest was run from this development worktree.
- No real K3 Save-only write was attempted.
- No deployment to 142 was triggered in this slice.
