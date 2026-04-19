# DingTalk Person Delivery History Development

- Date: 2026-04-19
- Branch: `codex/dingtalk-person-notify-20260419`
- Scope: surface `send_dingtalk_person_message` delivery history in automation management

## Goal

Close the governance gap for direct DingTalk personal notifications:

- keep recipient-level delivery records queryable by automation rule
- expose those records in the multitable automation UI
- do it without changing the existing automation payload or execution contract

## Backend

Added a focused query helper:

- `packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts`

Behavior:

- reads `dingtalk_person_deliveries` by `automation_rule_id`
- joins `users` to surface:
  - `localUserLabel`
  - `localUserSubtitle`
  - `localUserIsActive`
- normalizes DB rows into API-facing camelCase fields
- clamps `limit` to `1..200`

Added a mounted API route in `univer-meta.ts`:

- `GET /api/multitable/sheets/:sheetId/automations/:ruleId/dingtalk-person-deliveries`

Guardrails:

- requires `sheetId` and `ruleId`
- reuses `resolveSheetCapabilities(...)`
- requires `canManageAutomation`
- verifies the target automation rule exists and belongs to the current sheet

## Frontend

Added a new viewer component:

- `apps/web/src/multitable/components/MetaAutomationPersonDeliveryViewer.vue`

Behavior:

- modal viewer for person delivery history
- refresh action
- success/failed filter
- shows:
  - local user label
  - inactive user hint
  - DingTalk user id
  - subject
  - error message when failed
  - created time

Integrated it into automation management:

- `apps/web/src/multitable/components/MetaAutomationManager.vue`

Behavior:

- rules with `actionType === 'send_dingtalk_person_message'` now show `View Deliveries`
- button opens the new viewer bound to the selected rule

Extended client/types:

- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/api/client.ts`

Added:

- `DingTalkPersonDelivery`
- `getAutomationDingTalkPersonDeliveries(sheetId, ruleId, limit?)`

## Tests

Added focused backend coverage:

- `packages/core-backend/tests/unit/dingtalk-person-delivery-service.test.ts`

Added focused frontend coverage:

- `apps/web/tests/multitable-automation-manager.spec.ts`

Scenario covered:

- open delivery viewer from a person-notify automation rule
- load and render recipient delivery history

## Notes

- No migration changes in this slice
- No remote deployment in this slice
- Existing `plugins/**/node_modules` and `tools/cli/node_modules` workspace noise was intentionally left out of the code changes
