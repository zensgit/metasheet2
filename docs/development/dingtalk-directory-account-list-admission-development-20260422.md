# DingTalk Directory Account List Admission Development - 2026-04-22

## Goal

Let administrators create a local user directly from a synced DingTalk account in the member account list, then bind that new local user back to the DingTalk directory account.

The backend `POST /api/admin/directory/accounts/:accountId/admit-user` route already supports no-email admission when a username or mobile number is provided. This slice exposes that standard path in the account list, not only in the pending review queue.

## Scope

- Added a `Manual create user` entry point to each unbound account in the `成员账号` list.
- Reused the same admission fields as the pending review queue:
  - Name
  - Optional email
  - Optional username
  - Optional mobile
- Kept no-email validation: name is required, and at least one of email, username, or mobile is required.
- Reused the existing `admit-user` API call and result panel.
- Preserved the existing quick bind flow for binding to an already existing local user.

## Behavior

- An unbound synced DingTalk account can be expanded in the account list.
- If email is empty but username or mobile exists, the frontend submits the create-and-bind request without an empty email field.
- The success result shows the local user, login account, temporary password, and onboarding message.
- After success, integrations, pending review items, and account list are refreshed.

## Files Changed

- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/directoryManagementView.spec.ts`
- `docs/development/dingtalk-directory-account-list-admission-development-20260422.md`
- `docs/development/dingtalk-directory-account-list-admission-verification-20260422.md`

## Backend Notes

- No backend route changes were required.
- Existing backend support is provided by:
  - `packages/core-backend/src/routes/admin-directory.ts`
  - `packages/core-backend/src/directory/directory-sync.ts`
- Existing backend unit coverage already validates no-email manual admission and DingTalk binding behavior.
