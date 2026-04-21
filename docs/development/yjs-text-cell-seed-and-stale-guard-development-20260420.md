# Yjs Text Cell — Seed & Stale-Guard Fix (PR #960 follow-up)

- **Branch**: `codex/wire-yjs-text-cell-20260420`
- **Date**: 2026-04-20
- **Scope**: PR #960 post-review hardening; closes P0 data-overwrite vector
  and P1 connect-timeout race flagged in the 2026-04-20 reviewer note.
  Frontend + backend. Staging flag rollout unblocked by this fix.

## Summary

The initial PR #960 shipped a minimal-diff frontend binding (see the
prior dev MD `yjs-text-cell-diff-binding-development-20260420.md`),
but two subsequent reviewer findings required additional work before
merge:

- **2026-04-20 review (P0/P1)** — empty Y.Text overwrite + connect race.
- **2026-04-21 review (P0)** — REST → Yjs consistency gap.

### P0 2026-04-20 — empty-Y.Text overwrite

`useYjsTextField` auto-created an empty `Y.Text` whenever the field
was missing; the backend `YjsSyncService` only loaded Yjs
snapshots/updates and never seeded from `meta_records.data`. First
opener of an existing text cell saw an empty textbox; confirm/typing
overwrote the original DB value with whatever the user typed on top
of the empty state.

### P1 2026-04-20 — connect stale-guard

`useYjsDocument.connect` awaited `getCurrentUserId()` before creating
the doc/socket. The cell-binding timeout fallback could fire during
that await. After the await returned, no stale-guard protected the
resume path — it could still construct a socket/doc that the caller
had already given up on.

### P0 2026-04-21 — REST → Yjs stale snapshot

With the seed fix landed (P0 above), a later class of bug became
visible: `YjsSyncService.getOrCreateDoc` seeds from
`meta_records.data` **only on fresh create** (when persistence
returned `null`). Once a Y.Doc snapshot exists, any REST write to
`meta_records.data` is invisible to the next Yjs opener — the
snapshot wins. Example: user A edits via Yjs → snapshot stored; user
B PATCHes the same record via REST; user A re-opens → sees the
pre-REST value.

All three fixes land in this change.

## Changes

### Backend — fresh-doc seed from `meta_records`

- `packages/core-backend/src/collab/yjs-sync-service.ts`
  - New optional second constructor parameter `YjsRecordSeedFn`
    (`(recordId) => Promise<Record<string, unknown> | null>`).
  - On `getOrCreateDoc(recordId)`, if the persistence adapter returns
    `null` (no existing Yjs state), we call `seedFreshDoc` which reads
    the current row via the seeder and wraps every **string** field in
    a new `Y.Text` inside the shared `fields` Y.Map.
  - The seed transact uses `origin='seed'`; the persistence listener
    skips that origin so the bootstrap stays in memory and does not
    spawn a DB `yjs_doc_updates` row. The first real user edit (origin
    undefined / `'rest'`) triggers persistence as usual.
  - Non-string fields are intentionally skipped — only text cells are
    routed through Yjs in the current rollout; numeric/date/select
    stay on REST.
  - Seed throws → logged, doc returned empty (never crashes the
    handshake); seeder returns `null`/missing → doc stays empty.
- `packages/core-backend/src/index.ts`
  - Supplies a `yjsRecordSeeder` closure that queries
    `SELECT data FROM meta_records WHERE id = $1`, defensively handling
    non-object payloads.
  - Passed as the second arg to `new YjsSyncService(...)`.

### Frontend — `useYjsTextField` seed contract

`apps/web/src/multitable/composables/useYjsTextField.ts`:

- **Removed** the silent creation of an empty `Y.Text` when the field
  was missing. That was the root of the P0 overwrite vector — the
  composable used to create an empty Y.Text on mount, the editor bound
  to it, the user typed, and the diff emitted `insert` against `''`
  even though the DB row held `'existing value'`.
- Added a `yjsActive` readonly ref (true only when an actual `Y.Text`
  is attached).
- The `doc` watcher now installs a **Y.Map observer on `fields`** so
  that when the backend seed arrives via sync (or another client
  creates the Y.Text), we attach without forcing a reconnect. This
  was necessary even for normal flow: the client's freshly-constructed
  Y.Doc is always empty for the brief window between `socketIO(...)`
  and the initial sync handshake.
- `setText` is now a no-op when inactive — no ghost Y.Text creation.
- JSDoc updated with the seed contract so future editors don't
  reintroduce the overwrite vector.

### Frontend — `useYjsCellBinding` active gating

`apps/web/src/multitable/composables/useYjsCellBinding.ts`:

