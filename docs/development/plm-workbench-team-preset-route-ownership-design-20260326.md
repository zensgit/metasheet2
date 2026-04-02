# PLM Workbench Team Preset Route Ownership Design

## Problem

BOM and Where-Used team presets expose explicit route ownership through:

- `bomTeamPreset`
- `whereUsedTeamPreset`

The preset composable keeps those ids alive and can re-apply them on refresh/hydration. But local filter
editing previously only updated:

- `bomFilter`
- `bomFilterField`
- `whereUsedFilter`
- `whereUsedFilterField`

That meant the URL could keep claiming a collaborative team preset owner even after the live filter state
had drifted away from that preset.

## Decision

Align team preset ownership with the existing panel team-view ownership model:

1. Introduce an explicit snapshot matcher for preset state using only:
   - `field`
   - `value`
   - `group`
2. In `PlmProductView.vue`, watch BOM and Where-Used route-owned team presets.
3. If local preset state no longer matches the active route-owned preset snapshot, clear the corresponding
   route owner:
   - `bomTeamPreset`
   - `whereUsedTeamPreset`

## Expected Behavior

- Applying a team preset keeps the route owner.
- Manual filter edits consume the stale route owner.
- Shared links and reload hydration no longer snap back to an old preset after local drift.

