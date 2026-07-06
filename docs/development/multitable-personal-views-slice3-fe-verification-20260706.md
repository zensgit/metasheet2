# Personal views — Slice 3 (FE personalize toggle) — VERIFICATION — 2026-07-06

> Implements the ratified design-lock `multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md`
> (#3705). **Default-OFF; NOT enable-ready.** The flag `MULTITABLE_ENABLE_PERSONAL_VIEWS` stays unset — this
> slice adds the FE surface only, gated on the flag-derived session capability. Grounded on `origin/main`
> after #3656/#3657/#3705 merged.

## What shipped

- **Client methods (no identity — LOAD-BEARING §1-A):** `getPersonalViewConfig` / `putPersonalViewConfig` /
  `deletePersonalViewConfig` in `apps/web/src/multitable/api/client.ts`, using the same `this.fetch` path as
  `updateView`/`deleteView`. They add **no** `userId`/`user_id` body field, query param, or `x-user-id` header;
  `apiFetch`/`authHeaders()` inject only `Authorization` + `x-tenant-id` (`apps/web/src/utils/api.ts:147-161`).
  The server resolves the target user from the JWT actor alone.
- **Enablement signal (§7 Q1 — no client env const):** backend `/context` now returns
  `capabilities.personalViewsEnabled = isPersonalViewsEnabled()` (`packages/core-backend/src/routes/univer-meta.ts`),
  mirroring the existing `pitResetEnabled` flag-visibility precedent. Available to every reader (P1: presentation-
  only, no per-view opt-in) — so, unlike `pitResetEnabled`, it is NOT additionally ANDed with a management
  capability. The FE reads it via `MetaCapabilities.personalViewsEnabled` (`types.ts`); default `false`.
- **Toggle + write-routing composable:** `apps/web/src/multitable/composables/usePersonalViewToggle.ts` —
  per-view, in-memory, session-local UI state. `enabled()` mirrors the capability so a flag-off session can never
  latch personal mode on (defensive guard even against a mid-session capability flip). Exposes `isPersonalMode`,
  `togglePersonalMode`, `resetToShared`, `persistViewEdit`.
- **Write-target routing (§3 P2 / G-FE-2):** a single switch `persistViewConfig` in
  `apps/web/src/multitable/composables/useMultitableGrid.ts` — the three in-place config edits (sort/filter, group,
  hidden) funnel through it. Personal mode ON → `putPersonalViewConfig`; OFF/absent → shared `updateView`,
  byte-identical to pre-Slice-3.
- **UI:** a per-view "My view / 个人视图" toggle rendered ONLY next to the active tab when enabled
  (`MetaViewTabBar.vue`), and a "Reset to shared / 恢复为共享视图" action rendered only while personal mode is on
  (`MetaToolbar.vue`). Reset = `DELETE …/personal-config` then re-fetch (`loadSheetMeta`) so the server returns the
  now-effective (shared) config; never mutates the shared view. Glue in `MultitableWorkbench.vue`.

## Goldens (vitest, `apps/web`) — 17 tests, all GREEN locally

| Golden | File | Asserts |
|---|---|---|
| **G-FE-1** (load-bearing) | `tests/multitable/personal-view-client.test.ts` | every personal-config request carries no `userId`/`user_id`/`x-user-id` in path, headers, or body; PUT sends a `{ config }` envelope only; viewId URI-encoded; 404 → typed error |
| **G-FE-2** | `tests/multitable-personal-view-toggle.spec.ts` | toggle ON → edit calls `putPersonalViewConfig`; OFF → shared `updateView`; per-view (one view ON doesn't affect another) |
| **G-FE-3** | `tests/multitable-personal-view-toggle.spec.ts` | reset → `DELETE …/personal-config` BEFORE refetch, clears local personal mode |
| **G-FE-4** | `tests/multitable-personal-view-toggle.spec.ts` + `tests/meta-view-tab-bar-personal-toggle.spec.ts` | disabled session can never latch personal mode ON, emits no personal-config request; toggle absent from DOM when `personalViewsEnabled` off |

Run: `cd apps/web && npx vitest run tests/multitable/personal-view-client.test.ts tests/multitable-personal-view-toggle.spec.ts tests/meta-view-tab-bar-personal-toggle.spec.ts` → **3 files, 17 passed**. The FE test job runs `vitest run` (default recursive glob), so these are picked up in CI with no workflow change.

## Observed-RED (bidirectional teeth) — G-FE-1 CONFIRMED

Reverted the guard by smuggling a `userId` into the client's PUT body
(`body: JSON.stringify({ config: overlay, userId: 'actor' })`) and re-ran the client golden:

```
FAIL  tests/multitable/personal-view-client.test.ts > … G-FE-1 identity-leak guard >
      putPersonalViewConfig PUTs a { config } envelope with no identity anywhere in the request
AssertionError: expected { config: { …(2) }, userId: 'actor' } to deeply equal { config: { …(2) } }
 Tests  1 failed | 5 passed (6)
```

Restoring the body (`{ config: overlay }`) returns the file to **6 passed**. Green-with-guard + red-without =
the identity-leak golden has real teeth, executed locally (not a synthetic demonstration).

## Explicitly DEFERRED — G-FE-5 (unknown-`fieldOrder` fail-soft) → Slice 3b

The reviewer asked (correctly) to guard that an unknown/missing `fieldOrder` id is ignored / does not crash the
FE. **There is currently no FE consumer of `fieldOrder`:** the only references in `apps/web/src/multitable/` are
the type declarations added here; nothing reads `view.fieldOrder` to reorder columns. Slice 2 landed the
server-side field-order overlay as backend plumbing — the FE does not yet render per-user field order. A
fail-soft test with no live consumer would be vacuous. **G-FE-5 therefore ships WITH the field-order-rendering
consumer in Slice 3b** (the follow-up that makes `view.fieldOrder` actually drive column order, with unknown/
stale ids filtered against the current field list). This is a documented deferral, not a silent drop.

## Enablement posture

- Flag stays **OFF**. This slice is NOT enable-ready.
- Before any flag-on, re-run `multitable-personal-views-flag-on-checklist-20260705.md` §B (it calls for a re-run
  per slice) — this slice adds FE read/write surfaces (`personal-config` PUT/DELETE from the client).
- Backend actor-isolation (G-A/G-C) is unchanged by Slice 3 and already banked by Slice 1's observed-RED (#3639).
