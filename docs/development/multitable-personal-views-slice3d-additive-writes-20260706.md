# Personal views — Slice 3d (additive personal-config writes) — DESIGN + VERIFICATION — 2026-07-06

> Closes the follow-up flagged in `multitable-personal-views-slice3c-fieldorder-write-20260706.md` ("Known
> follow-up"): a single-facet personal edit must NOT wipe the actor's other personal facets. Default-OFF; no
> flag/backend change. Grounded on `origin/main` @ `0315bcf3c`. **For-review; not merged.**
>
> Built by the unattended autonomous cadence loop. Per its guardrails: for-review PR only, no merge, no flag/
> protection changes.

## Design (the problem + the fix)

The backend `PUT /views/:id/personal-config` REPLACES the whole config row (`upsertPersonalViewConfig`:
`DO UPDATE SET config = $3`). Slice 3's in-place personal edits (`persistViewConfig` in `useMultitableGrid.ts`)
send only the edited facet — `persistSortFilter` → `{ sortInfo, filterInfo }`, group → `{ groupInfo }`,
`persistHiddenFields` → `{ hiddenFieldIds }`. So in personal mode, editing one facet **wiped the others**
(e.g. changing personal sort dropped personal filter / hidden / fieldOrder). This violated the design-lock's
§1-D ("additive; unset facets fall through").

**Fix — read-merge-write** (same pattern Slice 3c uses for column reorder): `utils/personal-config-write.ts`
`writePersonalConfigMerged(client, viewId, patch)` reads the actor's current personal config, merges the patch
over it (`{ ...base, ...patch }`), and PUTs the whole thing. `persistViewConfig`'s personal branch now calls it;
the shared (`updateView`) branch is unchanged. Clearing still works: a patch facet set to `undefined` overrides
`base` and `JSON.stringify` drops it, so the backend `sanitize` omits it (cleared) — while facets ABSENT from the
patch are preserved from `base`. No backend change; the FE now sends the complete desired overlay each write.

## Scope

FE-only, one composable + one small util. Default-OFF (feature gated by `MULTITABLE_ENABLE_PERSONAL_VIEWS`; the
personal branch only runs when `isPersonalMode` is true, which is itself flag-gated). No new surface, no new flag,
no security-membrane change ⇒ L2.

## Verification

Goldens `apps/web/tests/multitable-grid-personal-additive-write.spec.ts` (7, all green):
- **Core golden (the ask):** existing `{filter, sort, hidden}` + a single-facet `{hiddenFieldIds}` edit ⇒ filter
  & sort preserved, hidden updated.
- a `{sortInfo}` edit preserves an existing personal `fieldOrder` + filter (cross-facet durability).
- no existing row (`config: null`) ⇒ writes just the patch (row created lazily).
- GET **404** (flag flip / no row) ⇒ still writes, no throw.
- **FAIL-CLOSED:** a non-404 GET failure (500 / network / transient auth) ⇒ re-throws and does NOT PUT — a blind
  write on a failed read would REPLACE the row and wipe the actor's other facets (the exact thing this helper
  prevents). Golden asserts reject + `putPersonalViewConfig` not called.
- clearing: patch `{filterInfo: undefined}` drops filter on the wire while sort/hidden persist.
- **grid wiring:** personal ON — `toggleFieldVisibility` merges over the existing personal config (sort
  preserved), `updateView` NOT called; personal OFF — uses the shared `updateView` path, no personal-config call.

Run: `cd apps/web && npx vitest run tests/multitable-grid-personal-additive-write.spec.ts` → **7 passed**.
Regression: `multitable-grid` filter → **14 files / 132 tests pass** (the change is inert on the shared path and
for a first personal write with no existing row). vue-tsc clean. The spec is caught by the existing
`multitable-web-guard` `multitable-grid` filter (no workflow change needed).

## Interaction with Slice 3c (#3728, open)

3c's column-reorder path already does read-merge-write via `utils/reorder-view-fields.ts`; 3d generalizes the same
guarantee to the in-place facet edits via `utils/personal-config-write.ts`. Both are additive; when #3728 merges,
a later cleanup could dedupe the two read-merge-write helpers (noted, non-blocking). This PR branches off current
`origin/main` (which does not yet include #3728) — a trivial rebase may be needed depending on merge order.

## Posture

Default-OFF, no flag/backend/enablement change. Backend actor-isolation and `/context` overlay unchanged. Awaits
owner review + "合".
