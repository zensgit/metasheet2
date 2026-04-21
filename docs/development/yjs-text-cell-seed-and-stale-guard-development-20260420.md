# Yjs Text Cell — Seed & Stale-Guard Fix (PR #960 follow-up)

- **Branch**: `codex/wire-yjs-text-cell-20260420`
- **Date**: 2026-04-20
- **Scope**: PR #960 post-review hardening; closes P0 data-overwrite vector
  and P1 connect-timeout race flagged in the 2026-04-20 reviewer note.
  Frontend + backend. Staging flag rollout unblocked by this fix.

## Summary

The initial PR #960 shipped a minimal-diff frontend binding (see the
prior dev MD `yjs-text-cell-diff-binding-development-20260420.md`),
but the reviewer found two blocking issues on top of the LWW fix:

- **P0** — `useYjsTextField` auto-created an empty `Y.Text` whenever the
  field was missing; the backend `YjsSyncService` only loaded Yjs
  snapshots/updates and never seeded from `meta_records.data`. First
  opener of an existing text cell saw an empty textbox; confirm/typing
  overwrote the original DB value with whatever the user typed on top
  of the empty state.
- **P1** — `useYjsDocument.connect` awaited `getCurrentUserId()` before
  creating the doc/socket. The cell-binding timeout fallback could fire
  during that await. After the await returned, no stale-guard protected
  the resume path — it could still construct a socket/doc that the
  caller had already given up on.

Both fixes land in this change.

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

### View layer confirmation

`apps/web/src/multitable/components/cells/MetaCellEditor.vue` was
**not** changed — it already reads the Y.Text value only when
`yjsActive` is true (`:value="yjsActive ? yjsText : (modelValue ?? '')"`)
and `onTextInput` only calls `yjsBinding.setText(next)` when `yjsActive`.
The P0 fix therefore cascades correctly to the render path.

## Tests

### New

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
