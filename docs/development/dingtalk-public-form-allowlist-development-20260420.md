# DingTalk Public Form Allowlist Development

- Date: 2026-04-20
- Branch: `codex/dingtalk-public-form-allowlist-20260420`
- Base: `codex/public-form-auth-hotfix-20260420` (`#931`)

## Goal

Extend protected public forms so the owner can restrict submission to selected local users or local member groups.

The authority model stays local-first:

- the allowlist targets `users` and `platform_member_groups`
- DingTalk remains an authentication and delivery channel
- a visitor must first pass the existing DingTalk access mode
- the system then resolves the local user and enforces the allowlist

## Backend changes

### Public form config shape

Updated [packages/core-backend/src/routes/univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/packages/core-backend/src/routes/univer-meta.ts:1) so `publicForm` now supports:

- `allowedUserIds`
- `allowedMemberGroupIds`

Both values are normalized through `normalizePublicFormAllowlistIds(...)` to keep them deduped and array-shaped.

### Form share serialization

`serializePublicFormShareConfig(...)` is now async and resolves allowlist summaries before returning config to the UI.

Returned config now includes:

- `allowedUserIds`
- `allowedUsers`
- `allowedMemberGroupIds`
- `allowedMemberGroups`

Each summary carries:

- `subjectType`
- `subjectId`
- `label`
- `subtitle`
- `isActive`

### Protected access evaluation

Extended `evaluateProtectedPublicFormAccess(...)` in [packages/core-backend/src/routes/univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/packages/core-backend/src/routes/univer-meta.ts:1):

1. evaluate the existing access mode:
   - `public`
   - `dingtalk`
   - `dingtalk_granted`
2. resolve the signed-in local user
3. if either allowlist is populated, require one of:
   - direct match in `allowedUserIds`
   - membership in an allowed `platform_member_group`

Failures now return:

- `statusCode: 403`
- `code: DINGTALK_FORM_NOT_ALLOWED`

### Form share endpoints

Updated:

- `GET /api/multitable/sheets/:sheetId/views/:viewId/form-share`
- `PATCH /api/multitable/sheets/:sheetId/views/:viewId/form-share`
- `POST /api/multitable/sheets/:sheetId/views/:viewId/form-share/regenerate`

Patch validation now enforces:

- allowlists are only valid for protected modes, not `public`
- all referenced `userIds` must exist in `users`
- all referenced `memberGroupIds` must exist in `platform_member_groups`

### Candidate lookup route

Added:

- `GET /api/multitable/sheets/:sheetId/form-share-candidates`

This route is gated by `canManageViews` and reuses `listSheetPermissionCandidates(...)`, but filters the result down to:

- `user`
- `member-group`

This avoids depending on admin-only user-management APIs from the form-share UI.

## Frontend changes

### Form share allowlist UI

Updated [apps/web/src/multitable/components/MetaFormShareManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/multitable/components/MetaFormShareManager.vue:1):

- shows allowlist controls only for protected modes
- supports searching local users and member groups
- lets the owner add/remove allowed subjects as chips
- disables adding inactive users
- blocks switching back to fully `public` while allowlist entries remain

### API/client typing

Updated:

- [apps/web/src/multitable/types.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/multitable/types.ts:1)
- [apps/web/src/multitable/api/client.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/multitable/api/client.ts:1)

Added:

- normalized allowlist fields on form-share config
- `listFormShareCandidates(...)`

### Public form error handling

Updated [apps/web/src/views/PublicMultitableFormView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/views/PublicMultitableFormView.vue:1) so `DINGTALK_FORM_NOT_ALLOWED` now renders:

- `This form only accepts selected system users or member groups.`

## Tests updated

- [packages/core-backend/tests/integration/public-form-flow.test.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/packages/core-backend/tests/integration/public-form-flow.test.ts:1)
- [apps/web/tests/multitable-form-share-manager.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/tests/multitable-form-share-manager.spec.ts:1)
- [apps/web/tests/public-multitable-form.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/tests/public-multitable-form.spec.ts:1)

New coverage added for:

- rejecting a bound DingTalk user outside the allowlist
- allowing a bound DingTalk user via member-group membership
- exposing and updating allowlists through form-share config
- blocking allowlists on fully public mode
- rendering the new user-facing rejection message

## Claude Code CLI

This turn included read-only `claude -p` checks to sanity-check the product wording and minimum-safe scope.

One returned sentence was:

> Share this form with specific members or groups in your workspace — they'll sign in with DingTalk to verify their identity before filling it out.
