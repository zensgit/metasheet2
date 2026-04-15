# DingTalk Directory Scheduler Development And Verification

## Scope

This change closes the backend loop for DingTalk directory auto-sync scheduling.

- Adds a runtime scheduler for active DingTalk directory integrations with `syncEnabled=true` and a non-empty `scheduleCron`
- Registers scheduler jobs during backend startup and tears them down during shutdown
- Propagates scheduled runs with `trigger_source = 'scheduler'`
- Exposes a schedule observation snapshot at `GET /api/admin/directory/integrations/:integrationId/schedule`
- Extends admin unbind to optionally disable the user's DingTalk login grant at the same time

## Files Changed

- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/src/directory/directory-sync-scheduler.ts`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/tests/unit/admin-directory-routes.test.ts`
- `packages/core-backend/tests/unit/directory-sync-scheduler.test.ts`

## Implementation Notes

### Runtime scheduler

- New module: `directory-sync-scheduler.ts`
- Job name format: `directory-sync:<integrationId>`
- Scheduling conditions:
  - provider is DingTalk
  - integration `status === 'active'`
  - `sync_enabled === true`
  - `schedule_cron` is non-empty
- Scheduler timezone is fixed to `UTC`
- Scheduled job handler calls:

```ts
syncDirectoryIntegration(integrationId, 'system:directory-sync-scheduler', 'scheduler')
```

### Startup / shutdown wiring

- `MetaSheetServer.start()` now initializes the directory sync scheduler in degraded mode
- `MetaSheetServer.stop()` now stops the directory sync scheduler as part of shutdown tasks
- Create/update integration routes refresh the schedule registration after persistence

### Schedule observation snapshot

`GET /api/admin/directory/integrations/:integrationId/schedule`

Returns:

- `syncEnabled`
- `scheduleCron`
- `cronValid`
- `nextExpectedRunAt`
- `latestRunAt`
- `latestRunTriggerSource`
- `latestManualRunAt`
- `latestAutoRunAt`
- `observationStatus`
- `note`

Observation statuses currently include:

- `disabled`
- `missing_cron`
- `invalid_cron`
- `configured_no_runs`
- `manual_only`
- `auto_observed`

### Admin unbind extension

`POST /api/admin/directory/accounts/:accountId/unbind`

Request body now supports:

```json
{
  "disableDingTalkGrant": true
}
```

When enabled, the route keeps the directory unbind behavior and also upserts the DingTalk auth grant to `enabled = false` for the previously linked local user.

## Verification

### Passed

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync-bind-account.test.ts \
  tests/unit/directory-sync-scheduler.test.ts
```

Result:

- 3 test files passed
- 19 tests passed

### TypeScript check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

- Still fails, but the failures are pre-existing and outside this change
- No remaining TypeScript error points to:
  - `directory-sync.ts`
  - `directory-sync-scheduler.ts`
  - `admin-directory.ts`
  - `index.ts`

Current unrelated failing areas include:

- `src/middleware/api-token-auth.ts`
- `src/multitable/api-token-service.ts`
- `src/multitable/automation-service.ts`
- `src/multitable/webhook-event-bridge.ts`
- `src/multitable/webhook-service.ts`
- `src/routes/api-tokens.ts`
- `src/routes/comments.ts`
- `src/routes/dashboard.ts`
- `src/routes/univer-meta.ts`

## Claude Code CLI Cross-check

- Claude Code CLI is available in this environment (`2.1.107`)
- A read-only follow-up prompt was attempted during this round, but the CLI returned a usage-limit message
- Local code changes and local test results remain the source of truth

## Current Limitations

- Scheduler is in-process and per-node; there is no leader election or distributed locking
- Cron parsing and next-run projection use `UTC`
- The new schedule snapshot route is backend-only for now; the current directory admin page has not yet been upgraded to consume it in this worktree
- Automatic scheduling depends on backend process uptime; missed runs are not backfilled yet

## Recommended Next Step

- Upgrade `apps/web/src/views/DirectoryManagementView.vue` to consume `/schedule` and render:
  - schedule health
  - next expected run
  - last manual vs last auto run
  - invalid/missing cron warnings
