# DingTalk Group Destination Validity Guidance - Development & Verification

Date: 2026-05-06

## Goal

Close the operational gap after DingTalk group robots are saved: administrators should be able to see which saved robot destinations need attention without opening logs or guessing from historical deliveries.

## Development

- Added a DingTalk group validity note in the API Tokens / Webhooks / DingTalk Groups manager.
- The note is shown for three actionable states:
  - `failed`: the last validity test failed, so the webhook or SEC secret should be fixed and tested again.
  - `never tested`: no `lastTestedAt` exists, so the destination should be tested before relying on it.
  - `stale`: the last successful test is older than 30 days, so a fresh validity test is recommended.
- The note is read-only UI guidance. It does not change delivery behavior, permissions, or the save-time robot verification flow.
- Existing secret masking remains unchanged: webhook access tokens, timestamp, sign, and URL passwords are still masked in the card display.

## Files Changed

- `apps/web/src/multitable/components/MetaApiTokenManager.vue`
- `apps/web/tests/multitable-api-token-manager.spec.ts`

## Verification

Targeted frontend test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
```

Result: passed, 27 tests.

Static diff check:

```bash
git diff --check -- apps/web/src/multitable/components/MetaApiTokenManager.vue apps/web/tests/multitable-api-token-manager.spec.ts docs/development/dingtalk-group-destination-validity-guidance-development-verification-20260506.md
```

Result: passed, no whitespace errors.

## Acceptance Notes

- A saved DingTalk group with no validity test now shows `Validity check needed`.
- A saved DingTalk group whose last test failed now shows `Validity failed` and preserves the backend error text.
- A saved DingTalk group last tested more than 30 days ago now shows `Validity check recommended`.
- Recently verified successful groups stay quiet to avoid warning fatigue.
