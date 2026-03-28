# PLM Workbench Team Preset Transfer Target Gating Design

Date: 2026-03-28

## Problem

`usePlmTeamFilterPresets.ts` already computed transfer actionability, but the contract stopped short in two places:

1. the composable did not expose `canTransferTarget` to the BOM / Where-Used panels
2. archived team presets could still surface `canTransferTarget/canTransfer = true` when `permissions.canTransfer = true`, even though the handler later rejected the action with a restore-first message

That produced a visible UI mismatch:

- owner input stayed editable
- transfer button could look actionable
- the actual transfer still failed only after the click

## Goal

Align team preset transfer UI with existing team view semantics:

- if the current target cannot accept transfer, the owner input must be disabled
- if the preset is archived, transfer target actionability must be false before the handler runs

## Design

1. Expose `canTransferTargetTeamPreset` from `usePlmTeamFilterPresets.ts`.
2. Normalize team preset transfer actionability so archived presets always report:
   - `canTransferTargetTeamPreset = false`
   - `canTransferTeamPreset = false`
3. Thread the new target-level flag through:
   - `PlmProductView.vue`
   - `plmPanelModels.ts`
4. Bind the BOM / Where-Used owner inputs to the target-level disabled state, matching the existing `PlmTeamViewsBlock.vue` pattern.

## Non-Goals

- changing the restore-first message path in the transfer handler
- changing backend transfer behavior
- changing batch transfer semantics
