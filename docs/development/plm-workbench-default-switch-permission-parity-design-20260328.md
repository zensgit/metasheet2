# PLM Workbench Default Switch Permission Parity Design

Date: 2026-03-28

## Problem

After `set default` completed successfully, the newly-default item was updated in local state, but the previously-default item only had `isDefault` flipped to `false`.

That left a stale local permission shape on the old item:

- `permissions.canSetDefault` could stay `false`
- `permissions.canClearDefault` could stay `true`

Because `usePlmCollaborativePermissions.ts` prefers explicit granular permissions over derived fallback logic, the UI could show the previous default item with the wrong default-management affordances until the next refresh.

## Scope

This affects both collaborative collections that use the same local default-switch patching pattern:

- `apps/web/src/views/plm/usePlmTeamViews.ts`
- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`

## Design Goal

Make default switching locally authoritative:

- the new default item should immediately become `isDefault: true`
- the previous default item should immediately become:
  - `isDefault: false`
  - `permissions.canSetDefault: true` when it is still manageable and active
  - `permissions.canClearDefault: false`

## Decisions

1. Keep the fix entirely in frontend local state reconciliation.
2. Only patch the previous default entry during `applyDefaultTeamViewUpdate(...)` / `applyDefaultPresetUpdate(...)`.
3. Preserve all other permission fields and only rewrite the two default-specific granular flags.
4. Use existing local `canManage` / `permissions.canManage` and `isArchived` state to compute the demoted permissions, matching current derived permission semantics.

## Non-Goals

- Changing backend default route behavior
- Recomputing every granular permission locally
- Introducing a refresh after every default toggle
