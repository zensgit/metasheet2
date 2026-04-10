# Plugin Role Delegation Scope Development

## Summary

This slice finishes the next step called out in the earlier delegated-role design:

- delegated plugin admins are no longer namespace-only
- they now require explicit directory department scope
- platform admins get a generic UI and API to manage that scope

## Backend Changes

### Migration

Added:

- [zzzz20260409113000_create_delegated_role_admin_scopes.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/db/migrations/zzzz20260409113000_create_delegated_role_admin_scopes.ts)

It creates `delegated_role_admin_scopes` with:

- `admin_user_id`
- `namespace`
- `directory_department_id`
- `created_by`
- timestamps

### Route and query changes

Updated:

- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)

Key additions:

- scope assignment readers for delegated admins and platform admins
- recursive department expansion from scope roots
- scope-aware delegated user listing
- scope-aware delegated access checks
- platform-admin scope management endpoints

Key behavioral changes:

- delegated admins without department scope now receive `ROLE_DELEGATION_SCOPE_REQUIRED`
- delegated admins targeting a user outside allowed departments receive `ROLE_DELEGATION_USER_OUT_OF_SCOPE`
- delegated admins still receive `ROLE_DELEGATION_FORBIDDEN` for cross-namespace role assignment

## Frontend Changes

Updated:

- [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)
- [types.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/router/types.ts)

New UI behavior:

- plugin admins see their current department scope cards
- platform admins can:
  - inspect a selected user's plugin-admin namespaces
  - search synced departments
  - add scope roots
  - remove scope roots

## Test Changes

Updated:

- [admin-users-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/tests/unit/admin-users-routes.test.ts)

Added coverage for:

- scope-required rejection
- out-of-scope rejection
- delegated scope read
- delegated scope assignment
- audit resource type update

## Result

After this slice:

- platform admins still control global admission and cross-plugin access
- plugin admins still manage only their own namespace
- plugin admins now also require explicit organization scope to manage members

This gives us the first complete version of:

- platform admission
- DingTalk login admission
- plugin admin delegation
- organization-scoped plugin admin management
