# DingTalk Password Change Required Development

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Goal

Add a safe forced-password-change path for DingTalk-driven onboarding and administrator password resets without introducing scheduled password rotation.

## Problem

Before this round, the branch already supported:

- manual admission from a synced DingTalk directory member;
- administrator password reset;
- invite acceptance with a first-time password setup flow.

But it still lacked one important control:

- a temporary-password user could continue using the platform without first changing that password.

That gap mattered in two places:

1. when an operator manually admitted a synced DingTalk member and the backend generated a temporary password;
2. when an administrator reset a user password and expected the next login to force a real password change.

## Implementation

### Database and backend auth model

Files:

- `packages/core-backend/migrations/056_add_users_must_change_password.sql`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/auth/AuthService.ts`

Changes:

- Added `users.must_change_password BOOLEAN NOT NULL DEFAULT FALSE`.
- Extended backend auth/user types so authenticated sessions can carry the flag.
- Ensured auth lookups and user creation paths load and return `must_change_password`.

### Forced-password-change enforcement

Files:

- `packages/core-backend/src/auth/jwt-middleware.ts`
- `packages/core-backend/src/routes/auth.ts`

Changes:

- Added a narrow whitelist for sessions that must rotate passwords:
  - `/api/auth/me`
  - `/api/auth/logout`
  - `/api/auth/password/change`
  - `/api/auth/refresh`
  - `/api/auth/refresh-token`
- Non-whitelisted API requests now receive:
  - `403`
  - `error.code = PASSWORD_CHANGE_REQUIRED`
- Login responses now expose `passwordChangeRequired`.
- Added `POST /api/auth/password/change`:
  1. require authenticated user;
  2. require `must_change_password = true`;
  3. validate the new password;
  4. update `password_hash`;
  5. clear `must_change_password`;
  6. revoke prior sessions;
  7. issue a fresh session token and feature payload.

### Sources that set the flag

Files:

- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/src/routes/auth.ts`

Changes:

- Admin password reset now always sets `must_change_password = TRUE`.
- Manual directory admission sets `must_change_password = TRUE` when it creates a local user with a generated temporary password.
- Invite acceptance explicitly clears the flag to keep first-time invite setup as the password-establishing action.

### Frontend flow

Files:

- `apps/web/src/router/types.ts`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/App.vue`
- `apps/web/src/main.ts`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/ForcePasswordChangeView.vue`
- `apps/web/src/utils/api.ts`

Changes:

- Added the dedicated route `/force-password-change`.
- Auth bootstrap now redirects flagged sessions to that route.
- Login now preserves the issued token/session but routes flagged users into the forced-change page instead of normal home navigation.
- Added a dedicated password-change view that:
  - validates local confirmation;
  - posts to `/api/auth/password/change`;
  - stores the fresh token;
  - primes the new session;
  - loads product features;
  - redirects back to the resolved home page.
- `apiFetch()` now redirects `403 PASSWORD_CHANGE_REQUIRED` responses to `/force-password-change`.

## Scope

This round implements:

- forced password change after admin reset;
- forced password change for generated temporary-password admissions;
- authenticated password-change completion.

This round does **not** implement:

- scheduled password rotation windows;
- department-scoped auto admission;
- bulk password governance policies.
