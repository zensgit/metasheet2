# Plugin Role Delegation Design

## Goal

Allow non-platform plugin admins to assign only their own plugin-scoped roles, without granting them full platform administration.

This generalizes the existing attendance-specific admin pattern into a reusable role-delegation surface.

## Problem

Before this change:

- platform admins could use the full user-management console
- attendance admins had a dedicated scoped surface under `/api/attendance-admin/...`
- future plugin admins such as `crm_admin` or `qa_center_admin` had no generic delegated management path

That meant every plugin would need to build a custom admin-assign API, which does not scale.

## Decision

### 1. Add generic delegated role-admin detection

Delegated role-admin namespaces are derived from assigned roles that end with `_admin`, excluding the global `admin` role.

Examples:

- `crm_admin` => namespace `crm`
- `qa_center_admin` => namespace `qa_center`
- `attendance_admin` => namespace `attendance`

### 2. Add generic delegated role APIs

Implemented in:

- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)

New endpoints:

- `GET /api/admin/role-delegation/summary`
- `GET /api/admin/role-delegation/users`
- `GET /api/admin/role-delegation/users/:userId/access`
- `POST /api/admin/role-delegation/users/:userId/roles/assign`
- `POST /api/admin/role-delegation/users/:userId/roles/unassign`

Behavior:

- platform admins can still use the surface as unrestricted fallback
- delegated plugin admins can only assign roles inside their namespaces
- cross-plugin role assignment is rejected

### 3. Matching rule

A role is delegable when it matches the caller namespace:

- exact namespace role id, or
- role id beginning with `<namespace>_`

Examples for namespace `crm`:

- allowed: `crm_admin`, `crm_operator`, `crm_viewer`
- rejected: `qa_admin`, `attendance_admin`, `admin`

### 4. Add a dedicated UI page

New page:

- [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)

Route:

- `/admin/role-delegation`

The page supports:

- delegated-role summary
- user search
- scoped role assignment and revocation
- visibility into only the caller's delegable role catalog

## Why This Model

This preserves a clean boundary:

- platform admins manage the platform
- plugin admins manage only their plugin roles
- no plugin admin gets accidental cross-plugin or global authority

## Relationship To Existing Attendance Admin

Attendance already had a dedicated scoped admin surface.

This change does not remove it.
Instead, it introduces a generic model future plugins can reuse without inventing custom user-role APIs.

## Non-Goals

- no department-scoped delegation in this slice
- no per-plugin custom UI generation in this slice
- no automatic discovery link in every plugin shell in this slice

## Follow-up

The next logical step is scope restriction by organization or department:

- plugin admin may assign only within approved synced directory scope
