# DingTalk User Management OpenId Grant Guard - Development And Verification

Date: 2026-05-05

## Background

The previous fix closed the gap in directory bind/admission flows, but `UserManagement` still had two grant entry points that could bypass that policy:

- Single-user grant toggle in the user detail panel.
- Bulk DingTalk grant update from the user list.

That meant an admin could still enable DingTalk login for a corp-scoped identity missing `openId`, even though real DingTalk login would remain unreliable or fail.

## Development

Changed files:

- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`

Backend behavior:

- Extended DingTalk identity snapshot payload with:
  - `hasOpenId`
  - `hasUnionId`
- Added a guard before enabling DingTalk grant:
  - if the user already has a corp-scoped DingTalk identity and `provider_open_id` is missing, enabling grant is rejected.
- Applied the guard to:
  - `PATCH /api/admin/users/:userId/dingtalk-grant`
  - `POST /api/admin/users/dingtalk-grants/bulk`
- Route policy failures now return `400 DINGTALK_OPEN_ID_REQUIRED` instead of a generic `500`.

Frontend behavior:

- User detail page now warns when the current DingTalk identity is corp-scoped but missing `openId`.
- “开通钉钉扫码” is disabled in that state.
- The click handler also blocks locally and shows a clear error message, preventing accidental requests if UI state lags.

## Verification

Commands run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

Results:

- Backend: 1 test file passed, 61 tests passed.
- Frontend: 1 test file passed, 12 tests passed.
- `git diff --check`: passed.

Coverage added:

- Reject single-user DingTalk grant enable when bound identity is missing `openId`.
- Reject bulk DingTalk grant enable when any selected bound identity is missing `openId`.
- Preserve existing revoke behavior and success paths.
- Render warning and disable enable button in the user detail page for missing-`openId` identities.

## Outcome

The DingTalk `openId` guard is now consistent across:

- Directory bind/admission
- User detail grant enable
- Bulk grant enable

This does not repair already incomplete identity data by itself, but it prevents admins from reintroducing the same broken state through other management surfaces.
