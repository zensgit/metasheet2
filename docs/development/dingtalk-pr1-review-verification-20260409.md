# DingTalk PR1 Review Verification

Date: 2026-04-09
PR: `#725`
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Commands

```bash
pnpm install --offline --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/dingtalk-oauth-state-store.test.ts
pnpm --filter @metasheet/core-backend build
```

## Results

- backend unit tests: passed (`20/20`)
- `@metasheet/core-backend` build: passed

The frontend callback and login-page validations from the earlier PR1 review pass remain unchanged; this follow-up only touched backend helper and route behavior.

## Verified Behaviors

- login-page DingTalk probing no longer allocates real OAuth state
- Redis tuple errors no longer masquerade as successful state persistence
- provisioning refuses to reuse an existing local email when auto-link is disabled
- callback view preserves an already authenticated browser session
- external-identity logins are rejected when the linked local user is inactive
- email auto-link is rejected when the matched local user is disabled
- auto-provision writes a bcrypt `password_hash`, so the current `users` schema no longer rejects the insert
