# PLM Workbench Transfer Readonly Draft Cleanup Design

## Background

`team view` and `team preset` transfer flows already clear the owner input after success. However, a successful transfer can also turn the current target into a readonly entry for the current user.

## Problem

When the transferred entry came back with `canManage = false`, the UI kept stale rename and grouping drafts in memory:

- `usePlmTeamViews.ts` kept `teamViewName`
- `usePlmTeamFilterPresets.ts` kept `teamPresetName` and `teamPresetGroup`

The management area was hidden because the target was now readonly, but the stale drafts remained attached to the same selected key and could leak into later flows.

## Decision

On transfer success:

- if the returned entry is still manageable, preserve existing behavior and only clear the owner input
- if the returned entry is no longer manageable, clear the full management draft set for that entry

This keeps post-transfer readonly targets aligned with the rest of the cleanup contract: readonly targets should not retain stale management drafts.
