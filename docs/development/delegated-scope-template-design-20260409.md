# Delegated Scope Template Design

## Goal

Let platform admins maintain reusable organization-scope templates, then apply those templates to a delegated plugin admin's namespace.

This is the next step after department-root scope restriction:

- department roots still remain the runtime enforcement unit
- templates make those roots reusable
- plugin admins still never gain cross-plugin or platform-wide authority

## Problem

After the department-scoped delegation slice:

- platform admins had to add department roots one by one for every plugin admin
- repeated org structures such as `华东销售`, `制造中心`, `交付团队` had to be rebuilt manually
- there was no reusable range preset

That made the model correct but too operationally expensive.

## Decision

### 1. Use copy-on-apply templates, not live runtime template joins

Templates are stored separately, but applying a template copies its departments into `delegated_role_admin_scopes`.

Why:

- lower query risk
- no extra runtime join or template resolution in delegated permission checks
- existing scope enforcement remains unchanged
- applying a template is explicit and auditable

This means templates behave like reusable presets, not live bindings.

### 2. Add template tables

Migration:

- [zzzz20260409134000_create_delegated_role_scope_templates.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/db/migrations/zzzz20260409134000_create_delegated_role_scope_templates.ts)

Tables:

- `delegated_role_scope_templates`
  - name
  - description
  - created_by / updated_by
- `delegated_role_scope_template_departments`
  - template to department mapping

Department roots continue to reference synced `directory_departments`.

### 3. Add platform-admin template APIs

Implemented in:

- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)

New endpoints:

- `GET /api/admin/role-delegation/scope-templates`
- `POST /api/admin/role-delegation/scope-templates`
- `GET /api/admin/role-delegation/scope-templates/:templateId`
- `POST /api/admin/role-delegation/scope-templates/:templateId/departments/assign`
- `POST /api/admin/role-delegation/scope-templates/:templateId/departments/unassign`
- `POST /api/admin/role-delegation/users/:userId/scope-templates/apply`

### 4. Apply templates by namespace

Applying a template requires:

- target user exists
- target user currently holds the `xxx_admin` namespace being configured
- template has at least one department

Apply mode:

- `replace`
  - clear existing root scopes for that namespace
  - then copy template roots in
- `merge`
  - additive, no delete first

Current UI uses `replace`.

### 5. Keep delegated runtime checks unchanged

Delegated admin runtime enforcement still uses:

- `delegated_role_admin_scopes`
- recursive department expansion
- namespace match

Template logic stops at apply time.

## Why This Model

This keeps the important invariants intact:

- platform admin controls admission and scope topology
- plugin admin controls only their own plugin roles
- runtime access checks stay simple

## Non-Goals

- no live template-to-admin binding propagation
- no user-group model in this slice
- no independent template-center page; the entry stays inside role delegation

## Follow-up

Natural next steps:

- promote templates into a standalone template center if adoption grows
- add user-group based templates
- add data-range templates in addition to member-range templates
