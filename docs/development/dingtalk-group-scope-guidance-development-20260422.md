# DingTalk Group Scope Guidance Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-scope-guidance-20260422`
- Scope: frontend DingTalk group destination guidance

## Goal

Make the DingTalk Groups management tab explain how group bindings relate to the current table.

Users asked whether a table can bind DingTalk groups from the frontend and whether one table can associate with multiple groups. The underlying implementation already supports table-scoped DingTalk group destinations and automation rules can choose one or more groups. This slice makes that model visible in the manager UI.

## Implementation

- Added a guidance note at the top of the DingTalk Groups tab.
- Reused the existing `meta-api-mgr__notice` visual style.
- The note states:
  - groups created here are bound to the current table
  - multiple groups can be added
  - automations can choose one or more groups as send targets
- Updated the existing DingTalk Groups component test to assert the guidance is present.
- Updated the DingTalk operations and capability docs.

## Files

- `apps/web/src/multitable/components/MetaApiTokenManager.vue`
- `apps/web/tests/multitable-api-token-manager.spec.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- This does not change backend APIs, migrations, or permissions.
- Authorized users can still create multiple DingTalk group destinations for one table.
- Low-permission users still do not see the DingTalk Groups tab, as implemented in the previous slice.
