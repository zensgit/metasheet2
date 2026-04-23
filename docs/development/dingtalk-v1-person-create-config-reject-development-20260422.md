# DingTalk V1 Person Create Config Reject Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-create-config-reject-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already had create coverage for V1 `actions[]` DingTalk person invalid links and invalid recipients. The remaining create-route gap was invalid V1 action config shape and missing executable template fields.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with two `POST /api/multitable/sheets/:sheetId/automations` cases:

- Rejects a V1 `send_dingtalk_person_message` action when `config` is not an object.
- Rejects a V1 `send_dingtalk_person_message` action when executable templates are missing or blank.

Both tests assert:

- HTTP 400
- `VALIDATION_ERROR`
- the expected config/template validation message
- `automationService.createRule` is not called

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users create an automation rule that sends DingTalk person messages through V1 `actions[]`, invalid action config payloads are rejected before the rule is saved.
