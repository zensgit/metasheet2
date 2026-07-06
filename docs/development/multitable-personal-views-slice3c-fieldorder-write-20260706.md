# Personal views — Slice 3c (personal column-reorder write path) — VERIFICATION — 2026-07-06

> Closes the write side of per-user column order: dragging a column while personal mode is ON persists the
> actor's own `personal-config.fieldOrder`, never the shared `field.order`. Completes personal-views from "can
> SEE my order" (Slice 3b) to "can safely EDIT my order". Default-OFF; no flag change. Grounded on
> `origin/main` @ `17fe25c4e`.

## The two load-bearing constraints (each has a golden)

**C1 — personal drag never writes the shared order.**
`onReorderField` (`MultitableWorkbench.vue`) now routes through `utils/reorder-view-fields.ts`:
- **Personal ON** (personal-views enabled AND the active view's toggle ON) → reorder the **visible** order and
  write ONLY `PUT …/personal-config { fieldOrder }`. It NEVER calls `client.updateField({ order })` — the
  boundary you flagged (personal display order must not become shared `field.order`) is enforced in code.
- **Personal OFF** → the unchanged shared path (reorder `grid.fields`, persist each `field.order`), byte-for-byte
  as before.
Golden `multitable-reorder-view-fields.spec.ts`: shared drag ⇒ `updateField ×N`, **no** personal-config call;
personal drag ⇒ `putPersonalViewConfig`, **`updateField` asserted NOT called**, `onSharedOrder` not called.

**C2 — writing fieldOrder preserves the actor's other personal facets.**
The backend PUT replaces the whole config row (`upsertPersonalViewConfig` does `DO UPDATE SET config = $3`), so a
naive `PUT { fieldOrder }` would wipe personal filter/sort/hidden. Slice 3c does **read-merge-write**: GET the
current personal config, spread it, set only `fieldOrder`. Golden: an existing personal row with
`filterInfo/sortInfo/hiddenFieldIds` + a drag ⇒ the PUT body carries all of them **plus** the new `fieldOrder`.
No-row (`config: null`) ⇒ PUT creates it with just `fieldOrder`; a GET 404 (flag flip / view gone) ⇒ still writes,
no throw.

## Computation

Personal reorder operates over `grid.visibleFields` (the order the user sees and drags) → the new visible id list
becomes `fieldOrder`; hidden/unknown ids are not reintroduced (they were never in the visible list, and Slice 3b's
consumer stays fail-soft). Shared reorder operates over `grid.fields` to preserve sheet-global `field.order`. The
personal path applies the new order optimistically (`grid.fieldOrder.value = order`) so columns move immediately.

## Verification

- `multitable-reorder-view-fields.spec.ts` — **7 goldens green** (C1 routing both directions, C2 preserve, no-row,
  404-tolerant, move-within, no-op on unknown id).
- Regression: `multitable-reorder-view-fields multitable-workbench-restore-wiring multitable-grid
  multitable-config-revert-refresh` → **16 files / 147 tests pass**. vue-tsc clean.
- Added `multitable-reorder-view-fields` to the `multitable-web-guard` run filter (the workflow already triggers
  on `MultitableWorkbench.vue` / `useMultitableGrid.ts` edits, which this PR touches) so the goldens have CI teeth.

## Known follow-up surfaced during this slice (NOT a 3c regression — pre-existing)

Slice 3's in-place personal edits (`persistViewConfig` → `putPersonalViewConfig({ sortInfo })` etc.) send only the
edited facet, and because the upsert REPLACES the row, a single-facet personal edit **wipes the actor's other
personal facets** (e.g. changing personal sort drops personal `fieldOrder`/filter/hidden). This shipped in Slice 3
(#3711) and is independent of 3c — 3c's drag is preservation-correct at write time (read-merge-write). To make
personal editing durable end-to-end, a follow-up (**Slice 3d**) should make ALL personal-config writes additive —
either read-merge-write like 3c, or make the backend upsert merge (with an explicit clear for a facet). Flagged
here rather than silently expanding this "small PR". No test is skipped for 3c itself.

## Scope / posture

Read/render (3b) + write (3c) now both done; personal column order is end-to-end for the drag path. Default-OFF,
no flag/enablement change, no backend change. Backend actor-isolation and `/context` overlay unchanged.
