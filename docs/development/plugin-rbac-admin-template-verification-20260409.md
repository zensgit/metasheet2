# Plugin RBAC Admin Template Verification

## Scope

This verification covers two changes:

1. Explicit separation of platform admin and attendance admin in user management.
2. Reusable RBAC helper for future plugin admin roles.

## Files Verified

- [UserManagementView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/UserManagementView.vue)
- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)
- [plugin-role-template.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/rbac/plugin-role-template.ts)
- [admin-users-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/tests/unit/admin-users-routes.test.ts)
- [plugin-role-template.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/tests/unit/plugin-role-template.test.ts)

## Validation Run

### 1. Admin user routes

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts
```

Result:

- passed
- `28/28`

What this confirms:

- assigning `attendance_admin` remains a scoped role operation
- assigning `admin` now also synchronizes legacy admin columns
- unassigning `admin` clears legacy admin columns
- DingTalk grant routes still pass

### 2. Plugin RBAC helper

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-role-template.test.ts
```

Result:

- passed
- helper normalizes role IDs and permission namespaces as designed
- helper supports default and custom role/action sets

### 3. Frontend type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

What this confirms:

- new explicit toggles for platform admin and attendance admin compile cleanly

### 4. Backend build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- passed

## Functional Outcome

After this change:

- attendance admin can be granted without giving platform admin
- platform admin can be granted or revoked from the page explicitly
- future plugins have a reusable role/permission template instead of hardcoding `admin`

## Residual Risk

- Older routes in the codebase still contain some direct `admin` checks.
- Future plugins must still follow the RBAC pattern intentionally; the helper cannot enforce correct route guards by itself.
- No dedicated generic "plugin admin toggle generator" was added to the frontend in this change; arbitrary plugin roles still rely on the existing generic role picker unless a plugin-specific quick action is added later.
