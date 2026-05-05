# Multitable Record Subscription CI Unblock Development

Date: 2026-05-05
Branch: `codex/multitable-record-subscriptions-fix-20260505`
Target PR: #1290

## Context

PR #1290 added record-level watch subscriptions and durable watcher
notifications. GitHub CI blocked on `test (18.x)` because existing
`PATCH /records/:recordId` integration coverage began returning 500.

The failure exposed a real production risk: watcher notification enqueue was
awaited inside the authoritative record update transaction. A secondary
notification failure could therefore fail or roll back an otherwise valid
record update.

Parallel review also found a privacy issue: the record subscription status
endpoint returned every watcher subscription for a readable record, including
other users' `userId` values. The drawer only needs the current user's watch
state.

## Changes

### Post-Commit Notification Best Effort

`record-subscription-service.ts` now exposes:

- `NotifyRecordSubscribersInput`
- `notifyRecordSubscribersBestEffort(...)`

The strict `notifyRecordSubscribers(...)` function remains available for tests
and callers that want failures surfaced. The new best-effort wrapper logs and
returns `null` instead of throwing.

`RecordService.patchRecord()` now:

1. writes the record patch and revision inside the transaction;
2. stores the watcher notification intent;
3. commits the transaction;
4. enqueues watcher notifications best-effort through the normal pool query.

`RecordWriteService.patchRecords()` now follows the same pattern for batch
patches: notification intents are collected during the transaction and flushed
after commit.

This keeps the authoritative record write path independent from the secondary
watcher-notification side effect.

### Subscription Status Privacy

`GET /api/multitable/sheets/:sheetId/records/:recordId/subscriptions` now
returns only:

```json
{
  "subscribed": true,
  "subscription": {
    "id": "...",
    "sheetId": "...",
    "recordId": "...",
    "userId": "current-user"
  }
}
```

It no longer returns `items` containing all watchers. The current frontend
normalizer already treats `items` as optional, so no frontend behavior change is
required for the drawer's Watch/Watching control.

### Test Coverage

Added a route-level privacy regression:

- `packages/core-backend/tests/integration/multitable-record-subscriptions.api.test.ts`

The test verifies that a readable record returns only the current user's status
and does not execute the all-watchers listing query.

Added best-effort unit coverage:

- `packages/core-backend/tests/unit/record-subscription-service.test.ts`

The test verifies that watcher notification enqueue failures resolve to `null`
and log instead of throwing.

## Deferred

- OpenAPI source/dist contract entries remain deferred to the next contract
  sweep, as already documented in PR #1290.
- Notification center UI and read/mark-read APIs remain out of scope for this
  slice.
