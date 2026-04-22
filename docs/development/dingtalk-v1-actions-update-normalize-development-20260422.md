# DingTalk V1 Actions Update Normalize Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-actions-update-normalize-20260422`
- Scope: backend route-level integration coverage

## Context

The automation route already covered V1 `actions[]` normalization on create and several update rejection paths. The remaining update-side gap was a successful V1 DingTalk group action update using legacy `title` and `content` fields.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with one `PATCH /api/multitable/sheets/:sheetId/automations/:ruleId` success case:

- Updates a V1 `send_dingtalk_group_message` action with legacy `title` and `content`.
- Verifies the route normalizes them to `titleTemplate` and `bodyTemplate` before calling `automationService.updateRule`.
- Verifies the response includes the normalized action config.
- Verifies valid public form and internal links are checked on the success path.

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users update a V1 DingTalk group automation action through legacy title/content fields, the route-level contract preserves normalized executable templates before saving the rule.
