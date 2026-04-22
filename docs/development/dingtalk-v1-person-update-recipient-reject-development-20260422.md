# DingTalk V1 Person Update Recipient Reject Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-update-recipient-reject-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already had update coverage for top-level `actionConfig` recipient rejection and V1 `actions[]` link rejection. The remaining update-route gap was V1 `actions[]` person actions without an effective recipient source.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with one `PATCH /api/multitable/sheets/:sheetId/automations/:ruleId` case:

- Rejects a V1 `send_dingtalk_person_message` action when `userIds`, `memberGroupIds`, and record field paths do not resolve to an effective recipient source.

The test asserts:

- HTTP 400
- `VALIDATION_ERROR`
- the expected recipient validation message
- `automationService.getRule` is called to validate the merged next state
- `automationService.updateRule` is not called

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users edit an automation rule that sends DingTalk person messages through V1 `actions[]`, updates with no effective recipient source are rejected before the rule is saved.
