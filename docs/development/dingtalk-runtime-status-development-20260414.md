# DingTalk Runtime Status Development

Date: 2026-04-14
Branch: `codex/dingtalk-identity-runtime-20260414`

## Goal

Expose one stable backend runtime-status shape for DingTalk login and admin pages without changing the login callback flow.

## Changes

### 1. Shared runtime status helper

Added `getDingTalkRuntimeStatus()` in `packages/core-backend/src/auth/dingtalk-oauth.ts`.

Returned shape:

- `configured`
- `available`
- `corpId`
- `allowedCorpIds`
- `requireGrant`
- `autoLinkEmail`
- `autoProvision`
- `unavailableReason`

Current machine-friendly `unavailableReason` values:

- `missing_client_id`
- `missing_client_secret`
- `missing_redirect_uri`
- `corp_not_allowed`

### 2. Login probe now returns useful status

Updated `GET /api/auth/dingtalk/launch?probe=1` in `packages/core-backend/src/routes/auth.ts`.

Previous behavior:

- returned only `{ available: true }`

Current behavior:

- returns the full runtime status payload
- still avoids generating OAuth state during probe
- normal launch and callback behavior remain unchanged

### 3. Admin DingTalk access snapshot now includes server status

Updated `fetchDingTalkAccessSnapshot()` in `packages/core-backend/src/routes/admin-users.ts`.

The existing snapshot now includes:

- legacy top-level auth mode flags for compatibility
- a new `server` block containing the same runtime status payload returned by the login probe

This lets admin pages distinguish:

- server not configured
- corp blocked by allowlist
- grant missing
- identity missing

without inventing a second status model on the frontend.

## Files Changed

- `packages/core-backend/src/auth/dingtalk-oauth.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/tests/unit/auth-login-routes.test.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `packages/core-backend/tests/unit/dingtalk-oauth-login-gates.test.ts`

## Notes

- Scope was intentionally backend-only.
- No frontend files were modified.
- The existing launch and callback success paths were left intact.
