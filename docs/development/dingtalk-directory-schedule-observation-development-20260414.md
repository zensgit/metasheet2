# DingTalk Directory Schedule Observation Development

## Scope

This follow-up extends the DingTalk directory review workflow with schedule observation, so operators can distinguish:

- automatic sync is enabled vs disabled
- a cron expression exists vs is invalid
- only manual runs have been observed vs automatic runs have actually been observed

## Backend

Updated [packages/core-backend/src/directory/directory-sync.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts:1):

- added `DirectorySyncObservationStatus`
- added `DirectorySyncScheduleSnapshot`
- added `getDirectorySyncScheduleSnapshot()`
- reused `SimpleCronExpression` to compute the next expected run time
- derived observation states:
  - `disabled`
  - `missing_cron`
  - `invalid_cron`
  - `configured_no_runs`
  - `manual_only`
  - `auto_observed`

Updated [packages/core-backend/src/routes/admin-directory.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-directory.ts:1):

- added `GET /api/admin/directory/integrations/:integrationId/schedule`

Updated tests:

- [packages/core-backend/tests/unit/admin-directory-routes.test.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-directory-routes.test.ts:1)

## Frontend

Updated [apps/web/src/views/DirectoryManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue:1):

- added `自动同步观测` panel
- added independent `loadScheduleSnapshot()` fetch flow
- changed default alert filter from `all` to `pending`
- surfaced:
  - current cron
  - cron validity
  - next expected run
  - latest run trigger source
  - latest manual run
  - latest auto run
  - observation note and status chip

Updated tests:

- [apps/web/tests/directoryManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts:1)

## Notes

- This is a follow-up on top of `feat(dingtalk): add directory review workflow`.
- The change is intentionally limited to directory admin observation; it does not alter the actual scheduler registration flow.
- `Claude Code CLI` was checked again for this iteration and is still unauthenticated in the current shell, so implementation remained local.
