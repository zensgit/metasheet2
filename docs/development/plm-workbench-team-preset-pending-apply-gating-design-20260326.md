# PLM Workbench Team Preset Pending Apply Gating Design

## Context

`usePlmTeamFilterPresets()` already exposed a split interaction model:

- the selector can move to a different team preset immediately
- the canonical applied preset is only updated after `Apply`

Before this change, generic management actions still targeted the selector entry directly. That created a drift window where:

- `Share`
- `Rename`
- `Transfer owner`
- `Delete`
- `Archive`
- `Restore`
- `Set default`
- `Clear default`

could mutate preset `B` while the route and applied state still belonged to preset `A`.

`usePlmTeamViews()` had already closed the same gap with a pending-apply ownership model. Team presets needed the same contract.

## Goal

Align `team filter presets` with `team views`:

- generic management actions must stay pinned to the canonical applied preset
- a pending selector target must not become manageable until the user clicks `Apply`
- `Apply` and `Duplicate` must stay available for the pending selector target
- readonly canonical owners must still hide management controls during selector drift

## Implementation

In `/apps/web/src/views/plm/usePlmTeamFilterPresets.ts`:

1. Added canonical/pending state helpers:
   - `requestedTeamPreset`
   - `hasPendingApplySelection`
   - `selectedManagementTarget`
   - `visibleManagementTarget`

2. Rebound `usePlmCollaborativePermissions(...)` from `selectedTeamPreset` to `selectedManagementTarget`.

3. Recomputed `showManagementActions` from `visibleManagementTarget`, so the UI still reflects the canonical owner while the selector is drifting.

4. Added `blockPendingApplyManagementAction()` with a preset-specific message:
   - `请先应用${label}团队预设，再执行管理操作。`

5. Applied that guard to generic management actions only:
   - `shareTeamPreset`
   - `renameTeamPreset`
   - `transferTeamPreset`
   - `deleteTeamPreset`
   - `setTeamPresetDefault`
   - `clearTeamPresetDefault`
   - `archiveTeamPreset`
   - `restoreTeamPreset`

6. Left `applyTeamPreset()` and `duplicateTeamPreset()` bound to the selector target.

## Expected Behavior

- If canonical route owner is `A` and the selector changes to `B` without apply:
  - `Apply` works on `B`
  - `Duplicate` works on `B`
  - generic management actions are blocked
- If canonical owner `A` is readonly and selector drifts to manageable `B`:
  - management controls remain hidden
  - `Apply` and `Duplicate` still remain actionable for `B`

