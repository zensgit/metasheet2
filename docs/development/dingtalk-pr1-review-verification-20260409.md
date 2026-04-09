# DingTalk PR1 Review Verification

Date: 2026-04-10
PR: `#725`
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Commands

```bash
pnpm install --offline --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/dingtalk-oauth-state-store.test.ts
pnpm --filter @metasheet/core-backend build
bash -n scripts/ops/backfill-dingtalk-corp-identities.sh
```

## Results

- backend unit tests: passed (`25/25`)
- `@metasheet/core-backend` build: passed
- corpId backfill script shell parse check: passed

## Verified Behaviors

- login-page DingTalk probing no longer allocates real OAuth state
- Redis tuple errors no longer masquerade as successful state persistence
- provisioning refuses to reuse an existing local email when auto-link is disabled
- callback view preserves an already authenticated browser session
- external-identity logins are rejected when the linked local user is inactive
- corp-scoped identity fallbacks are now pinned to the configured `corpId`
- email auto-link stays off unless `DINGTALK_AUTH_AUTO_LINK_EMAIL` is explicitly enabled
- email auto-link is rejected when the matched local user is disabled
- auto-provision writes a bcrypt `password_hash`, so the current `users` schema no longer rejects the insert
- local policy rejections return `403`
- auto-provision email conflicts return `409`
- DingTalk upstream request failures remain mapped to `502`
- unexpected local callback failures now return `500` with a generic client-facing error message

## Rollout Gate

The corp-scoped identity hardening is intentionally strict. Before enabling `DINGTALK_CORP_ID` in production, rollout must include a one-time backfill of legacy DingTalk identity rows. Use:

```bash
scripts/ops/backfill-dingtalk-corp-identities.sh --corp-id <corpId> --export-file /tmp/dingtalk-corpid-candidates.csv
scripts/ops/backfill-dingtalk-corp-identities.sh --corp-id <corpId> --allowlist-file /tmp/dingtalk-corpid-allowlist.txt --apply
```

The rollout note is documented in `docs/development/dingtalk-pr1-corpid-rollout-20260410.md`.
