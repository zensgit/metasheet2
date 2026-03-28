# PLM Workbench Archived Apply Hard Gating Design

## Context

`team preset apply` already had a second archived guard in its handler, so an archived preset could not be applied even if explicit permissions still exposed `canApply: true`.

The shared helper `canApplyPlmCollaborativeEntry(...)` did not treat `archived` as a hard stop. That left `team view` apply open to a bypass: archived entries with explicit `permissions.canApply = true` still looked applyable.

## Problem

- `team view` and `team preset` apply semantics diverged for archived entries.
- The shared `canApply` helper allowed explicit permissions to override archived state.
- UI actionability and handler behavior could drift: archived entries could appear applyable even though restore-first should be mandatory.

## Decision

Make `archived` a hard gate in `canApplyPlmCollaborativeEntry(...)`:

1. Return `false` immediately when `entry.isArchived` is truthy.
2. Only evaluate explicit `permissions.canApply` for non-archived entries.

## Expected Result

- Archived collaborative entries are never applyable.
- `team view` and `team preset` button state and handler state align on restore-first semantics.
- Explicit `canApply` permissions no longer bypass archived gating.
