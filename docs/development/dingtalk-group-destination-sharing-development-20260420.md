# DingTalk Group Destination Sharing Development

## Date
- 2026-04-20

## Goal
- Evolve DingTalk group destinations from creator-private entries into sheet-shared destinations so a table's automation managers can reuse the same group configuration without duplicating webhook setup.

## Scope
- Add nullable `sheet_id` scope to `dingtalk_group_destinations`
- Preserve legacy private rows with owner fallback
- Pass `sheetId` through multitable client and management surfaces
- Gate shared destination access by sheet automation capability
- Add focused frontend/backend regression coverage

## Implementation

### Schema
- Added `packages/core-backend/src/db/migrations/zzzz20260420164500_add_sheet_scope_to_dingtalk_group_destinations.ts`
  - adds nullable `sheet_id`
  - adds `idx_dingtalk_group_destinations_sheet_id`
- Updated `packages/core-backend/src/db/types.ts`
  - `dingtalk_group_destinations.sheet_id: string | null`

### Backend
- Updated `packages/core-backend/src/multitable/dingtalk-group-destinations.ts`
  - `DingTalkGroupDestination.sheetId?: string`
  - `DingTalkGroupDestinationCreateInput.sheetId?: string`
- Updated `packages/core-backend/src/multitable/dingtalk-group-destination-service.ts`
  - persists `sheet_id` on create
  - `listDestinations(userId, sheetId?)` returns:
    - sheet-shared rows for the current sheet
    - plus legacy private rows owned by the current user
  - `updateDestination` / `deleteDestination` / `testSend` accept optional `sheetId`
  - shared rows authorize by matching `sheet_id`
  - legacy rows keep owner-only authorization
- Updated `packages/core-backend/src/routes/api-tokens.ts`
  - DingTalk group CRUD/test-send/deliveries accept `sheetId`
  - added `requireSheetAutomationAccess(...)`
  - shared access is guarded by `resolveSheetCapabilitiesForUser(...).canManageAutomation`

### Frontend
- Updated `apps/web/src/multitable/types.ts`
  - group destination/input include `sheetId`
- Updated `apps/web/src/multitable/api/client.ts`
  - group destination list/update/delete/test-send/delivery APIs now carry `sheetId`
- Updated `apps/web/src/multitable/views/MultitableWorkbench.vue`
  - passes active `sheetId` into `MetaApiTokenManager`
- Updated `apps/web/src/multitable/components/MetaApiTokenManager.vue`
  - reads/writes DingTalk groups in sheet scope
  - marks rows as:
    - `Shared with this sheet`
    - `Private legacy group`
- Updated `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
  - loads DingTalk destinations with current `sheetId`
- Updated `apps/web/src/multitable/components/MetaAutomationManager.vue`
  - loads DingTalk destinations with current `sheetId`

### Tests
- Updated `packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts`
  - shared non-owner update/delete/test-send coverage
  - sheet-scoped create/list coverage
- Updated `apps/web/tests/multitable-api-token-manager.spec.ts`
  - asserts sheet-scoped group CRUD/delivery URLs
- Updated `apps/web/tests/multitable-automation-rule-editor.spec.ts`
  - asserts group destination fetch uses `sheetId`
- Updated `apps/web/tests/multitable-automation-manager.spec.ts`
  - asserts inline DingTalk group authoring/delivery viewer uses sheet-scoped APIs

## Files Changed
- `packages/core-backend/src/db/migrations/zzzz20260420164500_add_sheet_scope_to_dingtalk_group_destinations.ts`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/multitable/dingtalk-group-destinations.ts`
- `packages/core-backend/src/multitable/dingtalk-group-destination-service.ts`
- `packages/core-backend/src/routes/api-tokens.ts`
- `packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/src/multitable/components/MetaApiTokenManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-api-token-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Notes
- This is intentionally incremental:
  - new rows can be sheet-shared
  - old rows stay private until admins recreate or migrate them
- I also used `claude -p` in read-only mode to sanity-check the incremental scope choice; implementation and verification were completed directly in the repo.
