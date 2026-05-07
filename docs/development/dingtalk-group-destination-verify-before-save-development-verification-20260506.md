# DingTalk Group Destination Verify Before Save Development Verification - 2026-05-06

## Goal

Make DingTalk group robot configuration safer:

- Validate webhook URL and SEC secret format before sending.
- Send a real DingTalk verification message before create/update saves webhook or secret changes.
- Save only when DingTalk returns success.
- Reject invalid DingTalk-side values such as revoked access tokens, bad signing secrets, or keyword mismatches without writing the invalid destination configuration.

## Implementation

Backend:

- `DingTalkGroupDestinationService.createDestination()` now verifies the robot before inserting a destination.
- `DingTalkGroupDestinationService.updateDestination()` now verifies when `webhookUrl` or `secret` changes.
- Name/enabled-only updates still save without sending a robot message.
- Successful save-time verification records:
  - `last_tested_at`
  - `last_test_status = success`
  - delivery history row with DingTalk response metadata
- Failed save-time verification throws before insert/update.
- Test-send failure recording still preserves HTTP status and DingTalk response body.

Frontend:

- DingTalk group webhook help text now states that saving sends a verification message first.
- Save button labels changed to:
  - `Verify & Create`
  - `Verify & Update`

## Security Notes

- Webhook URLs remain masked in UI responses.
- SEC secrets are not returned to the frontend.
- No raw webhook, access token, SEC secret, or JWT value is added to tracked files.
- The verification message intentionally contains both `P4` and `metasheet` to satisfy the known test robot keyword restrictions.

## Verification

Commands:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-destination-service.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
git diff --check
```

Results:

- `dingtalk-group-destination-service.test.ts`: 22/22 passed.
- `multitable-api-token-manager.spec.ts`: 25/25 passed.
- `@metasheet/core-backend build`: passed.
- `git diff --check`: passed.

Expected behavior after this change:

- Format-invalid webhook or secret: rejected before network verification.
- DingTalk-invalid webhook or secret: verification message fails, destination is not saved.
- DingTalk-valid webhook and secret: destination is saved and marked with successful last-test metadata.
- Existing destination name/enabled toggles: no robot verification is required unless webhook or secret changes.
