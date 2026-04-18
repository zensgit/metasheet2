## Background

The sheet ACL governance UI already surfaces inactive users in:

- current sheet ACL entries
- current record ACL entries
- eligible candidate rows
- current field/view subject rows

One visibility gap remained in the downstream cleanup path: orphan field/view overrides for inactive users only showed `No current sheet access`, which made them look the same as any generic orphaned override.

## Goal

Surface inactive lifecycle context on orphan field/view overrides so administrators can immediately tell when stale overrides belong to a disabled user account.

## Scope

- `MetaSheetPermissionManager`
- focused frontend regression coverage

## Implementation

### 1. Add inactive lifecycle badges to orphan field overrides

In `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`:

- reused `subjectMutationBlocked(orphan.subjectType, orphan.isActive)`
- added the existing `Inactive user` lifecycle badge to orphan field rows when the orphan subject is an inactive user

### 2. Add inactive lifecycle badges to orphan view overrides

In the same component:

- mirrored the same lifecycle badge on orphan view rows

This keeps the current cleanup flow unchanged while making the source of stale overrides easier to understand.

### 3. Extend regression coverage

Updated `apps/web/tests/multitable-sheet-permission-manager.spec.ts` with a focused test that verifies:

- inactive orphan field overrides show `Inactive user`
- inactive orphan view overrides show `Inactive user`
- both still show `No current sheet access`

## Files Changed

- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`

## Risk Notes

- frontend-only visibility change
- no backend semantic change
- no migration
- no deployment-step change
