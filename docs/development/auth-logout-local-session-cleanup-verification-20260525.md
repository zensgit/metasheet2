# Auth Logout Local Session Cleanup Verification — 2026-05-25

## Summary

Production logout diagnosis showed that the visible `Sign out` button called `POST /api/auth/logout` successfully and a follow-up `/api/auth/me` returned `401`, but the frontend stayed on `/attendance?tab=admin`, retained local auth keys, and rendered a blank page instead of the login screen.

This slice hardens the shell logout path so a successful or failed network logout always clears local auth/session state and redirects to `/login`.

## Change

- `apps/web/src/App.vue`
  - Continue calling `POST /api/auth/logout` when a token is present.
  - Keep `clearToken()` to reset the `useAuth()` in-memory session cache.
  - Call shared `clearStoredAuthState()` so all local auth context keys are cleared in one place:
    - `auth_token`
    - `jwt`
    - `devToken`
    - tenant hints
    - user role/permission snapshots
    - feature/product-mode cache
  - Keep the final redirect to `/login`.

- `apps/web/tests/App.spec.ts`
  - Added a regression test that mounts the authenticated shell, clicks `Sign out`, verifies the logout API call, confirms auth/user/feature localStorage keys are cleared, and asserts redirect to `/login`.

## Boundaries

- Frontend shell only.
- No backend route changes.
- No database or migration changes.
- No attendance business logic changes.
- No production write operations.

## Verification

Commands run from the isolated worktree:

```bash
pnpm --filter @metasheet/web exec vitest run tests/App.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
git diff --check
```

Results:

- `tests/App.spec.ts`: 2/2 pass.
- `vue-tsc -b`: pass.
- `git diff --check`: pass.

## Live Diagnosis Artifact

The production diagnosis evidence for the original behavior is stored outside the repository:

- `/tmp/attendance-logout-only-diagnosis-20260525.md`
- `/tmp/attendance-logout-before-20260525.png`
- `/tmp/attendance-logout-after-20260525.png`

The diagnosis did not print tokens, did not use the password login form, and did not perform any production data writes.
