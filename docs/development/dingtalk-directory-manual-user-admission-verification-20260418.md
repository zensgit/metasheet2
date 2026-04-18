# DingTalk Directory Manual User Admission Verification

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Verification Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-bind-account.test.ts tests/unit/admin-directory-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## Results

### Backend unit tests

- Scope:
  - `tests/unit/directory-sync-bind-account.test.ts`
  - `tests/unit/admin-directory-routes.test.ts`
- Result: passed
- Coverage added:
  - atomic create-user-and-bind service flow
  - `admit-user` route wiring
  - onboarding payload return path
  - invite token / temporary password propagation

### Frontend unit tests

- Scope:
  - `tests/directoryManagementView.spec.ts`
- Result: passed
- Coverage added:
  - opening the manual admission form from a pending review card
  - submitting `创建用户并绑定`
  - calling `/api/admin/directory/accounts/:accountId/admit-user`
  - rendering onboarding outputs after success

### Builds

- `pnpm --filter @metasheet/core-backend build`: passed
- `pnpm --filter @metasheet/web build`: passed

## Deployment

- No remote deployment in this round
- No database migration required
- This round is a local DingTalk governance enhancement and backend API consolidation
