# DingTalk Group Permission Panel Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-permission-panel-20260422`
- Scope: frontend DingTalk group destination management

## Goal

Align the DingTalk Groups management UI with the existing backend permission boundary.

Before this slice, the `API Tokens, Webhooks & DingTalk Groups` modal always exposed the DingTalk Groups tab and preloaded `/api/multitable/dingtalk-groups?sheetId=...`. For users without table automation management permission, the backend correctly returned 403, but the frontend still looked actionable and could show a generic error.

## Implementation

- Added `canManageAutomation` to `MetaApiTokenManager`.
- Passed `caps.canManageAutomation.value` from `MultitableWorkbench`.
- Defaulted `canManageAutomation` to `true` for standalone component compatibility.
- When permission is unavailable:
  - the modal title downgrades to `API Tokens & Webhooks`
  - the DingTalk Groups tab is hidden
  - the component does not preload DingTalk group destinations
  - a permission note explains that DingTalk group bindings require table automation management permission
  - any stale DingTalk group state is cleared
- Guarded DingTalk group mutation/read-detail handlers against programmatic invocation when permission is unavailable.
- Updated component tests to prove low-permission users do not trigger DingTalk group API calls.

## Files

- `apps/web/src/multitable/components/MetaApiTokenManager.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/tests/multitable-api-token-manager.spec.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- This does not change backend RBAC. The server remains the source of truth.
- This improves the frontend affordance so ordinary table users do not see a group-binding tab they cannot use.
- A table can still have multiple DingTalk group destinations when managed by an authorized user.
