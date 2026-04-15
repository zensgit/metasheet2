# DingTalk Directory Observability Frontend 2026-04-14

## Scope

This round closes the admin directory page observability surface on the frontend only.

## Changes

- `apps/web/src/views/DirectoryManagementView.vue`
  - Added the automatic sync observability card.
  - Loads `/api/admin/directory/integrations/:integrationId/schedule` alongside the existing integration, run, and account data.
  - Renders cron state, next expected run, last run timestamps, trigger source, and observation status.
  - Added the recent alerts panel.
  - Loads `/api/admin/directory/integrations/:integrationId/alerts` and supports filtering and acknowledging alerts through `/api/admin/directory/alerts/:alertId/ack`.
- `apps/web/tests/directoryManagementView.spec.ts`
  - Updated the mount and sync flows to include the new schedule and alerts requests.
  - Added coverage for the observability card rendering.
  - Added coverage for acknowledging a pending alert and refreshing the alert list.

## Verification

- `pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts`
  - Passed: 8 tests.
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
  - Passed.

## Notes

- This change is intentionally scoped to the frontend files listed in the task.
- The backend endpoints are consumed as already available by the current workspace.
