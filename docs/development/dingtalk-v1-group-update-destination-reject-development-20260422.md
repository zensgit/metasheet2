# DingTalk V1 Group Update Destination Reject Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-group-update-destination-reject-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already rejects invalid top-level DingTalk group update configs and invalid V1 DingTalk person update configs. The remaining route-level update gap was the V1 `actions[]` path for `send_dingtalk_group_message` when no effective group destination source is supplied.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with one `PATCH /api/multitable/sheets/:sheetId/automations/:ruleId` case:

- Rejects a V1 `send_dingtalk_group_message` action when updated `actions[]` has no effective destination.

The test asserts:

- HTTP 400
- `VALIDATION_ERROR`
- `At least one DingTalk destination or record destination field path is required`
- `automationService.getRule` is called to load the existing rule state
- `automationService.updateRule` is not called
- no `meta_views` link validation query is made after config validation fails

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users update a V1 DingTalk group automation action, invalid destination configuration is rejected before the rule is saved or link validation runs.
