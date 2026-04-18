# DingTalk Directory Governance PR Package Verification

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/auth-invite-routes.test.ts tests/unit/jwt-middleware.test.ts tests/unit/admin-users-routes.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-review-items.test.ts tests/unit/directory-sync-auto-admission.test.ts tests/unit/directory-sync-member-group-projection.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/LoginView.spec.ts tests/ForcePasswordChangeView.spec.ts tests/utils/api.test.ts tests/directoryManagementView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## Results

### Backend tests

Result:

- `9 files passed`
- `136 passed`

Covered together:

- manual directory admission;
- auth bind / invite / forced password change;
- JWT middleware enforcement for `PASSWORD_CHANGE_REQUIRED`;
- directory review queue and grouped review SQL;
- scoped auto admission include/exclude rules;
- selected department -> member-group projection planning.

### Frontend tests

Result:

- `4 files passed`
- `55 passed`

Covered together:

- login redirection for password-change-required sessions;
- forced password change view;
- API redirect handling for `PASSWORD_CHANGE_REQUIRED`;
- directory management integration config, sync feedback, manual admission, scoped auto admission, and member-group sync settings.

### Builds

- `pnpm --filter @metasheet/core-backend build` — passed
- `pnpm --filter @metasheet/web build` — passed

Observed existing non-blocking warnings:

- frontend Vitest may print `WebSocket server error: Port is already in use`
- Vite build still prints existing chunk-size warnings

Neither warning was introduced by this package.

## Deployment

No remote deployment was performed as part of PR package verification.
