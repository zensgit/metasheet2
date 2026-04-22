# DingTalk Update Config Reject Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-update-config-reject-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already rejects invalid V1 DingTalk actions on update. The remaining top-level update gaps were direct `actionConfig` validation for:

- `send_dingtalk_group_message` without an effective destination source.
- `send_dingtalk_person_message` without executable message templates.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with two `PATCH /api/multitable/sheets/:sheetId/automations/:ruleId` cases:

- Rejects a top-level `send_dingtalk_group_message` action when updated `actionConfig` has no effective destination.
- Rejects a top-level `send_dingtalk_person_message` action when updated `actionConfig` has a blank `titleTemplate`.

The tests assert:

- HTTP 400
- `VALIDATION_ERROR`
- the expected destination/template validation message
- `automationService.getRule` is called to merge the existing rule state
- `automationService.updateRule` is not called

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users update a top-level DingTalk automation rule, invalid group destinations and invalid person message templates are rejected before the rule is saved.