- Tracks `boundYjsActive` mirroring `useYjsTextField.yjsActive`.
- `active` now requires **both** (a) the sync handshake completed AND
  (b) `Y.Text` exists for this field. Without (b) we'd bind the input
  to a composable returning `text: ""` and a no-op `setText`, silently
  eating keystrokes and possibly showing a blank cell.
- On mid-session loss of the Y.Text (defensive, shouldn't happen in
  normal flow), we flip `active` back to false and let the caller go
  to REST.

### Frontend — `useYjsDocument` stale-guard

`apps/web/src/multitable/composables/useYjsDocument.ts`:

- Added a monotonic `connectGen` counter.
- `connect()` bumps it, captures `myGen`, and re-checks
  `myGen === connectGen` **after** the `await auth.getCurrentUserId()`
  resolves. Different → bail before `socketIO(...)` runs.
- `disconnect()` also bumps `connectGen` so any in-flight connect from
  a prior cycle aborts cleanly.

### REST → Yjs invalidation hook

Three new surfaces close the stale-snapshot bug from the 2026-04-21 review:

- `YjsPersistenceAdapter.purgeRecords(ids)` — single transaction deletes
  from `meta_record_yjs_states` and `meta_record_yjs_updates` for the
  given record IDs. No-op on empty input or unknown IDs.
- `YjsSyncService.invalidateDocs(ids)` — destroys cached Y.Docs WITHOUT
  snapshotting (a snapshot now would encode pre-REST state and defeat
  the fix) then calls `purgeRecords`. Documented: callers MUST cancel
  bridge pending flushes FIRST.
- `YjsRecordBridge.cancelPending(ids)` — clears `pendingWrites` entries
  and their `setTimeout` timers for the given records. Without this,
  the 200–500ms debounce could fire after invalidation and re-write
  the stale Y.Doc-cached value on top of the REST change.

#### Wiring

`packages/core-backend/src/index.ts` composes the invalidator:

```ts
const yjsInvalidate = async (recordIds: string[]) => {
  if (recordIds.length === 0) return
  yjsBridge.cancelPending(recordIds)              // 1. stop scheduled flushes
  await yjsSyncService.invalidateDocs(recordIds)   // 2. evict + purge
}
recordWriteService.setYjsInvalidator(yjsInvalidate)
univerMetaModule.setYjsInvalidatorForRoutes(yjsInvalidate)
```

Both write sites fire the hook **post-commit, best-effort**:

- `RecordWriteService.patchRecords` — called for every record in the
  patch unless `input.source === 'yjs-bridge'`. Errors are logged; the
  REST write still returns success.
- `PATCH /records/:recordId` direct-SQL handler in `univer-meta.ts` —
  called after the transaction commits. Same log-and-swallow contract.

#### Loop prevention

`RecordPatchInput.source?: 'rest' | 'yjs-bridge'`. The bridge's
`getWriteInput` closure sets `source: 'yjs-bridge'` on the input it
builds. `RecordWriteService.patchRecords` skips invalidation when
`source === 'yjs-bridge'` — those writes originate from the live
in-memory Y.Doc; destroying it would tear out the editor and re-seed
from a DB row that hasn't yet caught up to the just-committed patch.

Default polarity is invalidate-on-unset, so any future REST entry
point that forgets to set `source` errs on the safe side.

#### Why the bridge-vs-REST race is safe

Row-level `SELECT ... FOR UPDATE` inside `patchRecords`' transaction
serializes bridge and REST writes for the same record. Whichever
commits last is the final DB value, and because only `source='rest'`
(or unset) triggers invalidation, the Yjs snapshot never outlives a
commit that post-dates it:

- REST commits first → invalidates → bridge commits second → bridge's
  Yjs-cached value wins the final DB state, Yjs snapshot stays dropped
  until next open re-seeds from that fresh value.
- Bridge commits first → does NOT invalidate (source='yjs-bridge') →
  REST commits second → invalidates → Yjs state purged; next open
  re-seeds from REST's value.

Either way, the next `getOrCreateDoc` reads the last committed DB
value. No path leaves a stale snapshot shadowing a newer DB row.

### View layer confirmation

`apps/web/src/multitable/components/cells/MetaCellEditor.vue` was
**not** changed — it already reads the Y.Text value only when
`yjsActive` is true (`:value="yjsActive ? yjsText : (modelValue ?? '')"`)
and `onTextInput` only calls `yjsBinding.setText(next)` when `yjsActive`.
The P0 fix therefore cascades correctly to the render path.

## Tests

### New

