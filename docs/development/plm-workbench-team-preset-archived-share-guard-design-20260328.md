# PLM Workbench Team Preset Archived Share Guard Design

## Context

`team view` share already treats archived entries as a hard restore-first boundary.
`team preset` share still relied on `canShareTeamPreset` to reach that branch.

Because `canSharePlmCollaborativeEntry(...)` honors explicit `permissions.canShare`, an archived preset with `canShare: true` could bypass restore-first gating and continue into share URL generation.

## Problem

- `team preset` share and `team view` share had different archived-entry behavior.
- Explicit share permissions could override archived gating for presets.
- The resulting behavior was real runtime drift, not just wording drift.

## Decision

Move archived gating to the top of `shareTeamPreset()`:

1. Resolve the selected preset.
2. Block pending management state.
3. If `preset.isArchived`, stop immediately with restore-first feedback.
4. Only then evaluate `canShareTeamPreset`.

## Expected Result

- Archived presets never enter share URL generation or clipboard copy.
- `team preset` share now matches `team view` share semantics.
- Explicit `permissions.canShare` no longer bypass archived restore-first gating.
