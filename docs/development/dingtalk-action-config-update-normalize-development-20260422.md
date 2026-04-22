# DingTalk Action Config Update Normalize Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-action-config-update-normalize-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already covered V1 `actions[]` normalization on update. The remaining top-level update gap was `actionConfig` normalization through the `normalizedActionConfigForUpdate` branch.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with one `PATCH /api/multitable/sheets/:sheetId/automations/:ruleId` success case:

- Updates a top-level `send_dingtalk_group_message` `actionConfig` with legacy `title` and `content`.
- Verifies the route normalizes them to `titleTemplate` and `bodyTemplate` before calling `automationService.updateRule`.
- Verifies the serialized response includes the normalized action config.
- Verifies valid public form and internal links are checked on the success path.

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users update a top-level DingTalk group automation through legacy title/content fields, the route-level contract preserves normalized executable templates before saving the rule.
