# Plugin Role Delegation Scope Verification

## Scope

This verification covers the department-scoped delegated plugin-admin slice:

- delegated admin scope storage
- scope-aware delegated user listing and assignment
- platform-admin scope management APIs
- delegated-role UI updates

## Files Verified

- [zzzz20260409113000_create_delegated_role_admin_scopes.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/db/migrations/zzzz20260409113000_create_delegated_role_admin_scopes.ts)
- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)
- [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)
- [types.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/router/types.ts)
- [admin-users-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/tests/unit/admin-users-routes.test.ts)

## Validation Run

### 1. Backend unit tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts tests/unit/plugin-role-template.test.ts
```

Observed outcome:

- passed
- `39/39` tests green

Important assertions in this slice:

- delegated summary returns scope assignments
- delegated role assignment outside namespace is rejected
- delegated role assignment outside department scope is rejected
- delegated access without scope is rejected
- platform admin can read and assign delegated admin scopes

### 2. Backend build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Observed outcome:

- passed

### 3. Frontend type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Observed outcome:

- passed

## Functional Outcome

After this change:

- delegated plugin admins can no longer manage arbitrary local users
- they can only manage users linked into allowed synced directory department trees
- platform admins have a generic place to configure those delegated scope roots

## Residual Risk

- scope currently depends on synced directory links; unmanaged local-only users remain outside delegated admin reach
- recursive department expansion is query-based, not precomputed, so very large directory trees may later need optimization
- scope is still department-root based; user-group based delegation remains a future step
