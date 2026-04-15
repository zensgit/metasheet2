# DingTalk Directory Observability And Alerts - 2026-04-14

## Scope

This round closes the DingTalk directory observability path end-to-end:

- backend scheduler-aware directory sync snapshot
- backend alert list and alert acknowledgement routes
- backend route wiring for schedule refresh on integration create/update
- frontend directory page cards for schedule observability and recent alerts
- targeted tests and type checks

## Backend Changes

### Directory Sync Service

Updated [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:1):

- added `DirectorySyncAlertSummary`, `DirectorySyncScheduleSnapshot`, and related types
- added `listDirectorySyncAlerts(...)`
- added `acknowledgeDirectorySyncAlert(...)`
- added `getDirectorySyncScheduleSnapshot(...)`
- extended `syncDirectoryIntegration(...)` to accept `triggerSource`, so scheduler-triggered sync runs persist `trigger_source = 'scheduler'`
- extended `unbindDirectoryAccount(...)` to accept `disableDingTalkGrant`

### Admin Routes

Updated [packages/core-backend/src/routes/admin-directory.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-directory.ts:1):

- create/update integration now refresh scheduler state
- added `GET /api/admin/directory/integrations/:integrationId/schedule`
- added `GET /api/admin/directory/integrations/:integrationId/alerts`
- added `POST /api/admin/directory/alerts/:alertId/ack`
- admin unbind now accepts `disableDingTalkGrant`

### Runtime Wiring

Updated [packages/core-backend/src/index.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/index.ts:1):

- start directory sync scheduler during backend startup
- stop directory sync scheduler during shutdown

Scheduler implementation is in [packages/core-backend/src/directory/directory-sync-scheduler.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync-scheduler.ts:1).

## Frontend Changes

Updated [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1):

- added `自动同步观测` card
- loads `/api/admin/directory/integrations/:integrationId/schedule`
- shows cron, next expected run, last run, last manual run, last automatic run, trigger source, and observation state
- added `最近告警` panel
- loads `/api/admin/directory/integrations/:integrationId/alerts`
- supports `全部 / 待确认 / 已确认` local filtering
- supports alert acknowledgement through `/api/admin/directory/alerts/:alertId/ack`
- refreshing integration selection and manual sync now also refresh schedule snapshot and alerts

## Tests

Updated:

- [packages/core-backend/tests/unit/admin-directory-routes.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-directory-routes.test.ts:1)
- [packages/core-backend/tests/unit/directory-sync-scheduler.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync-scheduler.test.ts:1)
- [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:1)

Covered behaviors:

- scheduler refresh on integration create/update
- schedule snapshot route
- alert list route
- alert acknowledgement route
- scheduler-triggered sync handler
- frontend initial load for runs + schedule + alerts + accounts
- frontend manual sync refresh chain
- frontend alert acknowledgement refresh

## Verification

Passed:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-scheduler.test.ts
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

`core-backend` type check still fails, but the remaining errors are pre-existing and outside this DingTalk change set:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Current unrelated failures include:

- `src/db/types.ts`
- `src/middleware/api-token-auth.ts`
- `src/multitable/api-token-service.ts`
- `src/multitable/automation-log-service.ts`
- `src/multitable/automation-service.ts`
- `src/multitable/dashboard-service.ts`
- `src/multitable/webhook-service.ts`
- `src/routes/comments.ts`
- `src/routes/dashboard.ts`
- `src/routes/univer-meta.ts`

## Notes

- Claude Code CLI is available in this environment; verified with `claude --version` returning `2.1.107 (Claude Code)`.
- Local tests and local type checks remain the source of truth for this round.
