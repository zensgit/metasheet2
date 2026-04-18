# Multitable Member-Group ACL Hardening Development

## Summary
- Hardened the main member-group ACL slice without widening scope beyond sheet permission support.
- Fixed the migration so `spreadsheet_permissions` accepts `member-group`, matching the runtime authoring and enforcement behavior already present in `#902`.
- Tightened `loadSheetPermissionScopeMap()` so it only degrades gracefully for known missing-table compatibility cases instead of swallowing all database failures.

## Why This Slice
- The member-group ACL subject slice already allowed `member-group` authoring and enforcement for sheet access.
- The migration only widened subject constraints for:
  - `meta_view_permissions`
  - `field_permissions`
  - `record_permissions`
- It did **not** widen `spreadsheet_permissions`, which left the main sheet ACL table behind the runtime logic.
- `sheet-capabilities.ts` also caught every error from scope loading and returned an empty map, which could silently hide real operational failures.

## Runtime Changes

### Migration Hardening
- Updated:
  - `packages/core-backend/src/db/migrations/zzzz20260418143000_allow_member_group_multitable_permission_subjects.ts`
- `up` now widens `spreadsheet_permissions_subject_type_check` to:
  - `user`
  - `role`
  - `member-group`
- `down` now:
  - deletes `member-group` rows from `spreadsheet_permissions`
  - restores the previous two-subject constraint

### Sheet Capability Compatibility Hardening
- Updated:
  - `packages/core-backend/src/multitable/sheet-capabilities.ts`
- Added table-specific undefined-table detection, matching the compatibility style already used in `univer-meta.ts`.
- `loadSheetPermissionScopeMap()` now only returns an empty scope map when one of these tables is absent:
  - `spreadsheet_permissions`
  - `user_roles`
  - `platform_member_group_members`
- Other failures are now rethrown instead of being silently downgraded.

## Test Coverage
- Added:
  - `packages/core-backend/tests/unit/multitable-member-group-acl-hardening.test.ts`

The new unit coverage verifies:
- member-group-only sheet grants still produce an effective scope
- known missing-table compatibility errors still fail closed to an empty scope map
- non-compatibility database failures are rethrown
- the migration source now includes `spreadsheet_permissions` widening and rollback cleanup

## Out Of Scope
- No UI changes
- No ACL semantic changes
- No new subject types
- No deployment or environment changes
