## Background

The multitable ACL governance UI already surfaced inactive users in sheet and record ACL entries so administrators could see stale grants. That visibility improvement still left one gap: inactive users remained grantable from the ACL candidate lists, which meant operators could accidentally issue fresh sheet or record access to disabled accounts.

## Goal

Keep inactive users visible in ACL candidate results for governance transparency, but block new grants from those inactive user rows.

## Scope

- Sheet ACL candidate rows in `MetaSheetPermissionManager`
- Record ACL candidate rows in `MetaRecordPermissionManager`
- Focused UI regression coverage for both managers

## Implementation

### 1. Block new grants to inactive sheet ACL candidates

In `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`:

- reused the existing `subjectIsInactive(...)` helper
- added `candidateGrantBlocked(candidate)`
- disabled both the candidate access-level `<select>` and the `Apply` button when the candidate is an inactive user

This preserves visibility while preventing new ACL authoring against disabled user identities.

### 2. Block new grants to inactive record ACL candidates

In `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`:

- mirrored the same `candidateGrantBlocked(candidate)` behavior
- disabled both the candidate access-level `<select>` and the `Grant` button for inactive user candidates

### 3. Extend governance regression coverage

Updated:

- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
- `apps/web/tests/multitable-record-permission-manager.spec.ts`

The existing inactive-subject visibility assertions now also verify that inactive user candidate rows are non-interactive for new grants.

## Files Changed

- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
- `apps/web/tests/multitable-record-permission-manager.spec.ts`

## Risk Notes

- Frontend-only change
- No backend semantic change
- No migration
- No deployment-step change
