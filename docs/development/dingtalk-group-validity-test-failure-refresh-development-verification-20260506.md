# DingTalk Group Validity Test Failure Refresh - Development & Verification

Date: 2026-05-06

## Goal

When a DingTalk group robot validity test fails, the backend records the failed status and error. The frontend should refresh the destination card after the failed test so administrators immediately see the failed validity state without closing and reopening the manager.

## Development

- Updated `MetaApiTokenManager` so the `Test validity` failure path reloads DingTalk group destinations.
- If the delivery-history panel for that group is open, the failure path also reloads the delivery history.
- The original test failure message remains visible in the top error banner after the refresh.
- Extended the frontend test double to simulate backend state changes after failed validity tests.
- Added coverage that verifies the card updates to `Validity: failed`, shows the last error, and displays the failure guidance note.

## Files Changed

- `apps/web/src/multitable/components/MetaApiTokenManager.vue`
- `apps/web/tests/multitable-api-token-manager.spec.ts`

## Verification

Targeted frontend manager test:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
```

Result: passed, 28 tests.

Static diff check:

```bash
git diff --check -- apps/web/src/multitable/components/MetaApiTokenManager.vue apps/web/tests/multitable-api-token-manager.spec.ts docs/development/dingtalk-group-validity-test-failure-refresh-development-verification-20260506.md
```

Result: passed, no whitespace errors.

## Acceptance Notes

- Failed `Test validity` now refreshes the DingTalk group card state.
- The user still sees the actionable failure message from the backend.
- Open delivery history is kept in sync after both successful and failed validity tests.
