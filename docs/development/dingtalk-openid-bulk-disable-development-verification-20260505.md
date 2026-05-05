# DingTalk OpenId Bulk Disable - Development And Verification

Date: 2026-05-05

## Background

After adding screening and CSV export, admins could identify and export missing-`openId` users, but still had to manually select them before revoking DingTalk login access.

The next smallest useful action is a dedicated治理按钮 that targets the currently visible missing-`openId` users whose DingTalk grant is still enabled.

## Development

Changed files:

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`

Frontend behavior:

- Added a computed subset for:
  - current visible users missing `openId`
  - and still grant-enabled
- Added a new bulk action button:
  - `批量关闭缺 OpenID 钉钉扫码`
- Action behavior:
  - posts to `/api/admin/users/dingtalk-grants/bulk`
  - only includes currently visible missing-`openId` users with grant enabled
  - refreshes user list after success
  - refreshes current detail user DingTalk/member-admission state when needed
  - reports a dedicated success status

## Verification

Commands run:

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

Results:

- Frontend: targeted user-management tests passed.
- `git diff --check`: passed.

Coverage added:

- Dedicated bulk-disable action becomes available for visible missing-`openId` users with grant enabled.
- Action sends the expected bulk revoke payload.
- UI reports the expected治理 success message.

## Outcome

The missing-`openId`治理 path now supports:

- screen
- diagnose
- guide repair
- export list
- bulk revoke risky DingTalk access

This reduces the operational window where incomplete DingTalk identities still retain login access.
