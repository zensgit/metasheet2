# Yjs Ops Visibility Development

Date: 2026-04-16
Branch: `codex/yjs-ops-visibility-20260416`

## Scope

Add a minimal operational visibility surface for internal Yjs rollout.

This step intentionally stays backend-only:

- no editor UI wiring
- no extra CRDT behavior
- no rollout policy changes

## What changed

### Admin route

Added [GET /api/admin/yjs/status](/tmp/metasheet2-yjs-ops/packages/core-backend/src/routes/admin-routes.ts:1362):

- protected by `requireAdminRole()`
- returns a compact runtime snapshot for Yjs
- includes:
  - `enabled`
  - `initialized`
  - `sync`
  - `bridge`
  - `socket`

### Server wiring

Updated [packages/core-backend/src/index.ts](/tmp/metasheet2-yjs-ops/packages/core-backend/src/index.ts:145) to retain references to:

- `YjsSyncService`
- `YjsRecordBridge`
- `YjsWebSocketAdapter`

Those references are now exposed to admin routes via `getYjsStatus()`, so operators can inspect:

- active Yjs docs
- tracked doc ids
- pending bridge writes
- bridge flush success/failure counts
- active Yjs presence record/socket counts

### Tests

Added [packages/core-backend/tests/unit/admin-yjs-status-routes.test.ts](/tmp/metasheet2-yjs-ops/packages/core-backend/tests/unit/admin-yjs-status-routes.test.ts:1):

- verifies injected runtime snapshot path
- verifies feature-flag-only fallback when Yjs is not initialized

## Why

After:

- Yjs POC merge
- hardening
- awareness follow-up
- persistence compaction

the next useful internal-rollout step is being able to answer:

1. Is Yjs enabled?
2. Is it initialized in this process?
3. How many docs and sockets are active?
4. Is bridge flushing succeeding or failing?

This route provides that minimum runtime introspection without committing to a full admin UI yet.
