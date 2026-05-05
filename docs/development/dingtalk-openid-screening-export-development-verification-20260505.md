# DingTalk OpenId Screening Export - Development And Verification

Date: 2026-05-05

## Background

After adding the `缺 OpenID` screening view, administrators could identify affected users in the list, but still had to copy the results manually for follow-up.

The next useful slice is a lightweight export action based on the current screening result, so operations can hand off or track a治理清单 without extra querying.

## Development

Changed files:

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`

Frontend behavior:

- Added `导出缺 OpenID 清单` button to the user-management bulk action bar.
- Export scope is the current visible screening result intersected with users missing DingTalk `openId`.
- Exported CSV columns:
  - `userId`
  - `name`
  - `account`
  - `role`
  - `dingtalkCorpId`
  - `directoryLinked`
  - `lastDirectorySyncAt`
- Added success status feedback after export completes.

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

- Export button enabled when current view contains missing-`openId` users.
- Export creates a CSV blob with the expected header and row payload.
- Export reports a success status after download preparation.

## Outcome

Admins can now move directly from screening to action by exporting the current missing-`openId` governance list as CSV.
