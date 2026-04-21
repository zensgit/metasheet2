# Yjs REST Invalidation Live Client Event

- Branch: `codex/yjs-invalidation-event-20260421`
- Date: 2026-04-21
- Base: `origin/main` after PR `#960`
- Scope: close the live-editor gap left by REST -> Yjs invalidation.

## Context

PR `#960` made REST writes authoritative over Yjs state by cancelling pending
bridge flushes, evicting in-memory Y.Docs, and purging persisted snapshots /
updates. That closed the next-open stale snapshot bug.

The remaining limitation was live clients: an editor already connected to the
old Y.Doc could keep showing an active collaboration state until it manually
reconnected or hit another error.

## Change

The backend websocket adapter now exposes:

```ts
notifyInvalidated(recordIds: string[]): void
```

It emits this room-scoped payload to each affected record:

```ts
{
  recordId,
  reason: 'rest-write',
}
```

Startup wiring now calls the notification in a `finally` block after the
destructive invalidation attempt:

```text
cancel pending bridge flushes
attempt to invalidate in-memory + persisted Yjs doc
emit yjs:invalidated to yjs:<recordId>
```

Ordering matters. In the successful path, emitting after purge avoids a client
reconnecting while stale Yjs state still exists. If persistence purge fails, the
event is still emitted because `invalidateDocs()` may already have destroyed the
in-memory server doc; the existing best-effort invalidator error still bubbles to
the caller's log-and-continue path.

The frontend `useYjsDocument` listens for `yjs:invalidated` for the current
record, sets an explicit error, and disconnects:

```ts
error.value = 'INVALIDATED: document invalidated by REST write'
disconnect()
```

`useYjsCellBinding` already watches document connectivity and falls back to the
REST path when the Yjs document disconnects, so no extra grid-level code was
needed.

## Files Changed

- `packages/core-backend/src/collab/yjs-websocket-adapter.ts`
  - Adds `YjsInvalidatedPayload`.
  - Adds `notifyInvalidated(recordIds)` to broadcast `yjs:invalidated` to
    subscribed sockets in each record room.
- `packages/core-backend/src/index.ts`
  - Calls `yjsWsAdapter.notifyInvalidated(recordIds)` after
    `yjsSyncService.invalidateDocs(recordIds)`.
- `apps/web/src/multitable/composables/useYjsDocument.ts`
  - Handles validated `yjs:invalidated` payloads for the current record by
    setting error and disconnecting the document.
  - Ignores malformed / non-object invalidation payloads defensively so a
    protocol mismatch cannot throw inside the socket event handler.
- `packages/core-backend/tests/unit/yjs-awareness.test.ts`
  - Covers room-scoped invalidation broadcast.
- `apps/web/tests/yjs-document-invalidation.spec.ts`
  - Covers frontend disconnect on current-record invalidation and ignore for
    other records.

## Behavior

- REST write still succeeds even if invalidation is best-effort elsewhere.
- Subscribed live Yjs clients are told their document was invalidated and should
  stop using the old in-memory doc.
- Non-subscribed sockets do not receive the event.
- Events for another record are ignored client-side.
- Malformed invalidation payloads are ignored client-side.

## Remaining Limits

- The event is process-local Socket.IO room broadcast. A future multi-instance
  Redis adapter rollout must ensure cross-node room delivery before enabling
  Yjs in a horizontally scaled topology.
- Clients disconnect/fallback rather than auto-reconnect. That is intentional
  for this hardening step: reconnect should be an explicit user/editor action so
  the UI does not silently race with a REST overwrite.
