# DingTalk No-Email Admission Rollforward Development

Date: 2026-04-20
Branch: `codex/dingtalk-no-email-admission-20260420`

## Goal

Allow administrators to create and bind a local user from a DingTalk-synced directory account even when the account has no email address, instead of forcing a fake email or skipping the user.

## Why this change

Current `main` still required `users.email` at every layer:

- database schema: `users.email TEXT NOT NULL UNIQUE`
- admin user creation: `email and name are required`
- directory manual admission: `name and email are required`
- directory auto-admission: skipped in-scope DingTalk accounts without email

That made DingTalk onboarding incomplete for real enterprise accounts that only had DingTalk identity and mobile.

## Approach

Reused the previously validated no-email closure implementation from the historical `codex/no-email-user-closure-20260418` line and rolled it forward onto current `main`, instead of re-implementing the same account-model change from scratch.

Cherry-picked commits:

- `91d3b2bf4` `feat(auth): support no-email user admission and login identifiers`
- `11c7555b8` `feat(directory): return no-email auto-admission onboarding packets`

## Main changes

### 1. User model

- Added migration `zzzz20260418170000_allow_no_email_users_and_add_username.ts`
- `users.email` can now be null
- added `users.username`
- added unique index on `lower(username)` when username is not null

### 2. Auth and login

- login now accepts a generic `identifier`
- identifier may resolve by:
  - email
  - username
  - mobile
- no-email users can still sign in through DingTalk, and can also use username/mobile when provisioned that way

### 3. Admin user creation

- admin-side create-user flow no longer requires email
- requires:
  - `name`
  - and at least one of `email | username | mobile`
- skips invite issuance when there is no email
- returns temporary-password onboarding metadata for no-email users

### 4. Directory manual admission

- `/api/admin/directory/accounts/:accountId/admit-user` now supports no-email local-user creation
- manual admission requires:
  - `name`
  - and at least one of `email | username | mobile`
- generated onboarding is email-aware:
  - email path: invite + email onboarding
  - no-email path: temporary password + account label

### 5. Directory auto-admission

- in-scope DingTalk accounts without email are no longer just dead ends
- deterministic username generation was added
- auto-admission response now includes onboarding packets for no-email users

### 6. Frontend admin flows

- `DirectoryManagementView` manual-admission form supports no-email creation
- `UserManagementView` create-user flow supports no-email creation
- `LoginView` now uses a generic account identifier

## Key files

- `packages/core-backend/src/db/migrations/zzzz20260418170000_allow_no_email_users_and_add_username.ts`
- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/directory/directory-sync.ts`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/DirectoryManagementView.vue`

## Notes

- This rollforward intentionally reused already tested work rather than designing a second incompatible no-email model.
- The scope is broader than only directory manual admission because the schema change (`users.email` nullable) needs auth and admin user creation to stay coherent.
