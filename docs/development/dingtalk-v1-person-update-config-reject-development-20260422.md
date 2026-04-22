# DingTalk V1 Person Update Config Reject Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-update-config-reject-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already had update coverage for V1 `actions[]` DingTalk person invalid links and invalid recipients. The remaining update-route gap was invalid V1 action config shape and missing executable template fields.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with two `PATCH /api/multitable/sheets/:sheetId/automations/:ruleId` cases:

- Rejects a V1 `send_dingtalk_person_message` action when `config` is not an object.
- Rejects a V1 `send_dingtalk_person_message` action when executable templates are missing or blank.

Both tests assert:

- HTTP 400
- `VALIDATION_ERROR`
- the expected config/template validation message
- `automationService.getRule` is called to validate the merged next state
- `automationService.updateRule` is not called

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users edit an automation rule that sends DingTalk person messages through V1 `actions[]`, invalid action config payloads are rejected before the rule is saved.
