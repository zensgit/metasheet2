# DingTalk Group Destination Validity Test UI Development Verification - 2026-05-06

## Goal

Make it clear that saved DingTalk group robot destinations can be re-tested after time passes or after operators rotate the webhook access token / SEC secret.

## Implementation

- Renamed the existing DingTalk group action from `Test send` to `Test validity`.
- The card now displays:
  - `Last validity test`
  - `Validity: success | failed`
- The frontend sends an explicit validity-test payload when the button is clicked.
- The default backend manual test payload now includes both known robot keywords:
  - `P4`
  - `metasheet`

This keeps manual validity checks aligned with the known A/B group keyword restrictions.

## Verification

Commands:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-destination-service.test.ts tests/integration/dingtalk-group-destination-routes.api.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
```

Results:

- Backend DingTalk group service + route tests: 36/36 passed.
- Frontend `MetaApiTokenManager` tests: 26/26 passed.

## Expected Operator Flow

1. Save a new DingTalk robot destination. The save path verifies before storing.
2. Later, if the group robot webhook or SEC secret is changed in DingTalk, update it in MetaSheet.
3. MetaSheet verifies the changed value before saving.
4. At any later time, click `Test validity` to re-check the stored destination.
5. Use delivery history to inspect the latest DingTalk response.

## Security Notes

- The access token remains masked in the UI.
- The SEC secret is not echoed back into the edit form.
- No raw webhook, access token, SEC secret, or JWT value is added to tracked files.
