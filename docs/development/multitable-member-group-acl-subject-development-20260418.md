# Multitable Member Group ACL Subject Development

## Summary
- Added `member-group` as a new multitable permission subject so `platform_member_groups` can drive sheet, view, field, and record ACL assignment.
- Kept the scope intentionally narrow to the existing multitable ACL layers:
  - sheet
  - view
  - field
  - record
- Explicitly did not introduce generic cell-level ACL in this slice.

## Why This Slice
- DingTalk directory sync now projects selected departments into `platform_member_groups`.
- The next lowest-risk ACL step is to let those member groups become first-class subjects in multitable permission assignment and enforcement.
- This closes the path:
  - DingTalk department
  - projected member group
  - multitable ACL subject

## Runtime Changes

### Frontend Types And Client
- Updated multitable subject typing to allow `member-group`:
  - `apps/web/src/multitable/types.ts`
- Extended client normalization and request typing for `member-group` permission subjects:
  - `apps/web/src/multitable/api/client.ts`

### Frontend Permission Managers
- Added member-group handling to sheet/view/field permission management UI:
  - `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- Added member-group handling to record permission management UI:
  - `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`

### Backend ACL Enforcement And Authoring
- Extended multitable ACL listing, candidate loading, effective-permission derivation, and authoring endpoints to accept `member-group`:
  - `packages/core-backend/src/routes/univer-meta.ts`
- Extended shared sheet capability narrowing to honor member-group grants:
  - `packages/core-backend/src/multitable/sheet-capabilities.ts`

### Migration
- Added a migration to widen multitable permission subject-type constraints:
  - `packages/core-backend/src/db/migrations/zzzz20260418143000_allow_member_group_multitable_permission_subjects.ts`
- The migration updates check constraints for:
  - `meta_view_permissions`
  - `field_permissions`
  - `record_permissions`
- `down` removes any `member-group` rows before restoring the previous two-subject constraint.

## ACL Semantics
- `member-group` behaves like a shared governance subject, not a direct-user override.
- Effective permission precedence is:
  - direct user
  - member group
  - role
- `write-own` remains user-only and is rejected for non-user subjects.
- Member-group candidates are sourced from:
  - `platform_member_groups`
  - `platform_member_group_members`

## UI Semantics
- Permission managers now show three subject families:
  - people
  - member groups
  - roles
- Member-group access choices follow role-style shared access:
  - `read`
  - `write`
  - `admin`
- They do not expose `write-own`.

## Validation Rules
- Authoring endpoints now validate that `member-group` subjects exist in `platform_member_groups`.
- Effective ACL derivation safely falls back for environments that do not yet expose `platform_member_group_members`, matching the repository’s existing compatibility style for partial migration states.

## Test Updates
- Added frontend coverage:
  - `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
  - `apps/web/tests/multitable-record-permission-manager.spec.ts`
- Updated backend integration coverage:
  - `packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts`
  - `packages/core-backend/tests/integration/multitable-context.api.test.ts`

## Out Of Scope
- No generic cell-level ACL
- No new multitable governance UI beyond the existing permission managers
- No DingTalk sync or member-group projection changes
- No deployment or environment changes
