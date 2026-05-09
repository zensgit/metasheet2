# DingTalk OpenId Repair Guidance - Development And Verification

Date: 2026-05-05

## Background

The previous two slices already blocked new bad states:

- Directory bind/admission can no longer silently enable DingTalk grant when `openId` is missing.
- User management can no longer re-enable DingTalk grant for a corp-scoped identity missing `openId`.

What was still missing was a practical repair path for administrators handling existing incomplete identities. Admin pages showed the restriction, but not the next safe action.

## Development

Changed files:

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `apps/web/tests/directoryManagementView.spec.ts`

User management changes:

- Added a repair guidance hint when the current DingTalk identity exists but is missing `openId`.
- Added a direct link back to the matching directory member when a DingTalk directory membership is known.
- Reused existing refresh flow so admins can refresh DingTalk state after directory resync or a real DingTalk OAuth bind.

Directory management changes:

- For review items and account cards with missing `openId`, added an explicit repair suggestion:
  - refresh the current member after a real DingTalk login/bind
  - if still missing, inspect directory sync payload/permissions before deciding on a broader resync
- Added local action buttons:
  - `刷新当前成员`
  - `前往用户管理` when the local user already exists

## Verification

Commands run:

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

Results:

- Frontend: targeted user-management and directory-management test files passed.
- `git diff --check`: passed.

Coverage added:

- User detail page renders repair guidance and a directory-member jump link for missing-`openId` identities.
- Directory review/account cards render repair guidance and local repair actions for missing-`openId` members.

## Outcome

Administrators now see a consistent DingTalk repair story across both major admin surfaces:

- why grant enable is blocked
- where to continue diagnosis
- what safe next action to try first

This does not fabricate `openId`, but it turns the current “blocked state” into an actionable repair workflow.
