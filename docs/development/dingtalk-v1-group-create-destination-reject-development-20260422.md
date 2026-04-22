# DingTalk V1 Group Create Destination Reject Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-group-create-destination-reject-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already rejects invalid top-level DingTalk group create configs and invalid V1 DingTalk group update configs. The remaining create-side V1 gap was `actions[]` `send_dingtalk_group_message` with no effective destination source.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with one `POST /api/multitable/sheets/:sheetId/automations` case:

- Rejects a V1 `send_dingtalk_group_message` action when created `actions[]` has no effective destination.

The test asserts:

- HTTP 400
- `VALIDATION_ERROR`
- `At least one DingTalk destination or record destination field path is required`
- `automationService.createRule` is not called
- no `meta_views` link validation query is made after config validation fails

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users create a V1 DingTalk group automation action, invalid destination configuration is rejected before the rule is saved or link validation runs.
