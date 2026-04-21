# DingTalk Delivery Route Contracts Development - 2026-04-21

## Background

This slice hardens the standard DingTalk automation delivery history APIs:

- `GET /api/multitable/sheets/:sheetId/automations/:ruleId/dingtalk-person-deliveries`
- `GET /api/multitable/sheets/:sheetId/automations/:ruleId/dingtalk-group-deliveries`

The previous route-level limit parser used `Number(req.query.limit) || 50`. That made `limit=0` fall back to `50` instead of clamping to the lower bound `1`, so route behavior differed from the intended `[1, 200]` contract.

## Changes

- Added `parseDingTalkAutomationDeliveryLimit()` in `packages/core-backend/src/routes/univer-meta.ts`.
- Shared the same limit parsing for person and group delivery history routes.
- Preserved default behavior: missing or invalid `limit` defaults to `50`.
- Preserved bounds: finite numeric limits are floored and clamped to `1..200`.
- Added route-level integration coverage in `packages/core-backend/tests/integration/dingtalk-delivery-routes.api.test.ts`.

## Route Contract Covered

- Person delivery history returns `{ ok: true, data: { deliveries } }`.
- Group delivery history returns `{ ok: true, data: { deliveries } }`.
- `limit=0` is passed to the delivery service as `1`.
- Large limits such as `999` are passed to the delivery service as `200`.
- Users without automation management capability receive `403 FORBIDDEN`.
- A rule that is missing or belongs to another sheet returns `404 NOT_FOUND`.
- Delivery services are not called on `403` or `404`.

## Implementation Notes

The tests mock the delivery services directly and assert the limit argument passed by the route. This keeps the regression pinned to the route layer and avoids the service-layer clamp masking route parsing bugs.

The tests keep `poolManager.get()` lightweight while still exercising `resolveSheetCapabilities()` through the router, so permission behavior remains covered without a real database.
