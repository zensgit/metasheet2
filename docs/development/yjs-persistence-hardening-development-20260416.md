# Yjs Persistence Hardening Development

Date: 2026-04-16
Branch: `codex/yjs-persistence-hardening-20260416`

## Scope

Implement the next post-POC infrastructure step for Yjs storage:

- snapshot compaction
- incremental update cleanup
- explicit crash-recovery verification for updates-only persistence

This step intentionally does not touch:

- editor UI wiring
- awareness rendering
- multi-instance/Redis rollout
- non-text CRDT types

## Backend changes

Updated [packages/core-backend/src/collab/yjs-persistence-adapter.ts](/tmp/metasheet2-yjs-persistence/packages/core-backend/src/collab/yjs-persistence-adapter.ts:1):

- kept `storeUpdate()` for normal incremental persistence
- kept `storeSnapshot()` for raw snapshot writing
- added `compactDoc(recordId, doc)`:
  - encode full doc state
  - upsert the snapshot in `meta_record_yjs_states`
  - delete stale rows from `meta_record_yjs_updates`
  - do both in one DB transaction

Updated [packages/core-backend/src/collab/yjs-sync-service.ts](/tmp/metasheet2-yjs-persistence/packages/core-backend/src/collab/yjs-sync-service.ts:1):

- added `persistSnapshot()` internal helper
- `releaseDoc()`, `cleanupIdleDocs()`, and `destroy()` now prefer `compactDoc()` when available
- fallback to `storeSnapshot()` remains in place for compatibility with older mocks and narrow callers

## Test coverage

Added [packages/core-backend/tests/unit/yjs-persistence-hardening.test.ts](/tmp/metasheet2-yjs-persistence/packages/core-backend/tests/unit/yjs-persistence-hardening.test.ts:1) to verify:

- `YjsSyncService` prefers compaction on release
- idle cleanup compacts before eviction
- `compactDoc()` clears update rows inside the same transaction as snapshot upsert
- `loadDoc()` can still recover correctly from updates-only persistence when no snapshot exists

## Notes

- This is the persistence-side follow-up to the merged Yjs POC and hardening work.
- The intended effect is to keep restart recovery intact while preventing unbounded growth of `meta_record_yjs_updates` for docs that are eventually released or cleaned up.
