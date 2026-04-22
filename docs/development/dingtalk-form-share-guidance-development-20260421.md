# DingTalk Form Share Guidance Development

Date: 2026-04-21

## Scope

This change improves the discoverability and frontend guidance for using DingTalk-protected public forms with local user/member-group allowlists.

## Changes

- Clarified the form share manager empty allowlist messages:
  - no local user allowlist means the selected DingTalk mode still gates access
  - adding local users or member groups narrows who can fill the form
  - no local member-group allowlist suggests adding a local member group for group-based filling
- Extended `multitable-form-share-manager.spec.ts` to lock the key DingTalk allowlist guidance:
  - DingTalk is only the sign-in and delivery channel
  - allowlists target local users and member groups
  - both `dingtalk` and `dingtalk_granted` access modes show allowlist controls
- Added DingTalk operations guide links to:
  - `README.md`
  - `docs/INDEX.md`
- Added a quick entry section to `docs/dingtalk-admin-operations-guide-20260420.md` for:
  - DingTalk group notification rules
  - public form sharing
  - protected allowlists for selected users/member groups

## User Impact

Table owners now get clearer frontend guidance that sending a form link through DingTalk does not mean raw DingTalk group membership controls filling permissions. Filling permissions are narrowed by the system's local users and member groups after the selected DingTalk protection mode is satisfied.

## Files

- `apps/web/src/multitable/components/MetaFormShareManager.vue`
- `apps/web/tests/multitable-form-share-manager.spec.ts`
- `README.md`
- `docs/INDEX.md`
- `docs/dingtalk-admin-operations-guide-20260420.md`
