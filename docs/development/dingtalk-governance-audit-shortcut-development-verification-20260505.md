# DingTalk Governance Audit Shortcut - Development And Verification

Date: 2026-05-05

## Background

The governance workflow in user management now supports screening, export, bulk closure, and result feedback.

The next useful addition is a direct path into audit review, so admins can quickly inspect the underlying治理 actions without manually rebuilding filters on the audit page.

## Development

Changed files:

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/AdminAuditView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `apps/web/tests/adminAuditView.spec.ts`

Frontend changes:

- Added `查看钉钉治理审计` shortcut in the user-management governance action bar.
- Shortcut targets:
  - `/admin/audit?resourceType=user-auth-grant&action=revoke`
- Updated the audit page to:
  - support `user-auth-grant` in the resource type selector
  - prefill filters from URL query params on mount

## Verification

Commands run:

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/adminAuditView.spec.ts --watch=false
git diff --check
```

Results:

- Frontend: targeted user-management and admin-audit tests passed.
- `git diff --check`: passed.

Coverage added:

- User-management governance area renders the audit shortcut link with the expected deep link.
- Audit page hydrates filters from the deep link and issues the filtered audit request automatically.

## Outcome

Admins can now move directly from the DingTalk治理 list to the matching audit slice without manually rebuilding filters.
