# DingTalk Person Link Route Success Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-person-link-route-success-20260422`
- Scope: backend route-level DingTalk person automation coverage

## Goal

Close the backend route coverage gap for valid top-level DingTalk person-message automations that include both:

- a public form link
- an internal processing link

Group-message route coverage already asserted this success path. Person-message validation shared the same backend link validation code, but only invalid person create/update cases were covered at the route level.

## Implementation

- Added an integration test for `POST /api/multitable/sheets/:sheetId/automations`.
- The test creates a top-level `send_dingtalk_person_message` rule with:
  - `userIds`
  - legacy `title` / `content` input
  - valid `publicFormViewId`
  - valid `internalViewId`
- The test asserts:
  - route returns success
  - `createRule` receives `send_dingtalk_person_message`
  - `title` / `content` are normalized to `titleTemplate` / `bodyTemplate`
  - public form and internal view IDs are preserved in the persisted action config
  - the response rule is canonical camelCase

## Files

- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`

## Notes

- This is a coverage-only change.
- No runtime, API contract, database, or frontend behavior changes are intended.
