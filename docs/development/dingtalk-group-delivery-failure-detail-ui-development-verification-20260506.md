# DingTalk Group Delivery Failure Detail UI - Development & Verification

Date: 2026-05-06

## Goal

Make DingTalk group delivery history useful for operations troubleshooting. Failed robot deliveries should show the backend failure reason inline instead of requiring log access.

## Development

- Added inline `Error: ...` rendering for DingTalk group delivery rows when `errorMessage` is present.
- Reused the existing failure styling so delivery rows keep the same visual language as `FAIL`.
- Added coverage for existing failed delivery history rows.
- Added coverage for the failed `Test validity` path when delivery history is already open, verifying that the refreshed failure row includes the DingTalk error.

## Files Changed

- `apps/web/src/multitable/components/MetaApiTokenManager.vue`
- `apps/web/tests/multitable-api-token-manager.spec.ts`

## Verification

Targeted frontend manager test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
```

Result: passed, 30 tests.

Static diff check:

```bash
git diff --check -- apps/web/src/multitable/components/MetaApiTokenManager.vue apps/web/tests/multitable-api-token-manager.spec.ts docs/development/dingtalk-group-delivery-failure-detail-ui-development-verification-20260506.md
```

Result: passed, no whitespace errors.

## Acceptance Notes

- Failed DingTalk delivery rows now expose the exact backend error message.
- A failed manual `Test validity` refreshes the open history panel and shows the failure reason.
- Successful delivery rows remain unchanged.
