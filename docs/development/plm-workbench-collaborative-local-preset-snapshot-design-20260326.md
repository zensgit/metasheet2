# PLM Workbench Collaborative Local Preset Snapshot Design

## Problem

`workbenchTeamView` snapshots previously preserved local preset ownership keys:

- `bomFilterPreset`
- `whereUsedFilterPreset`

Those ids are browser-local, not collaborative state. If a saved/shared workbench team view was opened in a
browser that did not have the referenced local presets, hydration would still restore the concrete
`bomFilter/bomFilterField` or `whereUsedFilter/whereUsedFilterField`, but the missing preset ids would be dropped
locally. The route-owner drift matcher then compared the live query against the original collaborative snapshot
and incorrectly cleared `workbenchTeamView`.

## Decision

Define collaborative workbench query snapshots as:

- all supported workbench route state
- excluding `workbenchTeamView` identity
- excluding browser-local `bomFilterPreset` / `whereUsedFilterPreset` ownership

Apply that normalization consistently in:

1. `buildWorkbenchTeamViewState()`
2. `applyWorkbenchTeamViewState(...)`
3. `matchPlmWorkbenchQuerySnapshot(...)`
4. `buildPlmWorkbenchTeamViewShareUrl(...)`

## Expected Behavior

- saved/shared workbench team views no longer depend on local preset keys existing in the target browser
- hydration preserves concrete filter state but not browser-local preset ownership
- the route-owner drift watcher keeps `workbenchTeamView` alive when only local preset ids are missing
- share URLs for collaborative workbench views include concrete filter state, not local preset ids
