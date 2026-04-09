# Plugin Role Delegation Scope Verification

## Scope

This verification covers the department-scoped delegated plugin admin slice:

- migration for delegated scope storage
- backend scope enforcement and scope-management APIs
- frontend role-delegation page updates

## Files Verified

- [zzzz20260409113000_create_delegated_role_admin_scopes.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/db/migrations/zzzz20260409113000_create_delegated_role_admin_scopes.ts)
- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)
- [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)
- [admin-users-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/tests/unit/admin-users-routes.test.ts)

## Validation Run

### 1. Backend unit tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts tests/unit/plugin-role-template.test.ts
```

Observed result:

- passed
- `39/39` tests green

Coverage in this slice includes:

- delegated role summary with scope assignments
- namespace rejection
- namespace-specific out-of-scope rejection
- successful scoped assignment
- missing-scope rejection
- delegated admin scope read
- delegated admin scope assignment

### 2. Frontend type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Observed result:

- passed

### 3. Backend build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Observed result:

- passed

## Functional Outcome

After this change:

- platform admins can configure namespace-to-department scope for delegated plugin admins
- plugin admins can only see members inside their approved synced directory scope
- plugin admins can only assign plugin roles inside both:
  - their namespace
  - their approved department subtree

## Residual Risk

- scope is department-tree based; there is no reusable user-group layer yet
- scope currently depends on synced directory links in `linked` state for delegated user visibility
- platform admins still configure scope from a generic directory department picker rather than plugin-specific business views
