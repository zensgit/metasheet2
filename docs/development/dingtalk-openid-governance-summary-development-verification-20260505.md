# DingTalk OpenId Governance Summary - Development And Verification

Date: 2026-05-05

## Background

After screening, export, bulk closure, and row-level feedback were added, admins could operate the治理 workflow end to end.

The next useful refinement is a compact summary panel that shows current治理 volume at a glance:

- total missing `openId`
- already governed
- still pending governance

## Development

Changed files:

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`

Frontend changes:

- Extended `governanceSummary` with:
  - `dingtalkOpenIdGoverned`
  - `dingtalkOpenIdPending`
- Added two new summary metrics in the user-management governance summary bar:
  - `已收口`
  - `待收口`
- Values update live after the existing bulk closure action refreshes the user list.

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

- Summary reflects missing-`openId` population before治理.
- Summary flips from pending to governed after bulk disabling DingTalk access for the affected user set.

## Outcome

Admins can now use the top summary bar as a lightweight巡检 panel:

- how many risky accounts exist
- how many have already been收口
- how many still need action
