# K3 WISE Setup Tenant-Scope Test Development - 2026-05-13

## Scope

Bridge-machine validation proved that the saved K3 WISE WebAPI target can connect
when the backend receives an explicit tenant scope, but the K3 setup page's
"Test WebAPI" button still surfaced `tenantId is required`.

This slice fixes that UI/API contract mismatch.

## Root Cause

The backend route `POST /api/integration/external-systems/:id/test` loads the
external system before it passes the request body to the adapter. During that
load step, tenant scope is resolved from:

- explicit route input
- query string
- route params
- authenticated user context

The K3 setup page sent `tenantId` only in the POST body. That body was still
useful for adapter options such as `skipHealth`, but it was too late for the
route's external-system lookup. The generic integration workbench already sends
tenant scope in the query string, which is why the bridge-machine direct
workbench-style test passed.

## Change

Updated `apps/web/src/services/integration/k3WiseSetup.ts`:

- Added a small scope-query builder for `tenantId` and `workspaceId`.
- Updated `testIntegrationSystem()` to append the scope query to the test URL.
- Kept the original request body unchanged so `skipHealth`, `tenantId`,
  `workspaceId`, and future adapter test options still reach the adapter.

Updated `apps/web/tests/IntegrationK3WiseSetupView.spec.ts`:

- The K3 setup page WebAPI test now expects:
  `POST /api/integration/external-systems/k3_sys_1/test?tenantId=default`
- The request body still includes `{ tenantId: "default", workspaceId: null,
  skipHealth: true }`.

## Deployment Impact

Frontend-only behavior change. No migration, backend, plugin, or K3 adapter
changes.

After deployment, the setup page should follow the same tenant-scope contract as
the generic integration workbench. A saved K3 WebAPI target under tenant
`default` should no longer fail the setup-page test button with
`tenantId is required`.

## Non-Goals

- No real K3 write.
- No Submit/Audit change.
- No new pipeline creation.
- No change to the generic integration workbench.
- No change to bridge-machine secret handling.
