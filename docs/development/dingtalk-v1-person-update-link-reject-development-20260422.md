# DingTalk V1 Person Update Link Reject Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-update-link-reject-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already covered invalid V1 `actions[]` DingTalk person links on create. The remaining route-level gap was update behavior: editing an existing automation rule with invalid V1 person action links should be rejected before persistence.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with two `PATCH /api/multitable/sheets/:sheetId/automations/:ruleId` cases:

- Rejects a V1 `send_dingtalk_person_message` action with an invalid public-form link.
- Rejects a V1 `send_dingtalk_person_message` action with an invalid internal-processing link.

Both tests assert:

- HTTP 400
- `VALIDATION_ERROR`
- the expected link-validation message
- `automationService.getRule` is called to merge and validate the next state
- `automationService.updateRule` is not called

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users edit an automation rule that sends DingTalk person messages through V1 `actions[]`, invalid public-form or internal links are rejected before the updated rule is saved.
