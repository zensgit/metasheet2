# DingTalk Person Create Config Reject Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-person-create-config-reject-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already had create coverage for valid top-level DingTalk person rules and extensive V1 `actions[]` rejection coverage. The remaining top-level create gap was invalid `send_dingtalk_person_message` action config.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with two `POST /api/multitable/sheets/:sheetId/automations` cases:

- Rejects a top-level `send_dingtalk_person_message` rule when no effective recipient source exists.
- Rejects a top-level `send_dingtalk_person_message` rule when executable templates are missing or blank.

Both tests assert:

- HTTP 400
- `VALIDATION_ERROR`
- the expected recipient/template validation message
- `automationService.createRule` is not called

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users create a top-level DingTalk person automation rule, invalid recipient or template configuration is rejected before the rule is saved.
