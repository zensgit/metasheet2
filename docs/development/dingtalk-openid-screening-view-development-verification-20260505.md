# DingTalk OpenId Screening View - Development And Verification

Date: 2026-05-05

## Background

The previous slices added:

- grant guardrails
- repair guidance
- per-user diagnostics

The remaining operational gap was scale. Admins still had to open users one by one to find DingTalk-linked accounts missing `openId`.

## Development

Changed files:

- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`

Backend changes:

- Enriched `/api/admin/users` list items with DingTalk governance signals for the current page:
  - `dingtalkIdentityExists`
  - `dingtalkHasUnionId`
  - `dingtalkHasOpenId`
  - `dingtalkOpenIdMissing`
  - `dingtalkCorpId`
  - `lastDirectorySyncAt`
- Reused batched lookups so the UI can screen the current page without loading per-user detail first.

Frontend changes:

- Added a new user-list governance filter: `缺 OpenID`
- Added a summary metric: `缺 OpenID`
- Added a danger badge on affected rows: `缺 OpenID`
- Added a quick row hint for affected users:
  - corpId
  - last directory sync

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

- User list API returns DingTalk screening signals.
- User management list renders the new screening metric and row badge.
- `缺 OpenID` filter isolates the affected users in the management list.

## Outcome

Admins can now do first-pass DingTalk risk screening directly from the user list, without opening each user detail page first.
