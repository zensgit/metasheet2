# Member Admission And Plugin Access Verification

## Scope

This verification covers the new member-admission visibility slice:

- backend admission snapshot route
- user-management admission panel
- integration of directory membership, DingTalk login state, and business-role visibility

## Files Verified

- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)
- [UserManagementView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/UserManagementView.vue)
- [admin-users-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/tests/unit/admin-users-routes.test.ts)

## Validation Run

### 1. Backend unit tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-role-template.test.ts tests/unit/admin-users-routes.test.ts
```

Result:

- passed
- `31/31`

Coverage of this slice:

- `member-admission` route returns directory membership, DingTalk state, and business role IDs
- `admin` role sync behavior still works
- previous DingTalk and user-admin route coverage remains green

### 2. Frontend type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

What this confirms:

- the new admission panel types and API payload handling compile cleanly

### 3. Backend build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- passed

## Functional Outcome

After this change, a platform admin can inspect one user and immediately see:

- whether the platform account is enabled
- whether DingTalk login is enabled
- whether the user is linked to a synced DingTalk member
- which business/plugin roles the user already has

This makes the intended operational model explicit:

- platform admin manages admission
- RBAC roles manage system/plugin access

## Residual Risk

- There is still no plugin-admin-scoped write path in this slice.
- Pending directory links are visible only through existing directory-sync stats, not a dedicated review queue.
- Business roles are shown as a flat list; they are not yet grouped by plugin namespace in the UI.
