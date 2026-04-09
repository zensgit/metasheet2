# DingTalk PR1 Review Development

Date: 2026-04-09
PR: `#725`
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Review Outcome

This review sequence now covers six blocking issues inside the PR1 login foundation.

The earlier pass fixed:

1. login-page probing created real OAuth state
2. Redis `exec()` tuple errors were ignored
3. auto-provision reused existing emails through upsert
4. the callback page could overwrite an already authenticated browser session

This follow-up pass fixed:

5. DingTalk login could still admit disabled or inactive local users
6. auto-provision did not write `users.password_hash` even though the current schema requires it

## Execution Context

The existing PR1 worktrees were not safe to reuse:

- the original PR1 worktree already contained unrelated `jwt-middleware` changes
- the refresh worktree was detached and had local `node_modules` churn

This follow-up was implemented from a new detached worktree rooted at remote PR1 head `75be0891a`, then pushed directly back to `origin/codex/dingtalk-pr1-foundation-login-20260408`.

## Code Changes

### Backend

- [dingtalk-oauth.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/packages/core-backend/src/auth/dingtalk-oauth.ts)
  - validate Redis `exec()` result tuples on write and read
  - fail over to memory when Redis write tuples contain errors
  - reject auto-provision when an existing local user already owns the same email
  - include `is_active` in resolved local-user rows
  - reject external-identity and email-link logins when the local user is disabled or inactive
  - generate a bcrypt `password_hash` for auto-provisioned users and persist it with the new local account

- [auth.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/packages/core-backend/src/routes/auth.ts)
  - add `probe=1` handling to `GET /dingtalk/launch`
  - keep the launch path unchanged for real OAuth starts
  - preserve disabled-user callback failures as explicit API errors

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
  - disabled/inactive local-user failures are surfaced back through `/api/auth/dingtalk/callback`

- [dingtalk-oauth-state-store.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/packages/core-backend/tests/unit/dingtalk-oauth-state-store.test.ts)
  - Redis tuple-error fallback
  - provisioning rejection on existing-email conflict
  - external-identity login rejection for inactive local users
  - email-link rejection for disabled local users
  - auto-provision writes a bcrypt `password_hash`

- [LoginView.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/apps/web/tests/LoginView.spec.ts)
  - probe path uses `?probe=1`

- [dingtalk-auth-callback.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-20260408/apps/web/tests/dingtalk-auth-callback.spec.ts)
  - authenticated session is preserved instead of being overwritten

## PR Handling

After these fixes:

- PR1 remains `Ready for review`
- downstream stack order remains unchanged
- no PR2 or PR3 code was touched
