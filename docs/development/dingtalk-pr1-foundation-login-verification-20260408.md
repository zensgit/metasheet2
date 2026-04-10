# DingTalk PR1 Foundation + Login Verification

Date: 2026-04-08
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## What Was Verified

This verification pass covers the PR1 login slice only:

- backend DingTalk OAuth state handling
- backend auth route integration
- frontend DingTalk callback page flow
- backend package build
- frontend package type-check

## Automated Verification

### Backend unit tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/dingtalk-oauth-state-store.test.ts
```

Result:

- Passed
- `13/13` tests green

Covered:

- existing auth login feature payload behavior
- session-center auth regressions
- DingTalk launch URL generation
- DingTalk callback token/session issuance
- invalid or expired OAuth state rejection
- Redis-backed state consumption
- in-memory fallback when Redis is unavailable

### Frontend callback test

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-auth-callback.spec.ts
```

Result:

- Passed
- `2/2` tests green

Covered:

- callback page stores the returned token and redirects to backend-provided path
- callback page shows an inline error when the `code` query param is missing

### Backend build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- Passed

### Frontend type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- Passed

## Manual Validation Notes

Not yet executed in this slice:

- Real DingTalk browser login against a configured enterprise tenant
- Callback validation through a public HTTPS redirect URI
- Email auto-link behavior against production-like user data
- Auto-provision behavior with `DINGTALK_AUTH_AUTO_PROVISION=1`

Reason:

- No live DingTalk tenant credentials or callback endpoint were provided during this implementation pass

## Functional Outcome

The branch now supports:

- backend launch URL generation for DingTalk login
- redirect-safe OAuth state creation and validation
- DingTalk callback exchange into a normal MetaSheet session-backed JWT
- frontend DingTalk login button discovery
- frontend callback handling and post-login redirect

## Residual Risks

- Email auto-link is enabled by default; this should be reviewed before production rollout if tenant email authority is weak
- No admin UI yet exists to explicitly grant or revoke DingTalk login
- No live DingTalk smoke script was added in this PR1 slice
- No observability dashboards or alert rules were brought over yet

## Recommended Next Checks Before Merge

1. Run one real DingTalk login against a staging tenant.
2. Confirm callback URI exactly matches the configured DingTalk application.
3. Decide whether `DINGTALK_AUTH_AUTO_LINK_EMAIL` should stay enabled in staging/production.
4. Keep `DINGTALK_AUTH_AUTO_PROVISION=0` until directory/admin controls are merged.
