## Background

The previous slices already made inactive-user ACL rows cleanup-only:

- candidate rows cannot issue new grants
- current sheet and record rows cannot be mutated further
- field/view template and override rows for inactive users cannot be saved

That behavior was safe, but the UI still mostly communicated it only through disabled controls plus the `Inactive user` lifecycle badge.

## Goal

Make the cleanup-only state explicit wherever inactive-user ACL entries remain visible for governance cleanup.

## Scope

- `MetaSheetPermissionManager`
- `MetaRecordPermissionManager`
- focused frontend regression coverage

## Implementation

### 1. Add explicit cleanup-only hints to inactive sheet ACL rows

In `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`:

- added `Cleanup only` hints to inactive current sheet ACL rows
- added the same hint to inactive field template rows
- added the same hint to inactive field override rows
- added the same hint to inactive view template rows
- added the same hint to inactive view override rows

This keeps the existing disabled behavior but makes the intent obvious.

### 2. Add explicit cleanup-only hints to inactive record ACL rows

In `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`:

- added `Cleanup only` to inactive current record ACL rows
- added a small `meta-record-perm__hint` style for the explanatory label

### 3. Extend regression coverage

Updated:

- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
- `apps/web/tests/multitable-record-permission-manager.spec.ts`

The inactive-user tests now assert the presence of `Cleanup only` on current inactive entries and downstream inactive sheet rows.

## Files Changed

- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
- `apps/web/tests/multitable-record-permission-manager.spec.ts`

## Risk Notes

- frontend-only explanatory UX change
- no backend semantic change
- no migration
- no deployment-step change
