## Background

The previous inactive-candidate guard blocked new ACL grants to inactive users from sheet and record candidate lists. One governance gap still remained: if an inactive user already had ACL entries, operators could still continue editing those existing sheet or record permissions, and in the sheet manager they could still author downstream field/view overrides and bulk templates for those inactive identities.

## Goal

Make inactive-user ACL entries cleanup-only:

- keep inactive users visible
- keep removal and override cleanup available
- block further mutation of current sheet/record ACL levels
- block new field/view overrides and bulk template application for inactive users

## Scope

- `MetaSheetPermissionManager`
- `MetaRecordPermissionManager`
- focused frontend regression coverage

## Implementation

### 1. Lock current sheet ACL entries for inactive users

In `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`:

- added `subjectMutationBlocked(subjectType, isActive)`
- disabled the current sheet-entry access `<select>` and `Save` button for inactive user rows
- left `Remove` and `Clear overrides` available so cleanup still works

### 2. Lock downstream field/view governance for inactive users

In the same component:

- disabled field bulk-template select/apply for inactive user subjects
- disabled field row select/save for inactive user subjects
- disabled view bulk-template select/apply for inactive user subjects
- disabled view row select/save for inactive user subjects
- surfaced `Inactive user` markers on those field/view rows so the disabled state has a visible explanation

### 3. Lock current record ACL entries for inactive users

In `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`:

- disabled the current record-entry access `<select>` and `Save` button for inactive user rows
- kept `Remove` available so stale grants can still be revoked

## Files Changed

- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
- `apps/web/tests/multitable-record-permission-manager.spec.ts`

## Risk Notes

- frontend-only governance hardening
- no backend semantic change
- no migration
- no deployment-step change
