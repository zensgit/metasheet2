# PLM Workbench Local Preset Route Ownership Design

## Problem

`bomFilterPreset` and `whereUsedFilterPreset` are local collaborative identities stored in the route.

Before this change, manual filter edits only updated:

- `bomFilter`
- `bomFilterField`
- `whereUsedFilter`
- `whereUsedFilterField`

but did not consume the stale local preset owner in the route. After reload or hydration, the old local preset
could be re-applied on top of the user’s manual edits.

There was also a second edge case: if the user had already picked a different preset in the selector but had
not applied it yet, clearing the stale route owner should not wipe that pending local selector target.

## Decision

1. Introduce a pure helper that resolves local preset route ownership from:
   - route preset key
   - selected preset key
   - active preset snapshot
   - live `field/value` filter state
2. In `PlmProductView.vue`, watch BOM and Where-Used local preset route owners.
3. When live filter state drifts away from the route-owned preset:
   - clear `bomFilterPreset` / `whereUsedFilterPreset`
   - clear the local selector only when it still points at the same stale owner
   - preserve a different pending selector target

## Expected Behavior

- shared or deep-linked local preset ids stay in the route only while the live filter still matches them
- manual filter edits consume stale local preset owners
- refresh no longer rehydrates an outdated local preset over the user’s current filter state
- pending selector targets survive stale route-owner cleanup
