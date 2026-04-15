# DingTalk Runtime Status Frontend Development

Date: 2026-04-14
Branch: `codex/dingtalk-identity-frontend-20260414`

## Goal

Consume the new DingTalk runtime-status payload on the frontend without reopening the login protocol.

## Changes

### LoginView

Updated [apps/web/src/views/LoginView.vue](/Users/chouhua/Downloads/Github/metasheet2-dingtalk-frontend/apps/web/src/views/LoginView.vue:1):

- probe response is now parsed as a structured DingTalk runtime-status payload
- DingTalk button only renders when `available === true`
- when probe succeeds but reports unavailable, the page shows a stable hint instead of silently hiding the path
- current hint mapping covers:
  - corp allowlist blocked
  - missing OAuth config
  - generic unavailable state

### UserManagementView

Updated [apps/web/src/views/UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2-dingtalk-frontend/apps/web/src/views/UserManagementView.vue:1):

- `DingTalkAccess` now accepts the backend `server` block
- admin panel shows:
  - whether server-side DingTalk login is enabled
  - current runtime status summary
  - configured `corpId`
  - allowlist values when present

This keeps the admin page aligned with the backend probe surface and makes it easier to distinguish:

- server misconfiguration
- corp allowlist rejection
- user grant state
- identity binding state

## Test Updates

- [apps/web/tests/LoginView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2-dingtalk-frontend/apps/web/tests/LoginView.spec.ts:1)
- [apps/web/tests/userManagementView.spec.ts](/Users/chouhua/Downloads/Github/metasheet2-dingtalk-frontend/apps/web/tests/userManagementView.spec.ts:1)

## Notes

- Scope is intentionally limited to frontend consumption of the new backend/runtime shape.
- No callback flow semantics were changed.
- No unrelated DingTalk pages were modified in this lane.
