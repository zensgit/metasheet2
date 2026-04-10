# Member Admission And Plugin Access Design

## Goal

After syncing DingTalk organizations and members into MetaSheet, the platform should support a clear two-layer model:

1. Platform admins decide whether a synced member can enter the platform at all.
2. Plugin or business-system roles decide which specific systems that member can use.

This change makes that model visible in the existing user management page.

## Decision

### 1. Keep identity admission and plugin access separate

Platform admin remains responsible for:

- local account enabled/disabled
- DingTalk scan login enabled/disabled
- platform admin assignment
- attendance admin assignment
- business/plugin role assignment

Plugin access is still represented by RBAC role assignment, not by a separate account system.

### 2. Add a unified member-admission snapshot

New backend route:

- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)
- `GET /api/admin/users/:userId/member-admission`

It returns:

- local account enabled state
- platform admin enabled state
- attendance admin enabled state
- business role IDs
- linked directory memberships
- DingTalk login snapshot

This combines data that previously lived in separate places:

- `users`
- `user_roles`
- `directory_account_links`
- `directory_accounts`
- `directory_departments`
- `user_external_auth_grants`
- `user_external_identities`

### 3. Surface the model in user management

User management now has a dedicated "成员准入" section:

- [UserManagementView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/UserManagementView.vue)

The section shows:

- whether the local platform account is enabled
- whether DingTalk login is enabled
- whether the member is linked to directory data
- how many business-system roles are assigned
- which directory entry the local user came from
- department path samples for that synced member

## Why This Model

This keeps the permission boundary defensible:

- syncing from DingTalk does not automatically mean platform admission
- enabling DingTalk login does not automatically grant plugin access
- plugin access is still granted by RBAC roles

This is the correct shape for future systems such as CRM, PLM, QA, or custom plugins.

## Current Scope

Implemented now:

- member-admission snapshot route
- user-management admission panel
- directory membership visibility for a local user

Not implemented in this slice:

- plugin-admin-scoped delegation
- department-scoped admin limits
- approval workflow for pending directory links

## Recommended Operational Flow

1. Sync DingTalk orgs and members.
2. Confirm local account exists and is enabled.
3. Enable DingTalk scan login if required.
4. Assign system roles such as `attendance_admin`, `crm_admin`, or `plm_workbench_operator`.

## Follow-up

The next useful step would be scoped delegation:

- allow a plugin admin to assign only their plugin's roles
- optionally restrict that admin to a subset of synced departments or org ranges
