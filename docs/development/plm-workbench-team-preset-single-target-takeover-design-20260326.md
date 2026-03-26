# PLM Workbench Team Preset Single Target Takeover Design

## Context

`usePlmTeamFilterPresets()` supports batch lifecycle actions through `teamPresetSelection`, but several single-target actions also replace the active preset owner:

- `Apply`
- `Save`
- `Duplicate`
- `Promote to team`
- `Promote to default team`

Before this change, those actions switched the active target without clearing the existing batch selection. That left the UI in a mixed state:

- the selector and route owner pointed at one preset
- batch actions still targeted an older selection set

`usePlmTeamViews()` had already aligned single-target takeovers by clearing batch selection first. Team presets needed the same rule.

## Goal

When a preset action takes over the screen with one concrete target, the batch selection must be cleared first.

## Implementation

In `/apps/web/src/views/plm/usePlmTeamFilterPresets.ts`:

1. Added `clearSingleTargetTakeoverSelection()`.
2. Called it before switching to the new target in:
   - `saveTeamPreset()`
   - `promoteFilterPresetToTeam()`
   - `promoteFilterPresetToTeamDefault()`
   - `applyTeamPreset()`
   - `duplicateTeamPreset()`

## Expected Behavior

- after `Apply`, old batch selection is gone
- after `Save` or `Duplicate`, old batch selection is gone
- after local preset promotion, old batch selection is gone
- subsequent batch lifecycle actions cannot accidentally act on stale rows

