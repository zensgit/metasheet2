# DingTalk Password Change Required Verification

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/auth-invite-routes.test.ts tests/unit/jwt-middleware.test.ts tests/unit/admin-users-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/LoginView.spec.ts tests/ForcePasswordChangeView.spec.ts tests/utils/api.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-review-items.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## Results

### Backend auth / IAM verification

- `tests/unit/auth-login-routes.test.ts`
- `tests/unit/auth-invite-routes.test.ts`
- `tests/unit/jwt-middleware.test.ts`
- `tests/unit/admin-users-routes.test.ts`

Result:

- `4 files passed`
- `99 passed`

Verified:

- login responses surface `passwordChangeRequired`;
- forced sessions are blocked by JWT middleware for non-whitelisted routes;
- `/api/auth/password/change` clears the flag and issues a fresh token;
- invite acceptance clears `must_change_password`;
- admin password reset remains functional.

### Directory admission regression verification

- `tests/unit/admin-directory-routes.test.ts`
- `tests/unit/directory-sync-bind-account.test.ts`
- `tests/unit/directory-sync-review-items.test.ts`
- `tests/directoryManagementView.spec.ts`

Result:

- backend: `31 passed`
- frontend: `32 passed`

Verified:

- manual admission route still creates and binds users;
- generated temporary-password admissions still return onboarding outputs;
- directory review/account queries remain healthy after the new flag was introduced.

### Frontend auth flow verification

- `tests/LoginView.spec.ts`
- `tests/ForcePasswordChangeView.spec.ts`
- `tests/utils/api.test.ts`

Result:

- `3 files passed`
- `23 passed`

Verified:

- login redirects flagged sessions to `/force-password-change`;
- forced password change page stores the fresh token and returns to the home path;
- `apiFetch()` redirects `403 PASSWORD_CHANGE_REQUIRED` responses to `/force-password-change`.

### Build verification

- backend build: passed
- web build: passed

Notes:

- frontend test output still includes the pre-existing Vite websocket `Port is already in use` warning in Vitest;
- frontend production build still emits existing chunk-size warnings;
- neither warning blocked this round.

## Deployment Impact

- Database migration required: `056_add_users_must_change_password.sql`
- No remote deployment was performed in this round.
