# DingTalk V1 Person Link Route Success Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-link-route-success-20260422`
- Scope: backend route-level V1 DingTalk person action coverage

## Goal

Close the remaining route-level success coverage gap for V1 automation rules that store DingTalk person messaging inside `actions[]`.

The previous slice covered top-level `send_dingtalk_person_message` create with valid public-form and internal-processing links. This slice covers the advanced/V1 shape where the top-level action is `notify` and the DingTalk person message lives in the multi-action list.

## Implementation

- Added an integration test for `POST /api/multitable/sheets/:sheetId/automations`.
- The test creates a V1 rule with:
  - `actionType: notify`
  - `actions[]` containing `send_dingtalk_person_message`
  - `userIds`
  - legacy `title` / `content` input
  - valid `publicFormViewId`
  - valid `internalViewId`
- The test asserts:
  - route returns success
  - `createRule` receives top-level `notify`
  - `actions[0].config` is normalized to `titleTemplate` / `bodyTemplate`
  - public form and internal view IDs are preserved
  - the response rule returns canonical camelCase `actions[]`

## Files

- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`

## Notes

- This is a coverage-only change.
- No runtime, API contract, database, or frontend behavior changes are intended.
