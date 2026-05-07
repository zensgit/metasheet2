# DingTalk Group Test Send Error Status - Development & Verification

Date: 2026-05-06

## Goal

Manual DingTalk group robot validity-test failures are expected operator-actionable configuration errors, not backend server faults. Route responses should return `400` so the UI and acceptance probes can distinguish invalid robot settings from service outages.

## Development

- Extended the API token route error mapping so `DingTalk errcode ...` service errors are treated as validation failures.
- Added an integration test for `/api/multitable/dingtalk-groups/:id/test-send` when DingTalk returns a keyword/signature style failure.
- Kept the existing response code shape as `TEST_SEND_FAILED` so frontend error parsing remains compatible.

## Files Changed

- `packages/core-backend/src/routes/api-tokens.ts`
- `packages/core-backend/tests/integration/dingtalk-group-destination-routes.api.test.ts`

## Verification

Targeted backend route test:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-group-destination-routes.api.test.ts --watch=false
```

Result: passed, 15 tests.

Targeted frontend manager test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
```

Result: passed, 30 tests.

Static diff check:

```bash
git diff --check -- packages/core-backend/src/routes/api-tokens.ts packages/core-backend/tests/integration/dingtalk-group-destination-routes.api.test.ts docs/development/dingtalk-group-test-send-error-status-development-verification-20260506.md
```

Result: passed, no whitespace errors.

Note: the frontend Vitest run printed `WebSocket server error: Port is already in use`, but the process exited successfully and all targeted tests passed.

## Acceptance Notes

- DingTalk validity-test failures such as keyword mismatch now return HTTP `400`.
- The response body keeps `error.code = TEST_SEND_FAILED` and the original DingTalk error message.
- Frontend behavior remains compatible because it already displays the backend message and refreshes failed validity state.
