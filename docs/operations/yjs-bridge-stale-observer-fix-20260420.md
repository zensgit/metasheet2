# Yjs Bridge — Stale Observer Fix (Development & Fix Report)

Date: 2026-04-20
Branch: `codex/yjs-bridge-stale-observer-fix-20260420`
Priority: P1 (blocks every second-and-later subscription to a record)

## 1. How the bug surfaced

During the 2026-04-20 internal rollout trial (see
`docs/operations/yjs-node-client-validation-20260420.md`):

- **Run 1 (cold doc)**: Node.js Yjs client edited a Y.Text field → backend
  bridge flushed once → `meta_records` reflected the edit ✅
- **Run 2 (warm doc, immediately after Run 1)**: same client code, same
  record. Y.Doc was still in-memory on server. Client inserted a new value.
  Bridge `flushSuccessCount` went 1 → 2, but `meta_records` was unchanged ❌

Today's rerun (after the doc idled out and was recreated) made the pattern
worse: flush count didn't even increment. Edits were silently dropped.

## 2. Root cause

`packages/core-backend/src/collab/yjs-record-bridge.ts` — the `observe()`
method used to early-return if it had seen the `recordId` before:

```ts
observe(recordId: string, doc: Y.Doc): void {
  if (this.observedDocs.has(recordId)) return  // ← stale-observer bug
  // ... register observeDeep on doc.getMap('fields') ...
}
```

The `YjsSyncService` destroys idle Y.Doc instances every 60s. When the next
client subscribes, `getOrCreateDoc(recordId)` allocates a **fresh Y.Doc**.
The WebSocket adapter dutifully calls `bridge.observe(recordId, newDoc)` —
but the bridge sees the cached `recordId` key, returns early, and never
registers `observeDeep` on the new Y.Doc.

Result: edits on the recreated doc had no observer → `scheduleFlush` never
ran → bridge never called `RecordWriteService.patchRecords()` → DB untouched.

The `flushSuccessCount: 1 → 2` in Run 2 came from the previous, still-alive
observer finally flushing pending writes from earlier activity; the new
edit never made it into the flush.

## 3. Fix

Change the observer tracking to key by `{ doc, cleanup }` instead of just
the cleanup closure, and treat a different Y.Doc instance as a signal to
tear down the stale observer and re-register on the new one.

```ts
private observedDocs = new Map<string, { doc: Y.Doc; cleanup: () => void }>()

observe(recordId: string, doc: Y.Doc): void {
  const existing = this.observedDocs.get(recordId)
  if (existing && existing.doc === doc) return  // idempotent for same doc
  if (existing) {
    try { existing.cleanup() } catch { /* stale doc already destroyed */ }
    this.observedDocs.delete(recordId)
  }
  // ... register observeDeep on the NEW doc.getMap('fields') ...
  this.observedDocs.set(recordId, { doc, cleanup: () => fields.unobserveDeep(handler) })
}
```

Behavior:
- Same Y.Doc handed in twice → no-op (idempotent)
- Different Y.Doc for same recordId → tear down stale, re-register fresh
- Y.Doc destroyed then recreated by syncService → next subscribe re-observes correctly

## 4. Regression tests

Added in `packages/core-backend/tests/unit/yjs-poc.test.ts`:

### Test 1 — re-register on Y.Doc change

Simulates idle release + resubscribe:
1. observe(rec1, doc1) → edit doc1 → assert 1 flush
2. doc1.destroy() (no unobserve call — matches sync-service behavior)
3. observe(rec1, doc2) (fresh Y.Doc for same record)
4. edit doc2 → **assert 2nd flush** (before fix: 0 flushes here)

### Test 2 — idempotent on same Y.Doc

Calls `observe(rec1, doc)` three times with the same instance, then edits.
Expects **1 flush**, not 3 — confirms we don't double-register.

Both tests pass.

## 5. Verification

```bash
$ npx vitest run tests/unit/yjs-poc.test.ts --watch=false
Test Files  1 passed (1)
     Tests  27 passed (27)  ← was 25 before, +2 regression
```

### Validating on real staging (TODO post-merge)

Rerun `scripts/ops/yjs-client-validation/yjs-node-client.mjs` against
`http://142.171.239.56:8081` twice in a row with the same record. Expected:

- Run A (cold): all 4 checks green
- Run B (warm): all 4 checks green (previously: DB-reflects-edit ❌)

## 6. Why tests didn't catch this earlier

The existing `YjsRecordBridge` tests create a bridge + doc + observe + edit
in a single test function, i.e. they never exercise the "destroy and
recreate the doc" path. The real production flow does this routinely via
idle cleanup every 60s. The test matrix was missing a lifecycle dimension.

The new regression tests close that gap.

## 7. Scope of impact

This bug means any user who edits a record more than once across an idle
gap (or any second user who arrives after a doc was cleaned up) got
**silently dropped edits**. Not a corruption bug — just a "nothing happens"
bug. Combined with the fact that the frontend editor isn't wired yet, this
had zero real user impact so far. But it would have been the first thing
users hit once the frontend did land.

## 8. Files changed

- `packages/core-backend/src/collab/yjs-record-bridge.ts` (fix + JSDoc)
- `packages/core-backend/tests/unit/yjs-poc.test.ts` (+2 regression tests)
- `docs/operations/yjs-bridge-stale-observer-fix-20260420.md` (this file)

## 9. Non-goals

- Did not touch `YjsSyncService` — the sync service correctly destroys idle
  docs and correctly creates fresh ones. The defect was solely in the
  bridge not reacting to doc recreation.
- Did not change the idle threshold (60s) — that is a tuning parameter.
- Did not add an explicit "doc destroyed" callback from sync service to
  bridge. The simpler invariant "observe() must be idempotent per Y.Doc
  identity" is sufficient and doesn't add inter-service coupling.
