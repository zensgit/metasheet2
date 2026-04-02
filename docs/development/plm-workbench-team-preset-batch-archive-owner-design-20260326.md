# PLM Workbench Team Preset Batch Archive Owner Design

## Context

`team filter presets` batch lifecycle handling had already been updated so batch `restore` would not hijack a different canonical route owner. The `archive/delete` side was still slightly looser.

## Problem

When the canonical requested preset stayed on `A`, but the local selector drifted to `B`, batch archiving `B` already preserved `requestedPresetId = A`. But the local management drafts tied to `B` were not fully cleared:

- `teamPresetName`
- `teamPresetGroup`
- `teamPresetOwnerUserId`

That left stale management form state on screen after the selector target had been invalidated.

## Goal

Keep batch archive/delete semantics aligned with `team views`:

- preserve the canonical requested owner when only a pending local selector target is processed
- clear local selector-owned drafts when that processed selector target is removed from active management

## Implementation

In `/apps/web/src/views/plm/usePlmTeamFilterPresets.ts`:

1. Added `clearTeamPresetDrafts()`.
2. Reused it in the non-restore branch of `runBatchTeamPresetAction(...)`.
3. Kept the restore branch unchanged:
   - restore still rehydrates only the correct canonical owner
   - non-restore actions still clear `teamPresetKey` when the selected local target is processed

