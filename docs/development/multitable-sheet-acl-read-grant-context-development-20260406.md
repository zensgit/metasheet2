# Multitable Sheet ACL Read Grant Context Development

Date: 2026-04-06
Branch: `codex/multitable-sheet-acl-grant-read-20260406`

## Goal

Make `GET /api/multitable/context` treat sheet-level ACL as a real read grant for multitable context loading, instead of only as a restriction overlay on top of existing global multitable RBAC.

## Scope

- Remove the hard global `rbacGuard('multitable', 'read')` gate from `/api/multitable/context`
- Keep request authentication required
- Allow sheet-level `read` or `write-own` to authorize context loading even when the user has no global `multitable:*` permission
- Keep the slice narrow:
  - no write-path elevation
  - no changes to `/view`, `/form-context`, `/records/:recordId`, or other read routes

## Backend Changes

Updated [univer-meta.ts](/private/tmp/metasheet2-sheet-acl-grant-read-20260406/packages/core-backend/src/routes/univer-meta.ts):

- Added `canReadWithSheetGrant(...)`
  - used only by `/context` sheet filtering
  - treats `scope.canRead` as sufficient when global `canRead` is absent
- Added `applyContextSheetReadGrant(...)`
  - keeps existing scoped restriction behavior
  - upgrades `canRead` to `true` for `/context` only when a sheet-level read grant exists
- Removed route-level `rbacGuard('multitable', 'read')` from `GET /api/multitable/context`
- Added explicit auth check inside the route so anonymous requests still return `401`
- Added explicit `403` when the caller has neither:
  - global multitable read
  - nor any readable sheet grant in the resolved base/sheet selection

## Test Coverage

Extended [multitable-sheet-permissions.api.test.ts](/private/tmp/metasheet2-sheet-acl-grant-read-20260406/packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts) with three context-specific cases:

- no global multitable permission + sheet `read` grant => `200`
- no global multitable permission + sheet `write-own` grant => `200`
- no global multitable permission + no sheet grant => `403`

## Notes

- This slice is intentionally not a full permission-model rewrite.
- It only proves the first narrow grant path recommended by the ACL audit.
- Other multitable read routes still remain global-RBAC-first until follow-up slices port them.
