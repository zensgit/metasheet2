# PLM Workbench Local Preset Hydration Takeover Design

## Background

`BOM / Where-Used` local preset route owners already had stale-owner cleanup, but they still lacked authoritative route-to-route takeover handling.

That left a real mismatch on external deep-link or browser-history pivots:

- route owner changed from local preset `A` to local preset `B`
- filter state followed `B`
- local selector / rename drafts could still remain on `A`

So the page looked like it was editing preset `A` while the route owner had already switched to `B`.

## Design

Mirror the existing team-preset hydration takeover contract with a local-preset version:

1. Add `resolvePlmHydratedLocalFilterPresetTakeover(...)`.
2. During `applyQueryState()`:
   - before assigning `bomFilterPresetQuery` / `whereUsedFilterPresetQuery`
   - compare the hydrated route preset key with the current local selector key
3. When the route owner moved to a different local preset:
   - clear local selector key
   - clear local name draft
   - clear local group draft
   - keep the incoming route owner intact

## Expected Outcome

External `A -> B` local preset deep-links now behave authoritatively:

- the route owner becomes `B`
- stale local management state from `A` is cleared immediately
- users do not end up editing the wrong local preset after hydration
