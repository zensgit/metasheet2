# PLM Workbench team-view hydration selection design

## Problem

`team view` external hydration takeover already cleared stale selector and management drafts, but it still left batch selection behind.

That produced an inconsistent state:

- canonical route owner had already switched from `A` to `B`
- local batch archive/restore/delete still targeted stale selection from `A`

The asymmetry was especially visible because local preset hydration had already learned to trim stale `selectionKeys`, while team-view hydration still only toggled selector/draft fields.

## Design

Extend the team-view hydration helpers to reconcile the whole management state, not just selector text fields:

- `resolvePlmHydratedTeamViewOwnerTakeover(...)` now receives `localSelectionIds`
- takeover trims selection down to the authoritative route owner, or clears it when the selector drift proves the old selection is stale
- removed-owner hydration also trims selection, even when the local selector already points at another target
- drafts continue to clear only when the selector itself is stale, so create-mode drafts are still preserved

## Expected outcome

After external route hydration:

- team-view selector, drafts, and batch selection all describe the same canonical owner
- batch actions cannot keep operating on a stale pre-hydration selection
- `A -> B` and `A -> none` both follow the same authoritative cleanup model
