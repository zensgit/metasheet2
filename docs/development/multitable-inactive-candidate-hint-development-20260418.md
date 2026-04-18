## Background

The previous inactive-candidate guard already blocked new ACL grants to inactive user candidates in both sheet and record ACL managers. The disabled controls were safe, but the candidate rows still only showed `Inactive user`, which did not explicitly explain why the primary action was unavailable.

## Goal

Make the blocked state self-explanatory on inactive candidate rows by showing an explicit `Grant blocked` hint.

## Scope

- `MetaSheetPermissionManager`
- `MetaRecordPermissionManager`
- focused frontend regression coverage

## Implementation

### 1. Add blocked-grant hints to inactive sheet candidates

In `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`:

- reused the existing `candidateGrantBlocked(candidate)` helper
- added a `Grant blocked` hint beside the existing `Inactive user` lifecycle badge on inactive candidate rows

### 2. Add blocked-grant hints to inactive record candidates

In `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`:

- mirrored the same `Grant blocked` hint on inactive candidate rows

### 3. Extend regression coverage

Updated:

- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
- `apps/web/tests/multitable-record-permission-manager.spec.ts`

The inactive candidate assertions now verify the new explanatory hint in both managers.

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
