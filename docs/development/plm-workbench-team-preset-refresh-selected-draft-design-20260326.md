# PLM Workbench Team Preset Refresh Selected Draft Design

## Problem

`usePlmTeamFilterPresets.refreshTeamPresets()` already clears the selected preset key when the current preset disappears
or loses `canApply`, but it used to leave `teamPresetName`, `teamPresetGroup`, and `teamPresetOwnerUserId` untouched.

That meant refresh could demote the selected collaborative target to nothing while still leaving rename/group/transfer
drafts bound to a preset that was no longer selectable.

## Decision

1. Reuse the existing `clearTeamPresetDrafts()` helper when the selected preset becomes missing or non-applyable during
   refresh.
2. Keep create-mode drafts unchanged; only selected collaborative target loss triggers this cleanup.

## Expected Behavior

- if the selected team preset disappears on refresh, its management drafts are cleared
- if the selected team preset remains but loses `canApply`, its management drafts are also cleared
- create-mode drafts with no active selected preset are still preserved
