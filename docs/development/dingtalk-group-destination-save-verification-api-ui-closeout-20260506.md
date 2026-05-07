# DingTalk Group Destination Save Verification API UI Closeout - 2026-05-06

## Goal

Close the API and UI behavior around "verify before save" for DingTalk group robots:

- Save-time DingTalk verification failures should be treated as invalid operator input.
- API responses should return a clear `400` instead of a generic server failure.
- The frontend should keep the edit/create form open when verification fails, show the DingTalk-side reason, and avoid adding a destination card.

## Implementation

Backend route layer:

- Save-time verification failures that contain `DingTalk group destination verification failed` now map to HTTP `400`.
- Create failures keep `code = CREATE_FAILED`.
- Update failures keep `code = UPDATE_FAILED`.
- Error messages preserve the DingTalk-side reason, such as revoked tokens or keyword mismatches.

Frontend tests:

- Added coverage for failed DingTalk group creation.
- The form remains open after failure.
- The alert shows the DingTalk-side failure text.
- No destination card is added after a failed save.

## Verification

Commands:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-destination-service.test.ts tests/integration/dingtalk-group-destination-routes.api.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
```

Results:

- Backend DingTalk group service + route tests: 36/36 passed.
- Frontend `MetaApiTokenManager` tests: 26/26 passed.

## Notes

- The route tests intentionally exercise both create and update verification failures.
- The frontend test uses a simulated `token is not exist` response to match the real DingTalk failure observed during 142 testing.
- No webhook, access token, SEC secret, or JWT value is added to tracked files.
