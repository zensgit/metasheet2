# DingTalk Protected Public Form Development

- Date: 2026-04-20
- Branch: `codex/dingtalk-protected-public-form-20260420`
- Base: `codex/public-form-auth-hotfix-20260420` (`#931`)

## Goal

Extend the existing anonymous public-form flow so form sharing can be configured in three modes:

- `public`: anyone with a valid public token can submit
- `dingtalk`: the visitor must authenticate and have a bound DingTalk identity
- `dingtalk_granted`: the visitor must authenticate, have a bound DingTalk identity, and hold an enabled DingTalk auth grant

## Backend changes

### Optional auth hydration on public-form routes

- Added `optionalJwtAuthMiddleware(...)` in [packages/core-backend/src/auth/jwt-middleware.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/packages/core-backend/src/auth/jwt-middleware.ts:1)
- Refactored token verification into shared `hydrateAuthenticatedUser(...)`
- Updated [packages/core-backend/src/index.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/packages/core-backend/src/index.ts:1) so public-form auth bypass still skips required JWT, but now hydrates `req.user` when a bearer token is present

### Public form access modes

- Added `PublicFormAccessMode` support in [packages/core-backend/src/routes/univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/packages/core-backend/src/routes/univer-meta.ts:1)
- Added `normalizePublicFormAccessMode(...)`
- Added DingTalk access evaluation:
  - `loadDingTalkPublicFormAccessState(...)`
  - `evaluateProtectedPublicFormAccess(...)`
- Protected mode checks use:
  - `user_external_identities`
  - `directory_account_links + directory_accounts`
  - `user_external_auth_grants`

### Form share config endpoints

Added:

- `GET /api/multitable/sheets/:sheetId/views/:viewId/form-share`
- `PATCH /api/multitable/sheets/:sheetId/views/:viewId/form-share`
- `POST /api/multitable/sheets/:sheetId/views/:viewId/form-share/regenerate`

These now expose and update:

- `enabled`
- `publicToken`
- `expiresAt`
- `status`
- `accessMode`

### Protected public-form runtime behavior

Updated:

- `GET /api/multitable/form-context`
- `POST /api/multitable/views/:viewId/submit`

Behavior:

- `DINGTALK_AUTH_REQUIRED` when the user must sign in
- `DINGTALK_BIND_REQUIRED` when the signed-in user lacks a bound DingTalk identity
- `DINGTALK_GRANT_REQUIRED` when the signed-in user lacks an enabled DingTalk grant

Protected public forms still use the existing create-only public-form capability model. When the visitor is authenticated and passes the gate, record creation now uses the authenticated actor instead of always writing `created_by = null`.

## Frontend changes

### Form share management

Updated [apps/web/src/multitable/components/MetaFormShareManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/multitable/components/MetaFormShareManager.vue:1):

- added access-mode selector
- added mode hints
- patched config via `PATCH /form-share`

Supported authoring modes:

- `Anyone with the link`
- `Bound DingTalk users only`
- `Authorized DingTalk users only`

### Public form page

Updated [apps/web/src/views/PublicMultitableFormView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/views/PublicMultitableFormView.vue:1):

- when the backend returns `DINGTALK_AUTH_REQUIRED`, it launches DingTalk sign-in automatically
- after launch success, the browser redirects back to the same public-form URL
- `DINGTALK_BIND_REQUIRED` and `DINGTALK_GRANT_REQUIRED` now render explicit user-facing messages

### Client/API typing

Updated:

- [apps/web/src/multitable/types.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/multitable/types.ts:1)
- [apps/web/src/multitable/api/client.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/multitable/api/client.ts:1)

Public-form requests now suppress the global unauthorized redirect so the public-form page can handle DingTalk auth bootstrap itself.

## Tests updated

- [packages/core-backend/tests/unit/jwt-middleware.test.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/packages/core-backend/tests/unit/jwt-middleware.test.ts:1)
- [packages/core-backend/tests/integration/public-form-flow.test.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/packages/core-backend/tests/integration/public-form-flow.test.ts:1)
- [apps/web/tests/public-multitable-form.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/tests/public-multitable-form.spec.ts:1)
- [apps/web/tests/multitable-form-share-manager.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/tests/multitable-form-share-manager.spec.ts:1)

## Claude Code CLI

This branch also recorded a read-only `claude -p` check during implementation:

> Add two protected submission modes on top of the existing anonymous public form: one that auto-identifies DingTalk-bound users, and one that gates access via a DingTalk-granted token.

