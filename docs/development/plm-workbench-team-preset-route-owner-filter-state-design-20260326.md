# PLM Workbench Team Preset Route Owner Filter State Design

## Background

`bomTeamPreset` and `whereUsedTeamPreset` route owners are meant to describe the active collaborative filter state for the current panel. The current route-owner drift watcher compared `field`, `value`, and `group`.

That was too broad. `group` is preset metadata used for organizing and drafting presets in the UI. It is not part of the live filter result set. Editing the group draft while a team preset route owner was active could incorrectly clear the canonical route owner even though the effective filter state had not changed.

## Decision

Treat team preset route ownership as a projection over filter-bearing state only:

- keep `field`
- keep `value`
- ignore `group`
- ignore future metadata-only keys

To make that contract explicit and reusable:

- add `pickPlmTeamFilterPresetRouteOwnerState(...)`
- reuse it in both local preset route-identity logic and team preset route-owner drift checks

## Expected Outcome

- editing local preset grouping metadata no longer clears `bomTeamPreset` / `whereUsedTeamPreset`
- manual edits to actual filter state still clear stale route owners
- future metadata-only state additions do not silently destabilize route-owner matching
