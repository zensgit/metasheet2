# PLM Workbench Team Preset Lifecycle Draft Cleanup Design

## Problem

`teamPresetName`, `teamPresetGroup`, and `teamPresetOwnerUserId` are editable drafts for create, rename,
grouping, and transfer-owner flows. After preset lifecycle actions such as:

- duplicate
- rename
- restore
- batch restore

the composable previously re-applied the restored preset identity but left stale editable draft state behind.

That created two bad outcomes:

- a later `save team preset` could silently inherit the previous preset's `group`
- archived preset transfer validated the owner input first instead of blocking on restore-first lifecycle rules

## Decision

Align team preset lifecycle behavior with team view lifecycle behavior:

1. Reuse `clearTeamPresetDrafts()` after duplicate, rename, restore, and batch restore.
2. Keep the restored/applied preset identity, but do not preserve stale editable drafts.
3. In `transferTeamPreset()`, block archived presets before validating `teamPresetOwnerUserId`.

## Expected Behavior

- duplicate/rename/restore no longer leave `name/group/owner` drafts armed
- batch restore of the active preset clears stale drafts while keeping the restored preset selected
- archived presets show a restore-first transfer message and never call the transfer API
