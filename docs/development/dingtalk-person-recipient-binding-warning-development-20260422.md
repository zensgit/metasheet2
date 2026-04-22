# DingTalk Person Recipient Binding Warning Development - 2026-04-22

## Goal

Make the "Send DingTalk person message" recipient picker show whether a selected local user can actually receive DingTalk direct messages, and whether DingTalk form authorization is enabled.

This keeps person-message recipients based on local users/member groups while making DingTalk delivery readiness visible before users save an automation rule.

## Scope

- `GET /api/multitable/sheets/:sheetId/form-share-candidates` now enriches user candidates with DingTalk status fields:
  - `dingtalkBound`: true when the local user has a DingTalk external identity or an active linked DingTalk directory account.
  - `dingtalkGrantEnabled`: true when the local user has an enabled DingTalk external auth grant.
  - `dingtalkPersonDeliveryAvailable`: true when the local user has an active linked DingTalk directory account with an external DingTalk user ID, matching the person-message executor requirement.
- Member-group candidates return the same DingTalk fields as `null`, because group delivery is evaluated per member at send time.
- The generic `/permission-candidates` endpoint is not changed.

## Frontend Behavior

- Inline automation form and advanced rule editor both show DingTalk status on person-message search candidates.
- The selected recipient chips preserve the same status after the user adds a candidate.
- Inactive local users remain disabled.
- Unsupported role candidates remain filtered out for DingTalk person-message recipients.
- Binding and grant status is UI-only metadata; automation payloads still submit only local `userIds`, `memberGroupIds`, and dynamic recipient field paths.

## User-Facing Labels

- `DingTalk direct message ready; form authorization enabled`
- `DingTalk direct message ready; form authorization not enabled`
- `No DingTalk delivery link; person message will skip until linked`
- `Not bound to DingTalk; person message may skip until linked`
- `Member group members are checked individually for DingTalk delivery`

## Files Changed

- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-client.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Notes

- Direct person delivery readiness intentionally follows the existing executor lookup: active DingTalk `directory_account_links` plus active `directory_accounts.external_user_id`.
- A DingTalk OAuth identity alone marks `dingtalkBound` true, but `dingtalkPersonDeliveryAvailable` remains false until directory delivery linkage exists.
- This slice does not block saves for unlinked users. Delivery history already records skipped users when the executor cannot resolve a DingTalk recipient.
