# DingTalk Group Validity Test History Contract - Development & Verification

Date: 2026-05-06

## Goal

Keep the DingTalk group robot validity-test contract consistent across the UI request payload, frontend test doubles, and backend route delivery-history fixtures.

## Development

- Updated the `MetaApiTokenManager` test client double so manual test deliveries use the actual `/test-send` request subject and content.
- Added a `MultitableApiClient.testDingTalkGroup` test to lock the `sheetId` query string and JSON payload sent by the frontend client.
- Updated the backend DingTalk group route delivery-history fixture to use the current validity-test subject and content.

## Files Changed

- `apps/web/tests/multitable-api-token-manager.spec.ts`
- `apps/web/tests/multitable-client.spec.ts`
- `packages/core-backend/tests/integration/dingtalk-group-destination-routes.api.test.ts`

## Verification

Targeted frontend manager test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
```

Result: passed, 27 tests.

Targeted frontend client test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts --watch=false
```

Result: passed, 21 tests.

Targeted backend route test:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-group-destination-routes.api.test.ts --watch=false
```

Result: passed, 14 tests.

Static diff check:

```bash
git diff --check -- apps/web/tests/multitable-api-token-manager.spec.ts apps/web/tests/multitable-client.spec.ts packages/core-backend/tests/integration/dingtalk-group-destination-routes.api.test.ts docs/development/dingtalk-group-validity-test-history-contract-development-verification-20260506.md
```

Result: passed, no whitespace errors.

Note: frontend Vitest printed `WebSocket server error: Port is already in use`, but the process exited successfully and all targeted tests passed.

## Acceptance Notes

- Manual validity-test delivery history now shows the same subject the UI sends.
- The frontend client test verifies both scoped URL and payload.
- Backend route fixture naming no longer points to the old generic `MetaSheet DingTalk group test` message.
