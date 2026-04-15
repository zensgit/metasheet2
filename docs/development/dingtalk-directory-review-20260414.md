# DingTalk Directory Review Queue

## Summary

This iteration extends the DingTalk admin surface from single-account directory operations to a review-driven workflow.

Delivered:

- A review queue for directory drift items in `DirectoryManagementView`
- Review item filtering for:
  - `needs_binding`
  - `inactive_linked`
  - `missing_identity`
- Direct binding inside the review queue
- Batch binding for queued directory members with explicit local-user targets
- Batch deprovision handling for linked directory members
- Restored `disableDingTalkGrant` behavior when unbinding a directory account
- Recent directory alert visibility in the admin UI
- Alert acknowledgement workflow for processed sync failures and warnings
- Auto-sync schedule snapshot in the admin UI
- Explicit distinction between configured cron and observed automatic execution

## Backend

Updated route surface in `packages/core-backend/src/routes/admin-directory.ts`:

- `GET /api/admin/directory/integrations/:integrationId/review-items`
  - Returns review items, queue counts, pagination metadata, and the active queue filter
- `GET /api/admin/directory/integrations/:integrationId/alerts`
  - Accepts:
    - `ack: 'all' | 'pending' | 'acknowledged'`
  - Returns recent alerts, overall counts, pagination metadata, and the active acknowledgement filter
- `GET /api/admin/directory/integrations/:integrationId/schedule`
  - Returns a schedule snapshot with:
    - `syncEnabled`
    - `scheduleCron`
    - `cronValid`
    - `nextExpectedRunAt`
    - `latestRun*`
    - `latestManualRun*`
    - `latestAutoRun*`
    - `observationStatus`
    - `note`
- `POST /api/admin/directory/alerts/:alertId/ack`
  - Marks a directory sync alert as acknowledged
  - Writes an audit record for the acknowledgement action
- `POST /api/admin/directory/accounts/batch-bind`
  - Accepts:
    - `bindings: Array<{ accountId: string; localUserRef: string; enableDingTalkGrant: boolean }>`
  - De-duplicates by `accountId`
  - Binds each selected directory account to the requested local user
  - Optionally enables DingTalk login per selected item
  - Writes one audit record per account
- `POST /api/admin/directory/accounts/batch-unbind`
  - Accepts:
    - `accountIds: string[]`
    - `disableDingTalkGrant: boolean`
  - Unbinds each selected account
  - Optionally disables the DingTalk auth grant for the previously linked local user
  - Writes one audit record per account

Updated service logic in `packages/core-backend/src/directory/directory-sync.ts`:

- Added review item classification and queue listing
- Added directory alert listing with pending/acknowledged counts
- Added directory alert acknowledgement mutation
- Added directory sync schedule snapshot generation
- Added server-side cron parsing for “next expected run” using the existing scheduler cron parser
- Restored `disableDingTalkGrant` support in `unbindDirectoryAccount`

Review reasons currently implemented:

- `needs_binding`
- `inactive_linked`
- `missing_identity`

## Frontend

Updated `apps/web/src/views/DirectoryManagementView.vue`:

- Added a dedicated review queue section
- Added queue filters with server-backed counts
- Added selection state for review items
- Added a recent alerts panel
- Added an auto-sync observation card
- Added alert filters:
  - `pending`
  - `acknowledged`
  - `all`
- Added per-alert acknowledgement action
- Added explicit labels for:
  - disabled
  - missing cron
  - invalid cron
  - configured but never observed
  - manual only
  - auto observed
- Added inline review-queue binding controls:
  - local user draft
  - search candidate users
  - per-item DingTalk grant toggle
  - quick bind
- Added batch action:
  - `批量绑定用户`
  - `批量停权处理`
- Added `disableDingTalkGrant` toggle for batch deprovision
- Added a helper action to locate a queued directory member in the main account list

Current admin workflow:

1. Open `DirectoryManagementView`
2. Check the auto-sync observation card:
   - whether auto sync is enabled
   - whether `scheduleCron` is valid
   - when the next run is expected by config
   - whether any non-manual trigger has actually been observed
3. Review recent alerts and acknowledge handled sync failures/warnings
4. Filter the review queue
5. For `needs_binding` items, either:
   - bind directly inside the queue, or
   - select multiple queue items and run batch bind
6. For linked inactive members, run batch deprovision
7. Jump any exceptional items into the main account list when deeper manual review is needed

## Tests

Updated backend tests:

- `packages/core-backend/tests/unit/admin-directory-routes.test.ts`
- `packages/core-backend/tests/unit/directory-sync-bind-account.test.ts`

Updated frontend tests:

- `apps/web/tests/directoryManagementView.spec.ts`

Added coverage for:

- Schedule snapshot route
- Alert listing route
- Alert acknowledgement route
- Review queue listing
- Batch bind route
- Batch unbind route
- `disableDingTalkGrant` on unbind
- Auto-sync observation rendering in the UI
- Alert filter and acknowledgement flow in the UI
- Directory review queue filtering in the UI
- Review queue batch bind flow in the UI
- Batch deprovision flow in the UI

## Verification

Executed successfully:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Repository-wide backend type check still fails on pre-existing issues outside this change:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Current unrelated failures are in:

- `src/middleware/api-token-auth.ts`
- `src/multitable/automation-service.ts`
- `src/routes/comments.ts`
- `src/routes/univer-meta.ts`

## Notes

- Claude Code CLI is available in this environment and was used as a narrow read-only helper to review reusable queue-binding helpers; primary implementation remained local because the non-interactive CLI is less predictable than direct edits plus tests here.
- Claude Code CLI was also used to re-check the scheduler wiring question; the current codebase confirms `scheduleCron` is persisted but directory sync is not yet registered into runtime scheduling.
- Parallel execution was split across a local backend change and a frontend worker focused only on `DirectoryManagementView`.
- Queue items without a prepared `localUserRef` still require either candidate search inside the queue or fallback to the main account table.
- The new auto-sync card is intentionally phrased as a configuration/observation view, not proof that scheduled execution is already wired. If `observationStatus` stays `manual_only` or `configured_no_runs`, the system has not yet shown automatic execution in recorded runs.
