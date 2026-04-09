# DingTalk PR1 Review Development

Date: 2026-04-10
PR: `#725`
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Review Outcome

This review sequence now covers thirteen blocking issues inside the PR1 login foundation.

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
12. unknown local `500` callback failures still leaked internal error strings back to clients
13. the corpId backfill script still assumed whole-database single-corp apply instead of a manual allowlist gate

## Execution Context

The existing PR1 worktrees were not safe to reuse:

- the original PR1 worktree already contained unrelated `jwt-middleware` changes
- the refresh worktrees were detached and already used for prior fix rounds

This follow-up was implemented from a new detached worktree rooted at remote PR1 head `20cdabd19`, then pushed directly back to `origin/codex/dingtalk-pr1-foundation-login-20260408`.

A final minimal refresh was then rebased onto the latest `origin/main`, producing refreshed PR1 head `a4751ee22` with no code-scope expansion.

## Code Changes

### Backend

- `packages/core-backend/src/auth/dingtalk-oauth.ts`
  - default `DINGTALK_AUTH_AUTO_LINK_EMAIL` to disabled unless explicitly enabled
  - keep the earlier disabled/inactive-user gate, hashed auto-provision, and corp-scoped fallback hardening

- `packages/core-backend/src/routes/auth.ts`
  - keep local DingTalk policy errors on `403` / `409`
  - keep upstream DingTalk request failures on `502`
  - map unexpected local callback failures to `500`
  - keep the `500` response body generic instead of exposing the raw internal error string

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
  - export candidate rows for manual review
  - require a manual allowlist for `--apply`
  - refuse to apply when `provider_open_id` is missing, corp-scoped `external_key` conflicts exist, or the allowlist includes ineligible ids

- `docs/development/dingtalk-pr1-corpid-rollout-20260410.md`
  - document the rollout gate and execution order for enabling `DINGTALK_CORP_ID`

## PR Handling

After these fixes:

- PR1 remains `Ready for review`
- downstream stack order remains unchanged
- no PR2 or PR3 code is touched

## Rollout Note

Before enabling `DINGTALK_CORP_ID` in production:

1. export candidates with `scripts/ops/backfill-dingtalk-corp-identities.sh --corp-id <corpId> --export-file <path>`
2. manually review the candidate export and prepare an allowlist file of approved `user_external_identities.id` values
3. resolve any reported `missing_open_id_rows` or `conflict_rows`
4. run `--apply` with `--allowlist-file`
5. rerun dry-run/export and confirm the reviewed rows are no longer candidates
6. only then enable `DINGTALK_CORP_ID`
