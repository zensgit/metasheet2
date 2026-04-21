# DingTalk Delivery Viewer Errors Development - 2026-04-21

## Background

Automation DingTalk delivery history is now part of the standard table-trigger workflow. The backend returns explicit `403`, `404`, and `500` responses for delivery history routes, but the frontend delivery viewers previously swallowed load failures and rendered the same empty state as a valid empty history.

That behavior is misleading for administrators because a permission, route, or server problem looks like "no DingTalk deliveries yet".

## Changes

- Updated `MetaAutomationGroupDeliveryViewer.vue`.
- Updated `MetaAutomationPersonDeliveryViewer.vue`.
- Added an explicit error state for failed delivery history loads.
- Cleared stale errors whenever a refresh starts.
- Disabled the refresh button while a load is already in progress.
- Kept the existing empty state only for successful empty responses.
- Added frontend coverage in `apps/web/tests/multitable-automation-manager.spec.ts`.

## User-Facing Behavior

- Successful delivery history loads are unchanged.
- Empty successful responses still show the existing empty-history message.
- Failed group delivery history loads now show the backend error message in the group delivery dialog.
- Failed person delivery history loads now show the backend error message in the person delivery dialog.
- Error states no longer render stale delivery rows or the empty-history message.

## Notes

This slice does not call DingTalk directly. It improves the standard UI around the already-defined delivery history APIs so administrators can distinguish "no deliveries" from "delivery history failed to load".
