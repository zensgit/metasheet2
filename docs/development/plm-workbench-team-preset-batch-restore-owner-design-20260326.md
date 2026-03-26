# PLM Workbench Team Preset Batch Restore Owner Design

## Context

`team filter presets` already support a split state model:

- selector target: local UI choice
- requested preset id: canonical route owner

After pending selector gating was added, single-target management actions no longer hijacked the canonical owner. But batch `restore` still did.

## Problem

When the route owner stayed on preset `A`, and the local selector drifted to archived preset `B`, batch restoring `B` would:

- restore `B`
- immediately call `applyPresetToTarget(B)`
- overwrite the canonical `requestedPresetId` from `A` to `B`

That meant a batch restore side effect could silently switch the active team preset.

## Goal

Keep batch restore aligned with `usePlmTeamViews()`:

- if the processed restore target is also the canonical requested owner, reapply it
- if the processed restore target is only a pending local selector, do not hijack the route owner

## Implementation

In `/apps/web/src/views/plm/usePlmTeamFilterPresets.ts`:

1. Capture:
   - `selectedIdBeforeAction`
   - `requestedPresetIdBeforeAction`

2. After restore:
   - compute `processedRequestedId`
   - only reapply a restored preset when the requested owner itself was processed
   - if there is still a surviving requested owner and only the local selector target was restored, skip `applyPresetToTarget(...)`

3. Keep delete/archive behavior unchanged:
   - processed requested owner still clears route identity

