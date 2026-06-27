# T8-2 Reset UI — T-source picker (development & verification)

**Date:** 2026-06-27 · **Scope:** the product entry the Reset UI was missing (#3250 shipped `ResetConfirmDialog` but flagged *"entry-wiring needs a T-source"*; #3251 named the *"T-source gap"*). This closes that gap. **Flag-off by default** (`MULTITABLE_ENABLE_PIT_RESET`).

## What was built
- **`ResetToPointPicker.vue`** (new): sources a point-in-time **T** and mounts the existing `ResetConfirmDialog` with `asOf = T`. The dialog already owns preview → typed two-step confirm → execute; this component only supplies T and binds the wire.
- **Mount in `MultitableWorkbench.vue`** (the actual entry-wiring): rendered under the toolbar, gated, bound to `workbench.client` + `workbench.activeSheetId`; `onDone` refreshes the grid.
- **`multitable-web-guard.yml`**: registered the new spec in the run command + both trigger `paths` lists (so it runs in CI — without this the spec would be invisible to the guard).

## Design decisions
- **T-source = free `datetime-local` picker** (the minimal "只差产品入口"). The `asOf` derivation (`localToIso` / the `asOf` computed) is the **single swappable seam**.
  - **Alternative (deferred, named so the owner can steer):** present recent `HistoryCenterModal` batch timestamps as selectable options — richer (you reset to a real change-point), and still **read-only consumption** of history (it never mutates the read-only history center). Swapping is a one-function change at the seam.
- **Timezone (destructive-op safety):** `datetime-local` is browser-local; `asOf` is the corresponding **UTC ISO** for the API. The human-facing "Target: …" line is derived **from `asOf`** (not the raw input), so what the user sees can never diverge from what the destructive op uses. A WIRE test asserts the sent `asOf` round-trips to the same instant as the input (no inversion).
- **Gating:** on `pitResetEnabled` **alone** (it already encodes `MULTITABLE_ENABLE_PIT_RESET ∧ canManageSheetAccess` per #3239) — no second check that could drift. Absent/false ⇒ the whole entry is hidden (fail-closed).
- **No two reset buttons:** the dialog is mounted only once T is valid & **past**, so the dialog's own "Reset to {asOf}…" button never fires on an empty/ future `asOf`.
- **No backend change:** reuses `reset-preview` / `reset-execute` as-is.

## Verification
| What | How | Status |
|---|---|---|
| Picker logic (gating, valid-past, future-reject, target display) | `multitable-reset-tsource-picker.spec.ts` (jsdom, `createApp`) | ✅ 5/5 local |
| **The (sheetId, asOf) WIRE** — picker → client → `reset-preview` | same spec, **fake `fetchFn`** asserts URL carries the picker's `sheetId` + body `asOf` = UTC-ISO of the input, round-tripping to the same instant | ✅ (this is the real check, not a fixture) |
| **Post-execute seam** — `execute → dialog.onDone → picker onDone → grid refresh` | picker spec test (g): drives execute (revert-equiv path) and asserts `onDone` fires + `reset-execute` carries the sheetId | ✅ (the "does the entry close the loop" check) |
| The workbench **mount** (binding `pitResetEnabled`/`sheetId`/client) | `vue-tsc -b` (authoritative; `--noEmit` can false-green) | ✅ exit 0 |
| Reuse didn't break anything | full `multitable-web-guard` set | ✅ **372/372** (38 files) |
| **Live app with the flag ON** — the entry actually *renders* + a real reset round-trips through a real grid | not run here (flag default-off; needs a flag-enabled env) | ⬜ **honest gap** (narrow): the wire + onDone seam are unit-covered; only the live render + real-grid round-trip is unverified. Recommend a flag-on smoke before rollout. |

## Scope boundary
This is **item #1** of the owner's reordered list. **Not** included (each is destructive and needs its own design-lock + owner gate, per the given order): T8-1 undelete-execute · T9-W Tier 3 un-create · Tier 4 undelete · permission-revert. The `value-transforming/destructive retype option II` is also separate.

## Follow-ups (non-blocking)
- Flag-on smoke (the ⬜ above).
- **Post-destructive page offset:** `onResetDone` calls `grid.reloadCurrentPage()` → `loadViewData()`, which already falls back/clamps when the current offset becomes empty (owner-confirmed in the #3301 review). So no extra offset handling is needed — the earlier "reset offset to 0" caution was unnecessary.
- Swap the T-source seam to history-timestamp options if the owner prefers the richer picker.
- Visual placement polish (currently a gated strip under the toolbar) + i18n (matches `ResetConfirmDialog`'s current raw-string state; a later i18n sweep covers both).
