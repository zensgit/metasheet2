# DingTalk Group Notify Review Hardening Development — 2026-04-19

## Scope

This slice hardens PR `#919` against the first round of review feedback without expanding the P0 feature boundary.

Addressed concerns:

- DingTalk webhook access tokens should not be exposed in the destination list UI
- DingTalk send paths should have explicit request timeout protection

## Changes

### UI masking

Updated:

- `apps/web/src/multitable/components/MetaApiTokenManager.vue`

Behavior change:

- DingTalk destination cards now show a masked webhook URL in read-only display
- sensitive query keys such as `access_token`, `timestamp`, and `sign` are replaced with `***`

Note:

- Edit form behavior remains unchanged; this slice only hardens the passive list display

### Request timeout protection

Updated:

- `packages/core-backend/src/multitable/dingtalk-group-destination-service.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`

Behavior change:

- manual DingTalk `test-send` now uses `AbortController`
- automation `send_dingtalk_group_message` now uses `AbortController`
- both paths clear timeout handles in `finally`

This aligns DingTalk sends with the repository’s existing webhook timeout pattern.

## Tests Updated

- `apps/web/tests/multitable-api-token-manager.spec.ts`
- `packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
