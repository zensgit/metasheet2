# DingTalk PR1 Review Development

Date: 2026-04-09
PR: `#725`
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Review Outcome

This pass found and fixed four blocking issues inside the PR1 login foundation:

1. login-page probing created real OAuth state
2. Redis `exec()` tuple errors were ignored
3. auto-provision reused existing emails through upsert
4. the callback page could overwrite an already authenticated browser session

## Code Changes

### Backend

- [dingtalk-oauth.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/packages/core-backend/src/auth/dingtalk-oauth.ts)
  - validate Redis `exec()` result tuples on write and read
  - fail over to memory when Redis write tuples contain errors
  - reject auto-provision when an existing local user already owns the same email

- [auth.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/packages/core-backend/src/routes/auth.ts)
  - add `probe=1` handling to `GET /dingtalk/launch`
  - keep the launch path unchanged for real OAuth starts

### Frontend

- [LoginView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/apps/web/src/views/LoginView.vue)
  - switch DingTalk availability probing to `/api/auth/dingtalk/launch?probe=1`

- [DingTalkAuthCallbackView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/apps/web/src/views/DingTalkAuthCallbackView.vue)
  - refuse to replace an already valid authenticated session

- [appRoutes.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/apps/web/src/router/appRoutes.ts)
  - mark the DingTalk callback route as `requiresGuest`

## Test Additions

- [auth-login-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/packages/core-backend/tests/unit/auth-login-routes.test.ts)
  - probe mode does not generate OAuth state

- [dingtalk-oauth-state-store.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/packages/core-backend/tests/unit/dingtalk-oauth-state-store.test.ts)
  - Redis tuple-error fallback
  - provisioning rejection on existing-email conflict

- [LoginView.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/apps/web/tests/LoginView.spec.ts)
  - probe path uses `?probe=1`

- [dingtalk-auth-callback.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/apps/web/tests/dingtalk-auth-callback.spec.ts)
  - authenticated session is preserved instead of being overwritten

## PR Handling

After these fixes:

- PR1 remains `Ready for review`
- downstream stack order remains unchanged
- no PR2 or PR3 code was touched
