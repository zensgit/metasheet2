# Multitable Role-Based Sheet Sharing Development

Date: 2026-04-06
Branch: `codex/multitable-role-sheet-sharing-20260406`

## Goal

Extend multitable sheet sharing from direct user-only grants to subject-aware sharing that supports both people and roles, while keeping `write-own` limited to direct user grants.

## Scope

- Add subject-aware storage for `spreadsheet_permissions`
- Merge direct user grants and role grants into effective sheet ACL resolution
- Keep direct user grants higher priority than inherited role grants
- Extend Access manager UI to author people and role grants
- Keep legacy spreadsheet permission routes user-only to avoid leaking role rows into old responses
- Update OpenAPI and integration/component tests

## Backend

### Permission Subject Model

- Added migration [zzzz20260406030000_add_spreadsheet_permission_subjects.ts](/private/tmp/metasheet2-role-sheet-sharing-20260406/packages/core-backend/src/db/migrations/zzzz20260406030000_add_spreadsheet_permission_subjects.ts)
- Extended [types.ts](/private/tmp/metasheet2-role-sheet-sharing-20260406/packages/core-backend/src/db/types.ts) so `spreadsheet_permissions` now carries:
  - `subject_type`
  - `subject_id`
  - nullable `user_id` for backward compatibility on direct user grants

### Runtime ACL Resolution

Updated [univer-meta.ts](/private/tmp/metasheet2-role-sheet-sharing-20260406/packages/core-backend/src/routes/univer-meta.ts):

- `listSheetPermissionEntries()` now returns mixed `user` / `role` entries
- `listSheetPermissionCandidates()` now returns mixed people and role candidates
- `loadSheetPermissionScopeMap()` now merges:
  - direct user assignments
  - inherited role assignments through `user_roles`
- Effective access semantics:
  - if a direct user assignment exists for a sheet, it overrides inherited role access
  - otherwise inherited role access applies
- Authoring route changed from user-only path to:
  - `PUT /api/multitable/sheets/:sheetId/permissions/:subjectType/:subjectId`
- Validation rule added:
  - `write-own` is rejected for `role` subjects

### Legacy Route Compatibility

Updated [spreadsheet-permissions.ts](/private/tmp/metasheet2-role-sheet-sharing-20260406/packages/core-backend/src/routes/spreadsheet-permissions.ts) so legacy routes only read/write direct user grants and ignore role rows.

## Frontend

### Types and Client

Updated:

- [types.ts](/private/tmp/metasheet2-role-sheet-sharing-20260406/apps/web/src/multitable/types.ts)
- [client.ts](/private/tmp/metasheet2-role-sheet-sharing-20260406/apps/web/src/multitable/api/client.ts)

Changes:

- added `MetaSheetPermissionSubjectType = 'user' | 'role'`
- `MetaSheetPermissionEntry` and `MetaSheetPermissionCandidate` are now subject-aware
- `updateSheetPermission()` now sends `subjectType + subjectId`

### Access Manager

Updated [MetaSheetPermissionManager.vue](/private/tmp/metasheet2-role-sheet-sharing-20260406/apps/web/src/multitable/components/MetaSheetPermissionManager.vue):

- current access list now shows both people and roles
- candidate search now surfaces both people and roles
- UI splits candidate authoring into `People` and `Roles`
- role grants only expose `read` and `write`
- `write-own` remains available only for direct user grants

## Tests Added/Updated

- Backend integration:
  - [multitable-sheet-permissions.api.test.ts](/private/tmp/metasheet2-role-sheet-sharing-20260406/packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts)
- Frontend:
  - [multitable-sheet-permission-manager.spec.ts](/private/tmp/metasheet2-role-sheet-sharing-20260406/apps/web/tests/multitable-sheet-permission-manager.spec.ts)

Key new assertions:

- mixed people/role entry and candidate listing
- role grant authoring path and payload shape
- `write-own` rejected for roles
- direct user grant overrides inherited role grant
- role candidates do not expose `write-own` in the Access manager UI
