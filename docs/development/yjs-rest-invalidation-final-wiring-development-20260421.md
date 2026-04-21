# Yjs REST Invalidation Final Wiring Fix

- Branch: `codex/wire-yjs-text-cell-20260420`
- PR: `#960`
- Date: 2026-04-21
- Fix commits after rebase: `ed32fce30`, `41a6826d6`
- Scope: final REST -> Yjs consistency close-out before merge.

## Context

PR #960 already added the main REST -> Yjs invalidation seam:

- `YjsPersistenceAdapter.purgeRecords(recordIds)` wipes persisted Yjs state.
- `YjsSyncService.invalidateDocs(recordIds)` evicts live docs without snapshotting.
- `YjsRecordBridge.cancelPending(recordIds)` cancels delayed bridge flushes before purge.
- `RecordPatchInput.source = 'yjs-bridge'` prevents bridge-originated writes from invalidating their own live doc.

The final review found two remaining consistency risks.

## Finding 1: REST `/patch` route missed the invalidator

`PATCH /records/:recordId` had a direct-SQL invalidator call, and the bridge-local
`RecordWriteService` created in `index.ts` had `setYjsInvalidator(...)`.

However, the REST `/patch` route creates a request-local `RecordWriteService`:

```ts
const recordWriteService = new RecordWriteService(pool, eventBus, writeHelpers)
```

That service instance did not receive the module-level `yjsInvalidator`. Result:
multi-record REST patch writes could still commit `meta_records.data` while
leaving stale Yjs snapshots in `meta_record_yjs_states` /
`meta_record_yjs_updates`.

### Fix

The route now injects the module-level invalidator into the request-local service:

```ts
const recordWriteService = new RecordWriteService(pool, eventBus, writeHelpers, yjsInvalidator)
```

The module-level comment was widened from "direct-SQL PATCH only" to all REST
write handlers that must purge stale Yjs state after committing
`meta_records.data`.

## Finding 2: invalidation ran after notifications

`RecordWriteService.patchRecords()` previously emitted realtime and eventBus
notifications before purging Yjs state. That created a narrow but real race:

1. REST write commits the DB row.
2. Realtime/eventBus notifies clients/listeners.
3. A client reacts immediately and opens/reconnects Yjs.
4. The server can still load the old persisted Yjs snapshot before purge.

### Fix

The service now runs Yjs invalidation after DB commit and computed/summary work,
but before realtime broadcast and eventBus emission:

```text
DB commit
computed/related/summary rebuild
Yjs invalidation
realtime broadcast
eventBus emit
```

The invalidator remains best effort. If it throws, the REST write still succeeds
and the error is logged. This preserves write availability while reducing the
normal successful path race.

## Review Thread Close-Out: Frontend Opt-In Boundaries

After the backend consistency fixes, the PR still had non-blocking Copilot
review threads around frontend opt-in boundaries. Three low-risk tightenings
were landed:

### Direct Vite env access

`isYjsCollabEnabled()` now reads the Vite flag through direct property access:

```ts
import.meta.env.VITE_ENABLE_YJS_COLLAB === 'true'
```

The prior implementation used dynamic indexing:

```ts
metaEnv?.[YJS_COLLAB_ENV_FLAG]
```

Direct access preserves Vite's normal compile-time replacement behavior. The
`process.env` fallback remains only for Vitest's `vi.stubEnv` path.

### Non-text editors avoid Yjs binding construction

`MetaCellEditor` now constructs `useYjsCellBinding()` only when the editor is
eligible at setup time:

- field type is `string`
- value is not date-like
- `recordId` is present

Other editors receive a tiny inert binding object. This keeps number/date/select
/link/attachment editors on the REST path without creating Yjs document watchers
or socket-related state when the flag is enabled.

### Lazy Yjs runtime import

The opt-in path now also physically lazy-loads the Yjs runtime modules:

```ts
const [{ useYjsDocument }, { useYjsTextField }] = await Promise.all([
  import('./useYjsDocument'),
  import('./useYjsTextField'),
])
```

This keeps `useYjsCellBinding()` inert in default flag-off production builds
before creating a `Y.Doc`, Socket.IO connection, document watcher, or Yjs runtime
chunk. Production flag-off builds return through a compile-time early branch:

```ts
const viteYjsCollabEnabled = import.meta.env.VITE_ENABLE_YJS_COLLAB === 'true'
const allowProcessEnvFlagFallback = import.meta.env.MODE === 'test'

if (!viteYjsCollabEnabled && !allowProcessEnvFlagFallback) {
  return inertBinding
}
```

Vitest still uses the `process.env` fallback so `vi.stubEnv()` can exercise both
enabled and disabled paths without changing the production bundle contract.

Because dynamic imports can resolve after Vue setup has completed,
`useYjsDocument()` and `useYjsTextField()` now support
`registerUnmount: false` plus an explicit `dispose()` method. `useYjsCellBinding`
owns those disposers and calls them from `release()` / component unmount.

## Files Changed

- `packages/core-backend/src/routes/univer-meta.ts`
  - Injects `yjsInvalidator` into the REST `/patch` route's
    request-local `RecordWriteService`.
- `packages/core-backend/src/multitable/record-write-service.ts`
  - Moves invalidation before realtime/eventBus notification.
- `packages/core-backend/tests/unit/yjs-rest-invalidation.test.ts`
  - Adds a route-source guard that locks the `/patch` constructor injection.
- `packages/core-backend/tests/unit/record-write-service.test.ts`
  - Adds an invocation-order test proving invalidation happens before
    realtime and eventBus notification.
- `apps/web/src/multitable/composables/useYjsCellBinding.ts`
  - Switches to direct `import.meta.env.VITE_ENABLE_YJS_COLLAB` access.
  - Lazy-loads `useYjsDocument` / `useYjsTextField` only when the flag is
    enabled.
  - Adds a compile-time flag-off early return so default production builds do
    not emit the Yjs runtime chunks.
- `apps/web/src/multitable/composables/useYjsDocument.ts`
  - Adds `registerUnmount: false` and explicit `dispose()` for lazy callers.
- `apps/web/src/multitable/composables/useYjsTextField.ts`
  - Adds `registerUnmount: false` and explicit `dispose()` for lazy callers.
- `apps/web/src/multitable/components/cells/MetaCellEditor.vue`
  - Avoids constructing a Yjs binding for non-text editors.
- `apps/web/tests/multitable-yjs-cell-editor.spec.ts`
  - Adds eligibility tests proving non-string editors do not instantiate the
    Yjs binding while normal string editors still do.
- `apps/web/tests/multitable-yjs-cell-binding.spec.ts`
  - Waits for lazy runtime imports in enabled-path tests and keeps disabled-path
    tests locked to zero Socket.IO construction.

## Remaining Limitations

- Active WebSocket editors still need reconnect after REST invalidation. This is
  already documented as a follow-up `yjs:invalidated` server event.
- Record DELETE is still handled by orphan cleanup rather than immediate Yjs
  purge. That remains acceptable for the current text-cell opt-in scope.
- Invalidation failures are log-and-swallow. This is intentional for REST write
  availability, but rollout monitoring should watch for these logs.

## Merge Position

After these fixes, the REST write paths that mutate `meta_records.data` are
covered:

- REST `/patch` route via injected `RecordWriteService` invalidator.
- Direct-SQL `PATCH /records/:recordId` via `setYjsInvalidatorForRoutes(...)`.
- Yjs bridge writes skip invalidation via `source = 'yjs-bridge'`.

No additional blocking code gaps were found in this review.
