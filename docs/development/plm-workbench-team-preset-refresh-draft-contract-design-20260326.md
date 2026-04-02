# PLM Workbench Team Preset Refresh Draft Contract Design

## Goal

Lock the refresh semantics for `usePlmTeamFilterPresets.ts` so they stay aligned with the already-tested
team-view contract:

- when refresh removes the selected target, stale management drafts must be cleared
- when refresh runs in create-mode with no active target, local drafts must survive

## Contract

For team presets, the draft bundle is:

- `teamPresetName`
- `teamPresetGroup`
- `teamPresetOwnerUserId`

Refresh should behave as follows:

1. If the selected preset disappears or becomes non-applyable, clear the selected key and clear the full
   draft bundle.
2. If there is no active selected preset, refresh must not destroy create-mode drafts.

## Reasoning

This matches the intended split between:

- management-target state, which is owned by the currently selected preset
- local create-mode form state, which is user input not yet attached to a preset id

Without this contract, refresh can silently leak stale drafts onto the wrong preset target or erase
local create-mode work.

