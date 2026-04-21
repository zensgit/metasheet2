# DingTalk Automation Link Route Tests Development

Date: 2026-04-21
Branch: `codex/dingtalk-automation-link-route-tests-20260421`
Base: `codex/dingtalk-public-form-save-validation-20260421`

## Goal

Lock the DingTalk automation link save-validation behavior at the real API route layer.

The previous slice added a shared validator and unit coverage. This slice verifies that `POST /api/multitable/sheets/:sheetId/automations` and `PATCH /api/multitable/sheets/:sheetId/automations/:ruleId` actually call that validator before persisting rules.

## Changes

- Added `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`.
- The test mounts `univerMetaRouter()` with a mocked pool and mocked `AutomationService`.
- Covered invalid public form links before `createRule`.
- Covered valid public form plus internal processing links flowing to `createRule`.
- Covered invalid internal processing links before `createRule`.
- Covered V1 `actions[]` validation.
- Covered PATCH merged-state validation before `updateRule`.
- Covered enable-only PATCH bypassing link revalidation.

## Review Fixes

- Tightened the enable-only bypass assertion to inspect the actual SQL string in
  `mockPool.query.mock.calls`. The previous `not.toHaveBeenCalledWith(...,
  expect.anything())` form could miss a future `query(sql)` call because
  `expect.anything()` does not match `undefined`.
- Added a route-level negative case for invalid `internalViewId`, so the route
  wiring now proves both public form and internal processing links are rejected
  before persistence.

## Behavioral Contract

- Cross-sheet `publicFormViewId` is rejected as not found for the current sheet.
- Disabled public form links are rejected before persistence.
- Expired public form links are rejected before persistence.
- Missing internal processing views are rejected before persistence.
- Valid public form and internal view links are accepted.
- Updating only `enabled` does not revalidate stale links, preserving low-risk operational toggles.

## Risk Notes

- This slice intentionally does not change production route logic.
- Runtime public-form access control remains the final authority after a user opens a DingTalk message link.
- Fully public or DingTalk-protected-without-allowlist form states remain advisory and are not changed here.
