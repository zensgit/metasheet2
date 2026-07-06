# Personal views — Slice 3b (FE fieldOrder consumer + G-FE-5) — VERIFICATION — 2026-07-06

> Closes the deferral from Slice 3 (#3711): the FE now RENDERS per-view column order from `view.fieldOrder`
> (server-resolved, personal-overlay-applied), fail-soft on stale/unknown ids — the G-FE-5 golden that had no
> live consumer until now. Design ref: `multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md`.
> **No flag, no new surface, no runtime opt-in.** Presentation-only; default behavior (no `fieldOrder`) is
> byte-identical to before. Grounded on `origin/main` @ `2fe166d6a`.

## Background — why this was deferred, why it's now unblocked

Slice 2 (#3657) landed the `fieldOrder` overlay as **backend plumbing** (stored per (view,user), server-applied
onto the served view). Slice 3 (#3711) shipped the toggle but had **no FE consumer of `fieldOrder`** — nothing
read `view.fieldOrder` to reorder columns — so the unknown-id fail-soft golden (G-FE-5) would have been vacuous.
The reviewer explicitly carried G-FE-5 to "Slice 3b, with the field-order-rendering consumer." This is that slice.

## What shipped (FE only)

- **`useMultitableGrid`** (`apps/web/src/multitable/composables/useMultitableGrid.ts`):
  - New `fieldOrder` ref, captured in `syncFromView` from the loaded view's `fieldOrder` (string-filtered on
    ingest; membership NOT validated here — the consumer fail-softs).
  - `visibleFields` now applies `fieldOrder` as a **presentation reorder** over the already-filtered
    (hidden/permission) set: fields named in `fieldOrder` first, in that order; visible fields NOT named keep
    their natural order (server `field.order`), appended after. Empty/absent `fieldOrder` ⇒ returns the base
    filtered list unchanged (byte-identical to pre-Slice-3b).
- **`types.ts`** — corrected the `MetaView.fieldOrder` comment (it previously said "No FE consumer renders this
  yet"); now documents the Slice 3b consumer + fail-soft.

The grid renders `visibleFields` as its columns, so reordering `visibleFields` reorders the rendered columns with
no change to `MetaGridTable` or any other component.

## G-FE-5 (fail-soft) — the golden that motivated this slice

`apps/web/tests/multitable-grid-fieldorder-consumer.spec.ts` (7 tests, all green):
- renders columns in `fieldOrder`; unnamed fields appended in natural order.
- empty / absent `fieldOrder` ⇒ natural order unchanged.
- **unknown / stale ids ignored** — no crash, no blank column, no real column dropped.
- **entirely-unknown `fieldOrder`** ⇒ falls back to natural order (never empties the grid).
- duplicate id ⇒ no duplicated column.
- an id naming a HIDDEN field ⇒ skipped (stays hidden), rest of order honored.
- non-string entries filtered on ingest (malformed-payload defense).

Run: `cd apps/web && npx vitest run tests/multitable-grid-fieldorder-consumer.spec.ts` → **7 passed**. Regression:
`multitable-grid multitable-field-visibility multitable-frozen-columns-grid multitable-grid-bulk-edit` → **15
files / 142 tests pass** (the reorder is inert when `fieldOrder` is empty, which is every existing test). vue-tsc
clean.

## Scope boundary — what is NOT in this slice

This is the **read/render** side only. The **write** side (a user dragging columns while personal mode is ON to
persist a per-user `fieldOrder` via `PUT …/personal-config`) is a separate follow-up (call it Slice 3c) — the
existing field-reorder drag still targets the shared order and is untouched here. Slice 3b makes any stored
`fieldOrder` (however authored) render correctly and safely; it does not add a new authoring path.

## Enablement posture

Unchanged. The overlay only carries a `fieldOrder` when `MULTITABLE_ENABLE_PERSONAL_VIEWS` is on AND the actor has
a personal row (Slice 1/2 contract); with the flag off there is no `fieldOrder` and this consumer is inert. No new
flag, no new gate. Backend actor-isolation (G-A/G-C) and the `/context` overlay (Slice 3 P1) are unchanged.
