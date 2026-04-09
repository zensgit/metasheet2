# DingTalk PR1 Review Development

Date: 2026-04-10
PR: `#725`
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Review Outcome

This review sequence now covers eleven blocking issues inside the PR1 login foundation.

The earlier pass fixed:

1. login-page probing created real OAuth state
2. Redis `exec()` tuple errors were ignored
3. auto-provision reused existing emails through upsert
4. the callback page could overwrite an already authenticated browser session
5. DingTalk login could still admit disabled or inactive local users
6. auto-provision did not write `users.password_hash` even though the current schema requires it
7. corp-scoped external identities could still fall back to a bare `openId` / `unionId` lookup and hit the wrong local user
8. callback status codes hid local policy denials behind `502`
9. corp-scoped rollout had no explicit backfill gate for legacy bindings

This follow-up pass fixed:

10. email auto-link stayed enabled by default when the env var was unset
11. unexpected local callback failures were still being reported as `502`

## Execution Context

The existing PR1 worktrees were not safe to reuse:

- the original PR1 worktree already contained unrelated `jwt-middleware` changes
- the refresh worktrees were detached and already used for prior fix rounds

This follow-up was implemented from a new detached worktree rooted at remote PR1 head `5a97e80c9`, then pushed directly back to `origin/codex/dingtalk-pr1-foundation-login-20260408`.

## Code Changes

### Backend

- `packages/core-backend/src/auth/dingtalk-oauth.ts`
  - default `DINGTALK_AUTH_AUTO_LINK_EMAIL` to disabled unless explicitly enabled
  - keep the earlier disabled/inactive-user gate, hashed auto-provision, and corp-scoped fallback hardening

- `packages/core-backend/src/routes/auth.ts`
  - keep local DingTalk policy errors on `403` / `409`
  - keep upstream DingTalk request failures on `502`
  - map unexpected local callback failures to `500`

### Configuration

- `.env.example`
  - change the DingTalk auto-link example from `1` to `0`

### Tests

- `packages/core-backend/tests/unit/dingtalk-oauth-state-store.test.ts`
  - verify email auto-link stays off when the env var is unset
  - keep explicit email-link tests by enabling the env flag inside the test

- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
  - verify unexpected local callback failures now return `500`

### Ops / Rollout

- `scripts/ops/backfill-dingtalk-corp-identities.sh`
  - add a dry-run-by-default corpId backfill helper for legacy DingTalk identities
  - refuse to apply when `provider_open_id` is missing or corp-scoped `external_key` conflicts exist

- `docs/development/dingtalk-pr1-corpid-rollout-20260410.md`
  - document the rollout gate and execution order for enabling `DINGTALK_CORP_ID`

## PR Handling

After these fixes:

- PR1 remains `Ready for review`
- downstream stack order remains unchanged
- no PR2 or PR3 code is touched

## Rollout Note

Before enabling `DINGTALK_CORP_ID` in production:

1. dry-run `scripts/ops/backfill-dingtalk-corp-identities.sh --corp-id <corpId>`
2. resolve any reported `missing_open_id_rows` or `conflict_rows`
3. run `--apply`
4. rerun dry-run and confirm the candidate count is zero
5. only then enable `DINGTALK_CORP_ID`
