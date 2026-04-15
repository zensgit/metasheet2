# DingTalk Directory Schedule Observability Frontend Development And Verification

## Scope

This round connects the directory admin page to the new backend schedule snapshot.

- Consume `GET /api/admin/directory/integrations/:integrationId/schedule`
- Render an auto-sync observation card in the directory integration detail page
- Refresh schedule observation when:
  - an integration is selected
  - a manual sync finishes
  - an admin explicitly clicks the refresh button
- Cover the new flow with frontend tests

## Files Changed

- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/directoryManagementView.spec.ts`

## Implementation Notes

### New UI block

The page now renders an `自动同步观测` section for the selected integration.

The card shows:

- whether auto-sync is enabled
- schedule observation status
- whether the cron expression is valid
- configured `scheduleCron`
- timezone
- next expected run
- latest observed trigger source
- latest automatic run
- latest manual run
- backend note text

### Observation state mapping

The frontend now maps backend statuses to operator-facing labels:

- `disabled` -> `未启用自动同步`
- `missing_cron` -> `缺少 Cron`
- `invalid_cron` -> `Cron 无效`
- `configured_no_runs` -> `已配置待观察`
- `manual_only` -> `仅观察到手动执行`
- `auto_observed` -> `已观察到自动执行`

It also maps them to chip colors:

- success: `auto_observed`
- warning: `disabled`, `configured_no_runs`, `manual_only`
- danger: invalid or missing cron

### Data flow

- `selectIntegration()` now loads:
  - runs
  - schedule snapshot
  - accounts
- `syncIntegration()` now refreshes:
  - integrations
  - runs
  - schedule snapshot
  - accounts

## Verification

### Passed

```bash
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- `directoryManagementView.spec.ts`: 8 tests passed
- `vue-tsc --noEmit`: passed

### Test coverage added/updated

- initial mount now requests `/schedule`
- schedule observation renders on the page
- manual sync refreshes `/schedule`
- missing-cron state renders operator-facing guidance
- invalid cron state renders operator-facing warning text

## Claude Code CLI

- Claude Code CLI is available in this environment
- It may be used as a read-only helper, but local implementation and local test results remain the source of truth for this round

## Next Step

The next useful step is to continue the same operator workflow and add:

- directory sync alerts panel
- alert acknowledgement actions
- a tighter relationship between schedule observation and sync warning triage
