# DingTalk OpenId Governance Owner Feedback - Development And Verification

Date: 2026-05-05

## Background

The previous治理 feedback slice already showed when a missing-`openId` user's DingTalk access was last closed.

The remaining gap was ownership visibility. For handoff and audit purposes, admins also need to know who performed the latest治理 action.

## Development

Changed files:

- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`

Backend changes:

- Extended user-list DingTalk governance signals with:
  - `dingtalkGrantUpdatedBy`
- The user list now resolves the latest grant updater from `user_external_auth_grants.granted_by`, preferring operator name, then email, then id.

Frontend changes:

- Missing-`openId` governance hint now includes operator information when DingTalk access has already been closed:
  - `最近关闭钉钉扫码 <time> · 处理人 <name>`

## Verification

Commands run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

Results:

- Backend: targeted admin-users route tests passed.
- Frontend: targeted user-management tests passed.
- `git diff --check`: passed.

Coverage added:

- User list API returns the latest治理 operator label.
- User-management missing-`openId` governance hint renders both close time and operator after bulk closure.

## Outcome

The治理 result feedback now answers both:

- when was this risky DingTalk account handled
- who handled it

That makes follow-up and audit much easier without leaving the user list.
