# DingTalk Group Rule Deliveries Development

## Date
- 2026-04-20

## Goal
- Add rule-level DingTalk group delivery visibility to multitable automation management so `send_dingtalk_group_message` matches the existing person-delivery governance path.

## Scope
- Backend automation-scoped group delivery query service and route
- Frontend API/client/types for automation-scoped group deliveries
- Automation Manager group delivery viewer and button wiring
- Focused frontend/backend regression coverage

## Implementation

### Backend
- Added `packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts`
  - `listAutomationDingTalkGroupDeliveries(queryFn, ruleId, limit)`
  - joins `dingtalk_group_deliveries` with `dingtalk_group_destinations`
  - returns `destinationName` alongside the existing delivery payload
  - clamps `limit` to `1..200`
- Updated `packages/core-backend/src/routes/univer-meta.ts`
  - added `GET /api/multitable/sheets/:sheetId/automations/:ruleId/dingtalk-group-deliveries`
  - reuses sheet capability guard and automation ownership check

### Frontend
- Extended `apps/web/src/multitable/types.ts`
  - `DingTalkGroupDelivery.destinationName?: string`
- Extended `apps/web/src/multitable/api/client.ts`
  - `getAutomationDingTalkGroupDeliveries(sheetId, ruleId, limit?)`
- Added `apps/web/src/multitable/components/MetaAutomationGroupDeliveryViewer.vue`
  - status filter
  - refresh action
  - grouped delivery list with destination, status, created time, subject, and error message
- Updated `apps/web/src/multitable/components/MetaAutomationManager.vue`
  - added `View Deliveries` button for `send_dingtalk_group_message`
  - added group delivery overlay state and viewer mounting

### Tests
- Added `packages/core-backend/tests/unit/dingtalk-group-delivery-service.test.ts`
- Updated `apps/web/tests/multitable-automation-manager.spec.ts`
  - mocked `/dingtalk-group-deliveries`
  - added group delivery viewer regression

## Files Changed
- `packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/unit/dingtalk-group-delivery-service.test.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/components/MetaAutomationGroupDeliveryViewer.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Notes
- No schema change was required because group delivery rows already store `automation_rule_id`.
- This change intentionally mirrors the existing person-delivery viewer instead of introducing another destination-level entry point.
