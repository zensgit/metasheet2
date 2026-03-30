# DingTalk Unbound Login Review Verification

## Local Verification

Backend tests passed:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync.test.ts tests/unit/auth-login-routes.test.ts tests/unit/auth-invite-routes.test.ts tests/unit/admin-directory-routes.test.ts`

Frontend tests passed:

- `pnpm --filter @metasheet/web exec vitest run tests/dingtalkAuthCallbackView.spec.ts tests/directoryManagementView.spec.ts`

Type and build checks passed:

- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- `pnpm --filter @metasheet/web build`
- `node scripts/openapi-check.mjs`

## Added Coverage

Backend:

- integration config defaults `captureUnboundLogins` to enabled
- unbound DingTalk login is captured into directory review
- auth exchange returns `DINGTALK_ACCOUNT_REVIEW_REQUIRED`
- admin directory create route forwards `captureUnboundLogins`

Frontend:

- callback page renders admin-review guidance for queued DingTalk users
- directory integration save persists `captureUnboundLogins`

## Manual Acceptance Checklist

1. In Directory Management, confirm the integration checkbox is visible and saved
2. Disable DingTalk auto provisioning
3. Attempt DingTalk login with an unbound user from the same corp
4. Confirm callback page shows admin review guidance
5. Confirm the user appears in Directory Management as `pending`
6. Provision or link the account
7. Enable DingTalk auth for the linked user
8. Retry DingTalk login and confirm success
