# DingTalk Person Delivery Skip Reasons Development - 2026-04-22

## Goal

Make DingTalk direct-person delivery history distinguish three outcomes:

- `success`: message was sent to a bound DingTalk user.
- `failed`: DingTalk API/config/send failed for a resolved recipient.
- `skipped`: the local user could not receive a DingTalk person message because the user is inactive or has no active linked DingTalk account.

This closes the P3 delivery-history gap in the DingTalk feature plan without changing the local-user/member-group permission model.

## Changes

- Added `status` to `dingtalk_person_deliveries` through a forward migration.
- Backfilled existing rows:
  - successful rows become `success`
  - existing unlinked/inactive rows become `skipped`
  - other failed rows remain `failed`
- Updated the automation executor so unlinked/inactive recipients are recorded as `skipped`.
- Mixed-recipient person actions now continue sending to linked recipients instead of failing the whole action before send.
- If all recipients are unlinked/inactive, the person action returns a skipped step with `skippedRecipientCount` and `skippedUserIds`.
- Updated person delivery listing to expose the normalized `status`.
- Updated the automation person-delivery viewer to show and filter `Skipped / unbound` records.

## Files Changed

- `packages/core-backend/src/db/migrations/zzzz20260422225000_add_dingtalk_person_delivery_status.ts`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
- `packages/core-backend/tests/unit/dingtalk-person-delivery-service.test.ts`
- `packages/core-backend/tests/integration/dingtalk-delivery-routes.api.test.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/components/MetaAutomationPersonDeliveryViewer.vue`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Behavior Notes

- A single unbound user no longer prevents other bound recipients from receiving the DingTalk person message.
- Fully unbound recipient sets are classified as skipped rather than failed.
- API consumers should prefer `delivery.status`; `delivery.success` remains for backward compatibility.
