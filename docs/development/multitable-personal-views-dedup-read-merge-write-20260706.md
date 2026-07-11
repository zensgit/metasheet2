# Personal views — read-merge-write DEDUP (post-3c/3d cleanup) — VERIFICATION — 2026-07-06

> **Cleanup, not a new feature.** Collapses the two copies of the personal-config read-merge-write (Slice 3c's
> reorder path + Slice 3d's in-place-edit helper) into a **single entry point**, so the security-sensitive
> **fail-closed** guard (non-404 GET must not blind-PUT) can never drift on one side. No backend, no flag, no
> enablement, no shared-path change. Default-OFF unchanged. Grounded on `origin/main` @ `ea62caaf8`.

## What changed

- **Single read-merge-write entry point:** `utils/personal-config-write.ts` `writePersonalConfigMerged(client,
  viewId, patch)` is now the ONLY implementation of "merge this patch over the actor's current personal config"
  (GET current → `{ ...base, ...patch }` → PUT; **404 ⇒ start empty; any other GET error ⇒ re-throw, no PUT**).
- **`reorderViewFields` delegates its write:** the personal path keeps its own **C1 routing** (isPersonal branch,
  `moveWithin` over the visible order, `onPersonalOrder` optimistic apply, **never** `updateField`) but its inline
  GET-merge-PUT is replaced by `await writePersonalConfigMerged(params.client, params.viewId, { fieldOrder })`.
- **`ReorderClient` now `extends PersonalConfigWriteClient`** (+ `updateField`), removing the duplicated
  get/put method shapes — the reorder client IS the shared write client plus the shared-order write.

The shared (personal-off) path and the backend are untouched.

## Two layers of teeth (both retained)

- **Shared helper** — `multitable-grid-personal-additive-write.spec.ts` (8): 404 creates; **non-404 rejects + no
  PUT**; single-facet edit preserves the other facets; clear-via-undefined; grid wiring.
- **Reorder path** — `multitable-reorder-view-fields.spec.ts` (8): personal ON ⇒ `putPersonalViewConfig`, **shared
  `updateField` asserted NOT called**; `fieldOrder` write still preserves other facets; **non-404 fail-closed**;
  OFF ⇒ shared `updateField` path. These now exercise the delegated shared helper, proving the reorder path is
  wired to it (not a divergent copy).

Run: `cd apps/web && npx vitest run tests/multitable-reorder-view-fields.spec.ts
tests/multitable-grid-personal-additive-write.spec.ts` → **16 passed**. Regression: `multitable-grid` → **133
tests pass**. vue-tsc clean. Both specs are already in the `multitable-web-guard` `multitable-grid` /
`multitable-reorder-view-fields` filter (no workflow change).

## Posture

FE-only refactor; behavior identical (delegation is byte-for-byte the prior read-merge-write). Personal-views
stays **default-OFF**; flag enablement remains separately **owner-gated** (checklist §B) — not touched here.
