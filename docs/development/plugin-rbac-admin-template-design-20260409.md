# Plugin RBAC Admin Template Design

## Background

The current codebase already separates platform administration from attendance administration:

- Platform admin is controlled by the `admin` role and legacy `users.role/is_admin` flags.
- Attendance admin is controlled by the `attendance_admin` role and `attendance:*` permissions.

This separation should become the default model for every future plugin. A plugin admin should not automatically become a platform admin, and platform admins should remain the only actors allowed to assign plugin-scoped admin roles.

## Goal

Define a reusable RBAC template so future plugins can be onboarded with:

1. Their own permission namespace.
2. Their own plugin-scoped roles.
3. Platform-admin-managed assignment from the existing user management page.
4. No hardcoded dependency on `role === 'admin'` inside plugin business routes.

## Decision

### 1. Keep platform admin separate from plugin admin

- `admin` remains the platform-wide administrator role.
- Plugin admin uses a plugin-specific role such as `crm_admin`, `qa_center_admin`, or `plm_workbench_admin`.
- Plugin routes should primarily check plugin permissions such as `crm:admin`, not the global `admin` role.

### 2. Standardize plugin role naming

For a plugin namespace `plugin_id`, future roles should follow:

- `<plugin_id>_viewer`
- `<plugin_id>_operator`
- `<plugin_id>_admin`

Examples:

- `crm_admin`
- `qa_center_operator`
- `plm_workbench_viewer`

Role IDs use underscore-normalized identifiers to match the existing role table style.

### 3. Standardize plugin permission naming

Permissions should follow:

- `<plugin-id>:read`
- `<plugin-id>:write`
- `<plugin-id>:approve`
- `<plugin-id>:admin`

Examples:

- `crm:read`
- `crm:admin`
- `qa-center:approve`

Permissions keep a hyphen-safe namespace for external readability while role IDs stay underscore-based.

### 4. Reusable helper for future plugins

Added helper:

- [plugin-role-template.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/rbac/plugin-role-template.ts)

It exposes:

- `buildPluginRoleId(pluginId, kind)`
- `buildPluginPermissionCode(pluginId, action)`
- `buildPluginRoleSeeds({ pluginId, displayName, ... })`

This helper is intended for future migrations, seed scripts, and plugin setup code.

## User Management Behavior

The user management page now exposes two explicit admin controls:

- Platform admin
- Attendance admin

This establishes the pattern for future plugin admin toggles:

- explicit
- scoped
- non-transitive

Current implementation:

- [UserManagementView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/UserManagementView.vue)
- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)

## Legacy Admin Synchronization

Assigning the `admin` role through the user-management APIs now also synchronizes:

- `users.role = 'admin'`
- `users.is_admin = true`

Removing the `admin` role clears those fields back to user-safe defaults.

This avoids drift between:

- RBAC state in `user_roles`
- legacy admin checks still present in older routes and tokens

## Recommended Plugin Integration Pattern

For each future plugin:

1. Add permissions in a migration.
2. Add roles in a migration.
3. Add `role_permissions` mappings in a migration.
4. Guard plugin routes with plugin permissions.
5. Let platform admins assign plugin roles through the existing user management page.

## Example Seed Shape

```ts
const seeds = buildPluginRoleSeeds({
  pluginId: 'crm',
  displayName: 'CRM',
})
```

Expected roles:

- `crm_viewer`
- `crm_operator`
- `crm_admin`

Expected permissions:

- `crm:read`
- `crm:write`
- `crm:admin`

## Non-Goals

- No automatic promotion from plugin admin to platform admin.
- No plugin-specific user-management page in this change.
- No attempt to refactor every old route away from legacy `admin` checks in this change.

## Follow-up

When the next plugin is added, the preferred sequence is:

1. permissions migration
2. roles migration
3. route guards
4. optional access preset
5. optional dedicated quick-toggle in user management
