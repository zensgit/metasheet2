# Plugin Role Delegation Scope Design

## Goal

Add department-scoped limits to delegated plugin admins so a plugin admin can:

- assign only roles in their own plugin namespace
- manage only members inside approved synced directory departments

This keeps the existing platform-admin fallback while aligning the model with the finer-grained admin patterns seen in tools like Feishu.

## Problem

Before this slice:

- `crm_admin` could only assign `crm_*` roles
- but they could target any local user
- there was no way to say "this CRM admin only manages 华东销售部"

That left the role model incomplete. Namespace restriction alone prevents cross-plugin escalation, but it does not prevent cross-organization delegation.

## Decision

### 1. Reuse synced directory departments as the scope anchor

New table:

- [zzzz20260409113000_create_delegated_role_admin_scopes.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/db/migrations/zzzz20260409113000_create_delegated_role_admin_scopes.ts)

The table stores:

- delegated admin local user id
- plugin namespace, for example `crm`
- allowed root `directory_department_id`

Why this shape:

- it reuses the existing DingTalk directory sync tables
- it avoids inventing a second organization tree
- it allows descendant expansion from an approved root department

### 2. Expand scope through the existing directory tree

Enforcement is done in [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts) with a recursive department query:

- start from configured scope roots in `delegated_role_admin_scopes`
- walk child departments through `directory_departments.external_parent_department_id`
- map local users through:
  - `directory_account_links`
  - `directory_accounts`
  - `directory_account_departments`

This means:

- assigning scope to `总部 / 销售中心`
- automatically covers its descendants
- without storing a materialized closure table in this slice

### 3. Restrict delegated admin user listing and role updates

Delegated plugin admins now have two gates:

1. namespace gate
   - `crm_admin` can still only touch `crm_*`
2. department scope gate
   - only users linked to synced accounts inside the approved department tree are manageable

New delegated-admin outcomes:

- no scope configured: deny delegated access
- user outside allowed department tree: deny delegated access
- user inside scope and role inside namespace: allow

Platform admins remain unrestricted fallback operators.

### 4. Add platform-admin APIs to manage delegated scopes

Added endpoints in [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts):

- `GET /api/admin/role-delegation/departments`
- `GET /api/admin/role-delegation/users/:userId/scopes`
- `POST /api/admin/role-delegation/users/:userId/scopes/assign`
- `POST /api/admin/role-delegation/users/:userId/scopes/unassign`

Rules:

- only platform admins configure delegated scopes
- a scope can only be assigned for a namespace the target user currently holds as `xxx_admin`
- stale scope rows are filtered out from the read path if the user no longer holds that namespace

### 5. Extend the delegated-role UI

Updated page:

- [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)

Behavior:

- delegated plugin admins now see their own current department scope
- platform admins can:
  - inspect a selected admin user's plugin-admin namespaces
  - search synced departments
  - assign or remove scope roots per namespace

## Why This Model

This preserves a clean control split:

- platform admin
  - decides who can enter the platform
  - decides who can use DingTalk login
  - decides which plugin admin manages which department tree
- plugin admin
  - manages only their own plugin roles
  - only for members under their approved organization scope

## Non-Goals

- no generic user-group system in this slice
- no data-row visibility scope in this slice
- no per-plugin custom scope UI; this remains generic and namespace-based
- no closure-table optimization; recursive expansion is sufficient for this first scope cut

## Follow-up

Natural next steps:

- add reusable user groups on top of synced directory members
- add plugin data-visibility scope, not just entrance scope
- allow scope assignment by department tree or user group, not only direct department roots
