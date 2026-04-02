# PLM Workbench Team Preset Refresh Owner Trim Design

## Problem

`usePlmTeamFilterPresets.refreshTeamPresets()` previously checked `requestedPresetId` using the raw ref value.

That was inconsistent with the rest of the preset stack:

- requested preset lookup already uses `trim()`
- apply/default fallback paths already use canonical preset ids
- single lifecycle cleanup now trims route owners before clearing them

As a result, a URL like `?bomTeamPreset=%20preset-explicit%20` could still point to a valid collaborative preset, but
refresh would classify it as stale before the explicit preset had a chance to win over the default preset.

## Decision

1. Normalize `requestedPresetId` once at the start of `refreshTeamPresets()`.
2. Reuse that canonical id for:
   - stale-owner detection
   - pending selector cleanup decisions
3. Keep the rest of refresh semantics unchanged.

## Expected Behavior

- whitespace-padded preset route owners still count as valid explicit targets
- explicit preset owners continue to win over default auto-apply after refresh
- stale-owner cleanup remains aligned with selector lookup and lifecycle cleanup paths
