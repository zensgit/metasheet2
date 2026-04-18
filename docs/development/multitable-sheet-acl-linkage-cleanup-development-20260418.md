# Multitable Sheet ACL Linkage Cleanup Development 2026-04-18

## Goal

Close a governance gap in the sheet access manager: when a subject still has field/view overrides, surface that linkage directly on the sheet access row and allow one-click downstream cleanup without forcing operators to hunt through orphan rows later.

## Scope

- show per-subject downstream override counts on the sheet access list
- add a `Clear overrides` action for subjects that still own field/view overrides
- keep the slice frontend-only and reuse existing field/view authoring APIs

## Files Changed

- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`

## Implementation Notes

1. Added subject-level override counting derived from existing `fieldPermissionEntries` and `viewPermissionEntries`.
2. Exposed a summary hint on each sheet access row when the subject still owns downstream overrides.
3. Added a `Clear overrides` action that:
   - removes matching field overrides via `updateFieldPermission(..., { remove: true })`
   - clears matching view overrides via `updateViewPermission(..., 'none')`
4. Reused `busySubjectKey` and existing status/error surfaces so the slice stays consistent with the rest of the manager.

## Why This Slice

`#904` made orphan field/view overrides visible and individually clearable. The remaining operational gap was still real: removing or refactoring a sheet subject could leave many lower-level overrides behind. This slice closes that last cleanup loop without inventing a new ACL model.
