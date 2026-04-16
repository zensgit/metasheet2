# Yjs Internal Rollout Cleanup Timer Development

Date: 2026-04-16

## Context

PR `#888` adds a 10-minute Yjs orphan-state cleanup loop during server startup. The initial implementation created the timer as a local `setInterval()` handle inside `MetaSheetServer.start()`.

That left one lifecycle gap:

- `MetaSheetServer.stop()` could not clear the Yjs cleanup interval
- embedded or in-process restart scenarios could leave the old cleanup loop alive
- a later restart could create duplicate cleanup loops

## Change

Updated [packages/core-backend/src/index.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/index.ts:149) so the Yjs cleanup interval is owned by `MetaSheetServer` and participates in graceful shutdown.

Implemented:

1. Added `private yjsCleanupTimer?: NodeJS.Timeout`
2. Stored the startup interval handle on `this.yjsCleanupTimer`
3. Cleared the timer during `stop()`
4. Reset the field to `undefined` after shutdown
5. Logged a dedicated warning path if timer cleanup throws

## Files Changed

- [packages/core-backend/src/index.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/index.ts:167)

## Scope

This is a narrow lifecycle fix only. No retention-policy logic, cleanup SQL, compaction semantics, or admin status payloads were changed.
