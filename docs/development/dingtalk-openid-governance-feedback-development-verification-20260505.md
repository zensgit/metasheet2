# DingTalk OpenId Governance Feedback - Development And Verification

Date: 2026-05-05

## Background

After screening, export, and bulk revoke were available, the remaining usability gap was post-action visibility.

Admins could close DingTalk access for missing-`openId` users, but the list did not clearly show which risky users had already been governed and when that happened.

## Development

Changed files:

- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`

Backend changes:

- Enriched user-list DingTalk signals with:
  - `dingtalkGrantUpdatedAt`
- The list now returns both current DingTalk grant status and its latest update timestamp for the current page.

Frontend changes:

- Added a row-level governance hint for missing-`openId` users.
- The hint now shows:
  - corpId
  - last directory sync
  - last DingTalk grant close time when the grant is already disabled
- This makes治理结果 visible directly in the screening list after bulk closure.

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

- User list API returns `dingtalkGrantUpdatedAt`.
- User-management screening list shows recent治理 feedback after bulk closure.

## Outcome

Admins can now distinguish:

- risky users still needing action
- risky users already governed
- when DingTalk access was last closed

This reduces repeated operations and makes handoff/review easier.
