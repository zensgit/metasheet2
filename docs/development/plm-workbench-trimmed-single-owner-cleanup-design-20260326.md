# PLM Workbench Trimmed Single Owner Cleanup Design

## Problem

Single `archive` and `delete` handlers for `team views` and `team filter presets` compared the current requested route
owner with the deleted or archived target using raw ref values.

`readQueryParam()` preserves whitespace, while selection and list lookup paths already normalize ids with `trim()`. That
left a gap where URLs like `?workbenchTeamView=%20view-1%20` or `?bomTeamPreset=%20preset-1%20` could apply correctly,
but later single-item cleanup would miss the equality check and leave a stale route owner in the URL.

## Decision

1. In single `delete` and `archive` handlers, normalize `requestedViewId` / `requestedPresetId` once with `trim()`.
2. Compare the normalized id against the canonical target id before deciding whether to clear the route owner.
3. Keep the rest of the lifecycle cleanup unchanged.

## Expected Behavior

- whitespace-padded route owners are still consumed after single `delete`
- whitespace-padded route owners are still consumed after single `archive`
- route-owner cleanup stays aligned with the already-trimmed selector/list lookup paths
