# Verification — Yjs Text Cell Seed & Stale-Guard Fix

- **Branch**: `codex/wire-yjs-text-cell-20260420`
- **Date**: 2026-04-20
- **Linked dev MD**: `yjs-text-cell-seed-and-stale-guard-development-20260420.md`

## Evidence matrix

| Risk surfaced in review      | How the fix closes it                                   | Test(s)                                                                    |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| P0 empty-Y.Text overwrite (2026-04-20) | Frontend refuses to create Y.Text; backend seeds from `meta_records.data` | `yjs-sync-seed.test.ts` (7), `yjs-text-field-seed-guard.spec.ts` (6)       |
| P0 seed writes stale DB      | `origin='seed'` skipped in persistence listener         | `yjs-sync-seed.test.ts › seeding does NOT create a DB update row`          |
| P0 cached-doc overwrite      | Second `getOrCreateDoc` returns cached, no re-seed      | `yjs-sync-seed.test.ts › does NOT overwrite an existing entry via seed`    |
| Client Y.Text arrives async  | `fields` Y.Map observer attaches when Y.Text is set later | `multitable-yjs-cell-binding.spec.ts › drives Y.Text`                      |
| P1 stale-guard on timeout    | `connectGen` monotonic counter; both connect/disconnect bump | `yjs-document-stale-guard.spec.ts` (2)                                     |
| P0 REST stale snapshot (2026-04-21) | `invalidateDocs` + `purgeRecords` called post-commit; bridge `cancelPending` first | `yjs-rest-invalidation.test.ts` (7)                                        |
| P0 bridge debounce race      | `cancelPending` clears scheduled `setTimeout` before the REST invalidation returns | `yjs-rest-invalidation.test.ts › cancelPending clears a scheduled flush` |
| Bridge writes self-invalidate | `RecordPatchInput.source='yjs-bridge'` skipped in invalidation hook | Source check in `record-write-service.patchRecords`; negative path covered by bridge test |
| View-layer fallback intact   | `MetaCellEditor.vue:31` reads modelValue when inactive  | Read-verified; `multitable-yjs-cell-binding.spec.ts › timeout` covers fallback |

## Test runs

All runs are on the commit under verification, tree dirty only with
files listed in the dev MD.

### Backend — `YjsSyncService` + existing Yjs suite

```
pnpm --filter @metasheet/core-backend exec vitest run yjs record-write
# Test Files  9 passed (9)
#      Tests  79 passed (79)
```

Covers:
- New `yjs-sync-seed.test.ts` (7 cases)
- New `yjs-rest-invalidation.test.ts` (7 cases — includes the
  reviewer-requested regression: snapshot exists → REST update →
  next Yjs open reads the REST value, not the stale snapshot)
- Pre-existing `yjs-poc.test.ts`, `yjs-*.test.ts`, `record-write-service.test.ts` (79 total)

### Frontend — Yjs composables and cell binding

```
pnpm --filter @metasheet/web exec vitest run tests/yjs
# Test Files  4 passed (4)
#      Tests  26 passed (26)

pnpm --filter @metasheet/web exec vitest run tests/multitable-yjs-cell-binding.spec.ts
# Test Files  1 passed (1)
#      Tests  4 passed (4)
```

Covers:
- `yjs-text-field-diff.spec.ts` (16) — pure diff + minimal-op shape +
  concurrent merge smoke
- `yjs-text-field-seed-guard.spec.ts` (6, new)
- `yjs-document-stale-guard.spec.ts` (2, new)
- `yjs-awareness-presence.spec.ts` (2) — presence emit still fires
  once Y.Text is seeded via sync
- `multitable-yjs-cell-binding.spec.ts` (4) — flag off, flag "1",
  flag on drives Y.Text, fallback on timeout

### Type checks

```
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit   # EXIT=0
pnpm --filter @metasheet/core-backend exec tsc --noEmit # EXIT=0
```

### Wider web regression

Run: `pnpm --filter @metasheet/web exec vitest run`.

- 100 tests fail across 31 files — **all pre-existing** (confirmed by
  running the same suite on `git stash`'d HEAD; failure list identical).
  None touch Yjs / cell-editor / useYjs* paths.
- No new failure introduced by this change.

### Wider backend regression

Run: `pnpm --filter @metasheet/core-backend exec vitest run`.

- 2281 tests pass. One test file (`api-token-webhook-migration.test.ts`)
  fails to load — missing migration file, pre-existing, unrelated to
  this PR (untracked orphan test referencing a non-existent migration).

## Manual verification plan (staging)

Blocked on merge of this PR. Per the rollout test assignment MD
(`docs/operations/yjs-internal-rollout-test-assignment-20260417.md`):

1. Deploy with `VITE_ENABLE_YJS_COLLAB=true` to staging.
2. Open the same record in two browsers (same tenant, different users).
3. Click a seeded text cell (one with pre-existing non-empty value).
   - **Expected**: cell shows the existing value (NOT empty).
   - **Fail signal**: empty textbox — means seed didn't reach this
     client or `yjsActive` stayed false. Abort rollout.
4. Edit different ranges concurrently.
   - **Expected**: both edits survive in both browsers after a short
     sync.
   - **Fail signal**: one overwrites the other — means diff regressed
     or transact is wrong.
5. Time-slice disconnect: revoke the server socket on one browser
   during an active edit.
   - **Expected**: editor falls back to REST soft-console-warn; the
     REST input still works; no console error.
6. Open a cell for a field with no DB value yet.
   - **Expected**: empty input; typing works via REST fallback if
     seed skipped that field (non-string) or via Yjs insert if seeded
     empty string.
7. **REST → Yjs consistency (2026-04-21 review)**. With browser A's
   cell editor closed (so the record is idle-released server-side),
   PATCH the same field via REST (curl or the browser's dev console),
   then open the cell again in browser A.
   - **Expected**: the REST value appears. Y.Doc was wiped; seed
     re-read from `meta_records.data`.
   - **Fail signal**: old Yjs value appears — means the invalidation
     didn't fire or `purgeRecords` didn't run.

## Rollback

If staging verification fails on step 3 (empty cell on existing value):

1. Revert the merge commit on main (`git revert -m 1 <merge-sha>`).
2. Force deploy of previous image.
3. The REST path is the default branch — flag off returns the app to
   pre-Yjs behavior with zero data risk.

No DB schema change — rollback has no migration impact.
