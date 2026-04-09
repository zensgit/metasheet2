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

- backend unit tests: passed (`23/23`)
- `@metasheet/core-backend` build: passed

The frontend callback and login-page validations from the earlier PR1 review pass remain unchanged; this follow-up only touched backend helper and route behavior.

## Verified Behaviors

- login-page DingTalk probing no longer allocates real OAuth state
- Redis tuple errors no longer masquerade as successful state persistence
- provisioning refuses to reuse an existing local email when auto-link is disabled
- callback view preserves an already authenticated browser session
- external-identity logins are rejected when the linked local user is inactive
- corp-scoped identity fallbacks are now pinned to the configured `corpId`
- email auto-link is rejected when the matched local user is disabled
- auto-provision writes a bcrypt `password_hash`, so the current `users` schema no longer rejects the insert
- local policy rejections now return `403` instead of masquerading as DingTalk upstream `502`
- auto-provision email conflicts now return `409`
- DingTalk upstream request failures remain mapped to `502`

## Rollout Gate

The corp-scoped identity hardening is intentionally strict. Before enabling `DINGTALK_CORP_ID` in production, rollout must include a one-time backfill of legacy DingTalk identity rows so existing bindings are rewritten to:

- `corp_id = <target corp id>`
- `external_key = <corpId>:<provider_open_id>`

Without that backfill, older bindings that only relied on bare `provider_open_id` / `provider_union_id` may stop matching once corp-scoped lookup is enabled.
