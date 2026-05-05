# DingTalk Diagnostic Fields - Development And Verification

Date: 2026-05-05

## Background

The previous slices already solved two different problems:

- prevent admins from enabling DingTalk login when `openId` is missing
- provide repair guidance and safe next actions

What was still missing was a compact diagnostic view for administrators. They could see that something was blocked, but not the key identity fields and timestamps in one place.

## Development

Changed files:

- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `apps/web/tests/directoryManagementView.spec.ts`

Backend changes:

- Extended the user-management DingTalk access snapshot to return the raw identity values:
  - `identity.unionId`
  - `identity.openId`
- Existing booleans remain:
  - `identity.hasUnionId`
  - `identity.hasOpenId`

Frontend changes:

- User management DingTalk section now shows a compact diagnostic grid with:
  - identity corpId
  - unionId
  - openId
  - last DingTalk login
  - last directory sync
  - DingTalk identity updatedAt
- Directory management account cards now explicitly show:
  - last directory sync

## Verification

Commands run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-users-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

Results:

- Backend: 1 test file passed, 61 tests passed.
- Frontend: targeted user-management and directory-management test files passed.
- `git diff --check`: passed.

Coverage added:

- Backend snapshot now exposes raw `unionId/openId` values.
- User management page renders readable DingTalk diagnostics for both healthy and missing-`openId` identities.
- Directory management account cards render the latest directory sync timestamp.

## Outcome

Admins now have the minimum useful DingTalk diagnosis set in the UI:

- which identity values exist
- whether the missing field is really `openId`
- when the user last logged in via DingTalk
- when the directory data was last refreshed

That makes the repair workflow much easier to follow without going back to database inspection.
