# Public Form Auth Hotfix And Live DingTalk Form Development - 2026-04-20

## Goal

Unblock the real end-to-end flow:

- create a minimal multitable form
- open it from a DingTalk group message
- allow anonymous public form load and submit without a Bearer token

## Problem Found

The live environment already had:

- DingTalk group messaging
- public form routes
- public form share config

But the real flow still failed because the global JWT gate in `packages/core-backend/src/index.ts` protected **all** `/api/**` paths unless they matched the static whitelist in `packages/core-backend/src/auth/jwt-middleware.ts`.

That unintentionally blocked the public form endpoints:

- `GET /api/multitable/form-context?publicToken=...`
- `POST /api/multitable/views/:viewId/submit?publicToken=...`

The live symptom was:

```json
{"ok":false,"error":{"code":"UNAUTHORIZED","message":"Missing Bearer token"}}
```

## Code Fix

Implemented a token-gated public-form bypass:

- Added `isPublicFormAuthBypass(...)` in [jwt-middleware.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/public-form-auth-hotfix-20260420/packages/core-backend/src/auth/jwt-middleware.ts:1)
- Wired it into the global gate in [index.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/public-form-auth-hotfix-20260420/packages/core-backend/src/index.ts:1)

The bypass is intentionally narrow:

- exact path + method only
- requires a non-empty `publicToken`
- does **not** widen access to unrelated `/api/multitable/**` endpoints

Allowed:

- `GET /api/multitable/form-context` with `publicToken`
- `POST /api/multitable/views/:viewId/submit` with `publicToken`

Not allowed:

- sibling `/api/multitable/views/:viewId`
- the same public-form endpoints without token

## Test Coverage Added

Updated [jwt-middleware.test.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/public-form-auth-hotfix-20260420/packages/core-backend/tests/unit/jwt-middleware.test.ts:1) to cover:

- public form context bypass with token
- public form submit bypass with token
- rejection of sibling multitable paths
- rejection when token is missing

## Live Validation Asset Created

Created a real minimal verification sheet directly in the remote database:

- sheet: `sheet_dingtalk_form_demo_20260420`
- public form view: `view_form_dingtalk_demo_20260420`
- internal grid view: `view_grid_dingtalk_demo_20260420`

Fields:

- `姓名`
- `手机号`
- `需求说明`

Public token:

- `pub_dingtalk_demo_20260420`

Public form URL:

- `http://142.171.239.56:8081/multitable/public-form/sheet_dingtalk_form_demo_20260420/view_form_dingtalk_demo_20260420?publicToken=pub_dingtalk_demo_20260420`

## Live Runtime Handling

Because the user asked to continue immediately and validate the live DingTalk link now, the backend runtime was temporarily hot-patched **before merge**:

- copied rebuilt `dist/src/index.js`
- copied rebuilt `dist/src/auth/jwt-middleware.js`
- restarted `metasheet-backend`

This makes the live environment functional now, while the permanent source-of-truth fix is tracked in PR `#931`.

## PR

- PR: `#931`
- URL: `https://github.com/zensgit/metasheet2/pull/931`
- Commit: `3028faa12`

## Claude Code CLI

Used `claude -p` in read-only mode to sanity-check the safest minimal whitelist shape before implementing the fix. The actual code change, test run, remote patch, form creation, and DingTalk send were executed directly.
