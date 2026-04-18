# Multitable Orphan Bulk Cleanup Development 2026-04-18

## Goal

Reduce repetitive cleanup work in the field/view permission managers by allowing operators to clear orphan overrides in bulk per field or per view.

## Scope

- add `Clear orphan overrides` for field groups when a field has multiple orphan overrides
- add `Clear orphan overrides` for view groups when a view has multiple orphan overrides
- keep the slice frontend-only and reuse existing field/view permission authoring APIs

## Files Changed

- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`

## Implementation Notes

1. Added grouped cleanup actions inside field/view section headers.
2. Introduced small bulk-busy states so batch cleanup does not overlap with per-row writes.
3. Implemented:
   - `clearFieldOrphans(fieldId)`
   - `clearViewOrphans(viewId)`
4. Reused existing:
   - `updateFieldPermission(..., { remove: true })`
   - `updateViewPermission(..., 'none')`

## Why This Slice

`#904` made orphan overrides visible and individually clearable. `#907` then linked sheet subjects to downstream cleanup. The remaining operational gap was still obvious: a field or view with many orphan overrides required many repetitive clicks. This slice closes that cleanup loop without changing ACL semantics.