- `packages/core-backend/tests/unit/yjs-rest-invalidation.test.ts` (7 cases)
  - **Regression test from the 2026-04-21 review**: snapshot exists →
    REST update + invalidate → next Yjs open reads the REST value, not
    the stale snapshot
  - `invalidateDocs` evicts in-memory without snapshotting (prevents a
    "flush then invalidate" from persisting the stale value)
  - Record never opened → no-op
  - Empty array → no-op
  - Service without seeder: invalidation still works, next open empty
  - Bridge debounce race: scheduled flush is cancelled before timer
    fires, so no `patchRecords` call after invalidation
  - `cancelPending` on untouched records does not throw
- `packages/core-backend/tests/unit/yjs-sync-seed.test.ts` (7 cases)
  - Seeds string Y.Text from `meta_records.data`
  - Skips non-string fields
  - Does **not** seed when persistence returns existing state (persisted
    state wins — avoids stale DB reverting concurrent edits)
  - Seed does NOT create a `yjs_doc_updates` row (origin='seed'
    filtered)
  - Null seeder return → empty doc (no crash)
  - Seeder throwing → empty doc, warning logged
  - Idempotent on repeat `getOrCreateDoc` (cached Y.Doc returned,
    seeder not called twice)
  - No seeder provided → legacy behavior preserved
- `apps/web/tests/yjs-text-field-seed-guard.spec.ts` (6 cases)
  - Empty Y.Doc → `yjsActive=false`, `text=''`, no stray Y.Text
    inserted into the doc
  - Non-Y.Text entry (e.g. number) preserved, not overwritten
  - Seeded Y.Text → `yjsActive=true`, text reflects seed (not `''`)
  - `setText` while inactive is a no-op
  - `docRef` swap null → seeded: transition false→true
  - `docRef` swap seeded → null: transition true→false
- `apps/web/tests/yjs-document-stale-guard.spec.ts` (2 cases)
  - `disconnect()` during pending `getCurrentUserId()` — resolved
    promise must NOT create a socket
  - Fresh connect after disconnect still works; old resolve ignored

### Updated (covering the contract change)

- `apps/web/tests/yjs-text-field-diff.spec.ts` — the three setText-shape
  tests and the concurrent-merge smoke test now seed the Y.Doc via a
  new `seedDoc(doc, value)` helper (mirroring backend `recordSeed`
  behavior) before mounting the harness.
- `apps/web/tests/multitable-yjs-cell-binding.spec.ts` — the
  "drives Y.Text when flag is on" case now sends a primer SyncStep2
  carrying a Y.Text for the field, matching backend seed behavior.
- `apps/web/tests/yjs-awareness-presence.spec.ts` — same primer pattern
  so `setActiveField` fires as expected.

### Known limitations — documented, not fixed in this PR

- **Live editor mid-session invalidation.** Active WebSocket editors
  on a record lose their in-memory Y.Doc when a REST write on that
  same record invalidates. They see subsequent local edits stop
  persisting until the socket is reconnected (refreshing the page
  reseeds from the new DB state). For POC / internal rollout this is
  acceptable — REST writes to records with live Yjs editors should
  be rare, and when they happen the user can refresh. Proper fix:
  `yjs:invalidated` server event → client-side reseed; out of scope.
- **Record DELETE path.** Record deletion does not fire the
  invalidator. The periodic 10-minute orphan cleanup
  (`YjsPersistenceAdapter.cleanupOrphanStates`) eventually drops the
  persisted rows, but a client cached on `recordId` could briefly
  hit a stale Y.Doc on the server between delete and cleanup.
  Out of scope; fold into follow-up alongside live-editor reseed.

## Risk

- **Backend recordSeed DB cost**: one extra `SELECT` per fresh-doc
  create. Not per handshake — the service caches docs. Negligible
  under the current internal rollout cap (single tenant, low QPS).
- **Non-string fields on Yjs cells**: this release stays text-only by
  design. If the caller ever routes a non-string field through
  `useYjsTextField`, the seed guard prevents a new overwrite vector
  (yjsActive stays false, caller falls back to REST).
- **Seed vs external edit races**: if two clients trigger
  `getOrCreateDoc` at exactly the same ms, only one seeds (idempotent
  cache). The other receives the same Y.Doc ref.
- **Mid-session Y.Text deletion**: defensive — if the fields-map
  observer ever sees a removal, `detachYText()` fires
  `setActiveField(null)` (equivalent to "user unfocused the field").
  The caller falls back to REST for subsequent edits. Shouldn't happen
  in normal flow.

## Merge/Rollout plan

1. Commit and push to `codex/wire-yjs-text-cell-20260420`.
2. Update PR #960 description: remove stale "delete(0,length)+insert"
   claim, reflect prefix/suffix diff + backend seed + stale-guard.
3. Merge PR #960.
4. Staging: flag on with `VITE_ENABLE_YJS_COLLAB=true`, two-browser
   concurrent-edit click test per `docs/operations/yjs-internal-rollout-test-assignment-20260417.md`.
