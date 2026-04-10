# Plugin Role Delegation Verification

## Scope

This verification covers the generic delegated role-admin slice:

- backend delegated role APIs
- frontend delegated role page
- namespace restriction behavior

## Files Verified

- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)
- [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)
- [appRoutes.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/router/appRoutes.ts)
- [admin-users-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/tests/unit/admin-users-routes.test.ts)

## Validation Run

### 1. Backend unit tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts tests/unit/plugin-role-template.test.ts
```

Expected coverage in this slice:

- delegated role summary for plugin admin
- forbidden cross-namespace assignment
- allowed same-namespace assignment

### 2. Frontend type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected outcome:

- passes with the new `/admin/role-delegation` page and route

### 3. Backend build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Expected outcome:

- passes after adding delegated role helpers and endpoints

## Functional Outcome

After this change:

- platform admins still retain full fallback control
- plugin admins can use a dedicated delegated role page
- plugin admins cannot assign roles outside their namespace

## Residual Risk

- the page is generic and namespace-based; it does not yet group roles by plugin metadata
- delegated scope is namespace-only, not department-scoped
- plugin discoverability still depends on navigation and documentation rather than automatic entry points from every plugin shell
