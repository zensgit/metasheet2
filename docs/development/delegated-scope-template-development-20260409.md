# Delegated Scope Template Development

## Summary

This slice adds reusable organization-scope templates on top of the delegated plugin-admin scope model.

Outcome:

- platform admins can create named scope templates
- templates can contain multiple synced directory departments
- a template can be applied to a selected plugin-admin namespace
- applying a template materializes real runtime scope rows

## Backend

### Migration

Added:

- [zzzz20260409134000_create_delegated_role_scope_templates.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/db/migrations/zzzz20260409134000_create_delegated_role_scope_templates.ts)

It creates:

- `delegated_role_scope_templates`
- `delegated_role_scope_template_departments`

### Route updates

Updated:

- [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)

Added helpers for:

- listing templates
- loading template detail
- loading template departments
- applying a template into `delegated_role_admin_scopes`

Added APIs for:

- template list/create/read
- add/remove template departments
- apply template to delegated admin namespace

Audit updates:

- new audit resource type `delegated-admin-scope-template`
- apply/create/template-department edits are all written to audit

## Frontend

Updated:

- [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)

New platform-admin behavior inside the existing role delegation page:

- create template
- search and select templates
- add/remove synced departments to the selected template
- apply the selected template to the current user's selected plugin-admin namespace

This keeps the workflow in one place:

- choose delegated admin
- choose namespace
- choose or maintain template
- apply

## Tests

Updated:

- [admin-users-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/tests/unit/admin-users-routes.test.ts)

Added coverage for:

- creating a scope template
- adding a department to a template
- applying a template to a delegated admin namespace

Existing coverage for:

- namespace restriction
- department-scope restriction
- no-scope rejection

was kept intact.

## Result

After this slice:

- organization shapes become reusable
- platform admins stop manually rebuilding identical scope roots
- delegated runtime enforcement remains low-risk because it still resolves from copied scope rows only
