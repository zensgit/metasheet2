# DingTalk Group Test Send Client Error Surface - Development & Verification

Date: 2026-05-06

## Goal

Lock the frontend client contract for DingTalk group robot validity-test failures. When the backend returns `TEST_SEND_FAILED`, the client must preserve the HTTP status, error code, and original DingTalk error message so the manager UI can show actionable feedback.

## Development

- Added frontend client coverage for `/api/multitable/dingtalk-groups/:id/test-send` returning HTTP `400`.
- Verified `MultitableApiClient.testDingTalkGroup` throws `MultitableApiError` with:
  - `status = 400`
  - `code = TEST_SEND_FAILED`
  - original DingTalk message such as `DingTalk errcode 310000: keyword mismatch`
- No production client code change was needed because `parseJson` already preserves backend error payloads.

## Files Changed

- `apps/web/tests/multitable-client.spec.ts`

## Verification

Targeted frontend client test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts --watch=false
```

Result: passed, 22 tests.

Targeted frontend manager test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
```

Result: passed, 30 tests.

Static diff check:

```bash
git diff --check -- apps/web/tests/multitable-client.spec.ts docs/development/dingtalk-group-test-send-client-error-surface-development-verification-20260506.md
```

Result: passed, no whitespace errors.

Note: the manager test printed `WebSocket server error: Port is already in use`, but the process exited successfully and all targeted tests passed.

## Acceptance Notes

- Frontend API client now has explicit regression coverage for DingTalk validity-test failure payloads.
- The manager UI can continue relying on `err.message` for operator-facing DingTalk errors.
- This complements the backend route contract that maps DingTalk `errcode` failures to HTTP `400`.
