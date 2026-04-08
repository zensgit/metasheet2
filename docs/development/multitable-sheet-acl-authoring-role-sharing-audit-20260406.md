# Multitable Sheet ACL Authoring / Role Sharing Audit

Date: 2026-04-06

## Summary

The current sheet permission feature presents itself as sheet-level sharing, but the backend enforces it as a restrictive overlay on top of existing global multitable RBAC.

That mismatch shows up in three places:

1. The UI says "Grant sheet-level read, write, or write-own access" and lets operators search arbitrary users.
2. The backend stores those grants in `spreadsheet_permissions`.
3. The actual request path still requires global `multitable:*` permission before a sheet grant matters.

In practice, `spreadsheet_permissions` does not currently function as an independent grant model. It only narrows or specializes access for users who already have global multitable permission.

## What The Current Endpoints Actually Do

The authoring endpoints are in [`packages/core-backend/src/routes/univer-meta.ts`](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-sheet-acl-authoring-audit-20260406/packages/core-backend/src/routes/univer-meta.ts):

- `GET /api/multitable/sheets/:sheetId/permissions`
- `GET /api/multitable/sheets/:sheetId/permission-candidates`
- `PUT /api/multitable/sheets/:sheetId/permissions/:userId`

These routes:

- read and write `spreadsheet_permissions`
- normalize those rows into `read`, `write`, and `write-own`
- require the current operator to resolve to `canManageFields`

That last point matters: access authoring is not modeled as its own capability. It is currently piggybacked onto field management.

## Why Sheet Grants Do Not Currently Elevate Access

There are two separate blockers.

### 1. Route-level RBAC still requires global multitable permission

The main multitable endpoints are guarded with `rbacGuard('multitable', 'read')` or `rbacGuard('multitable', 'write')` in [`packages/core-backend/src/routes/univer-meta.ts`](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-sheet-acl-authoring-audit-20260406/packages/core-backend/src/routes/univer-meta.ts).

That means a user without global multitable permission may be rejected before sheet-scoped ACL is even considered.

### 2. Sheet scope only intersects base capability; it never adds to it

Backend capability derivation works in two phases:

1. `deriveCapabilities()` builds a base capability set from global permissions only.
2. `applySheetPermissionScope()` intersects that base capability with the current sheet scope.

So if a user starts with:

- no global `multitable:read`
- no global `multitable:write`

then a sheet-level `spreadsheet:read` entry still cannot produce effective `canRead`, because there is no base read capability to intersect with.

This means sheet access is currently a restriction layer, not a grant layer.

## Frontend / Backend Semantic Mismatch

The frontend share surface is in [`apps/web/src/multitable/components/MetaSheetPermissionManager.vue`](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-sheet-acl-authoring-audit-20260406/apps/web/src/multitable/components/MetaSheetPermissionManager.vue), with transport in [`apps/web/src/multitable/api/client.ts`](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-sheet-acl-authoring-audit-20260406/apps/web/src/multitable/api/client.ts).

The mismatch is:

- UI language says "Grant sheet-level read, write, or write-own access."
- candidate search returns ordinary users from `users`, not "globally eligible multitable users"
- access levels imply a self-contained sharing model
- but backend enforcement still depends on global RBAC first

So operators can believe they are sharing a sheet with someone, while the recipient may still be unable to open or use the sheet unless they already possess global multitable permission.

## Secondary Model Drift: Roles vs Access Levels

Frontend fallback capability roles in [`apps/web/src/multitable/composables/useMultitableCapabilities.ts`](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-sheet-acl-authoring-audit-20260406/apps/web/src/multitable/composables/useMultitableCapabilities.ts) are:

- `owner`
- `editor`
- `commenter`
- `viewer`

Sheet access authoring uses:

- `read`
- `write`
- `write-own`

These are not the same model:

- `commenter` has no sheet authoring equivalent
- `write-own` has no frontend role equivalent
- the main workbench mostly avoids this mismatch because it prefers backend `MetaCapabilities`
- the mismatch still survives in fallback/embed paths through [`apps/web/src/router/multitableRoute.ts`](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-sheet-acl-authoring-audit-20260406/apps/web/src/router/multitableRoute.ts)

This is not the highest-risk issue today, but it confirms that the permission system is still expressing two different abstractions.

## Highest-Value Next Fix

The next fix should not be another UI patch. It should be a model decision with one narrow implementation slice.

Recommended decision:

- Treat `spreadsheet_permissions` as true sheet-level grants for multitable surfaces, not merely a restriction overlay.

Recommended first implementation slice:

1. Pick one read path, preferably `GET /api/multitable/context`.
2. Allow sheet-level `read` to authorize that path even when global `multitable:read` is absent.
3. Derive effective capability from the union of:
   - global multitable RBAC
   - sheet-level ACL grant
4. Add integration coverage for:
   - no global multitable permission + sheet `read`
   - no global multitable permission + sheet `write-own`
   - no global multitable permission + no sheet grant

If the product decision is instead that sheet ACL should remain restriction-only, then the UI and API must be renamed and narrowed:

- stop calling it "Grant access"
- filter candidates to globally eligible multitable users
- explain that it scopes existing access rather than sharing independently

## Most Actionable Finding

The single most actionable inconsistency is:

The UI presents sheet access as if it grants access to users, but the backend currently treats sheet ACL as a scoped overlay that cannot independently grant multitable access.

That is the next permission-model issue worth fixing before deeper `capabilityScope` refactors.
