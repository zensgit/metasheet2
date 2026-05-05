# Multitable Record Subscription Notifications Development

Date: 2026-05-05
Branch: `codex/multitable-record-subscriptions-20260505`
Base: `origin/main@390a95ff1`

## Scope

Phase 6 closes the P1 gap for record-level watch/notification behavior:

- users can watch/unwatch a record from the record drawer;
- backend persists record subscriptions separately from comment mentions;
- record updates and comment creation enqueue durable notifications for watchers;
- the actor is excluded from watcher notifications by default.

Out of scope:

- global notification center UI;
- push/WebSocket delivery for watcher notifications;
- notification read/mark-read APIs;
- email/DingTalk delivery.

## Backend Design

Added `meta_record_subscriptions` for the watch relationship:

- unique `(sheet_id, record_id, user_id)`;
- idempotent subscribe via upsert;
- unsubscribe via delete;
- list/status APIs are record-scoped and read-gated.

Added `meta_record_subscription_notifications` for durable watcher events:

- event types: `record.updated`, `comment.created`;
- stores `actor_id`, optional `revision_id`, optional `comment_id`;
- current-user notification list supports optional `sheetId`/`recordId` filters.

The service layer lives in `packages/core-backend/src/multitable/record-subscription-service.ts`.

## Write Path Wiring

Record update notifications are written from the authoritative mutation paths:

- `RecordService.patchRecord()` for single-record REST patch;
- `RecordWriteService.patchRecords()` for batch REST/Yjs-authoritative patch;
- `CommentService.createComment()` for record/field comment creation.

`recordRecordRevision()` now returns the inserted revision id so watcher notifications can point at the exact revision that triggered the event. Existing callers that do not need the id continue to ignore the returned value.

The actor suppression rule is centralized in `notifyRecordSubscribers(...)`: when `actorId` is present, the subscriber lookup filters out that user.

## API Design

Added record-scoped APIs under `/api/multitable`:

- `GET /sheets/:sheetId/records/:recordId/subscriptions`
- `PUT /sheets/:sheetId/records/:recordId/subscriptions/me`
- `DELETE /sheets/:sheetId/records/:recordId/subscriptions/me`
- `GET /record-subscription-notifications`

Record-scoped APIs reuse the same read gate as record history:

- record must exist in the requested sheet;
- requester must be authenticated;
- requester must have sheet read;
- record-level read restrictions are honored when record permission assignments exist.

## Frontend Design

`MultitableApiClient` now exposes:

- `getRecordSubscriptionStatus(sheetId, recordId)`;
- `subscribeRecord(sheetId, recordId)`;
- `unsubscribeRecord(sheetId, recordId)`;
- `listRecordSubscriptionNotifications(...)`.

`MetaRecordDrawer` now loads watch state when opened or when the selected record changes. The header shows `Watch` or `Watching`, and toggles through the new API methods. A stale-request guard prevents late responses for a prior record from overwriting the active record's watch state.

## Deferred

- OpenAPI route documentation is deferred to the next contract sweep because the runtime API is behind focused backend/frontend tests in this slice.
- Notification center consumption and read-state management are deferred; this slice only creates durable notification rows and drawer watch controls.
