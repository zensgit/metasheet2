# DingTalk Organization Destination Catalog Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-org-destination-catalog-20260423`
- Base commit: `cf48825c1`
- Scope: organization-scoped DingTalk group destination catalog v1

## Goal

Allow DingTalk group robot destinations to be shared through an organization catalog while preserving existing private and sheet-scoped destination behavior.

## Implemented

- Added nullable `org_id` to `dingtalk_group_destinations` with org lookup indexes and a database constraint that prevents a destination from being both sheet-scoped and organization-scoped.
- Added `scope: private | sheet | org` and optional `orgId` to backend and frontend DingTalk group destination models.
- Extended destination creation validation so:
  - `scope=sheet` requires `sheetId`.
  - `scope=org` requires `orgId`.
  - `scope=private` rejects `sheetId` and `orgId`.
  - `sheetId` and `orgId` cannot be used together.
- Extended list/read behavior:
  - Sheet views include sheet destinations, private user destinations, and active organization catalog destinations for org memberships.
  - Explicit `orgId` list views include that organization catalog and the user's private destinations.
  - Organization catalog delivery history is readable by active org members or admins.
- Restricted organization catalog mutations:
  - Create, update, delete, and test-send for `orgId` destinations require admin role/permission.
  - Admin detection accepts `role`, `roles`, `permissions`, `perms`, `isAdmin`, and `is_admin`.
- Extended automation runtime lookup so `send_dingtalk_group_message` can use organization destinations when the rule creator has an active `user_orgs` membership.
- Updated table integration UI:
  - Organization catalog destinations appear as read-only cards.
  - Edit, toggle, test-send, and delete actions are hidden for organization catalog rows.
  - Delivery history for organization rows is loaded without a sheet query scope.
- Updated automation UIs:
  - Quick automation manager and advanced rule editor label destinations as `This table`, `Private`, or `Organization catalog`.
  - Selected chips show organization catalog subtitles with `orgId`.
  - Empty and hint copy now mentions organization catalog availability.

## Files Changed

- Backend DB/API/runtime:
  - `packages/core-backend/src/db/migrations/zzzz20260423130000_add_org_scope_to_dingtalk_group_destinations.ts`
  - `packages/core-backend/src/db/types.ts`
  - `packages/core-backend/src/multitable/dingtalk-group-destinations.ts`
  - `packages/core-backend/src/multitable/dingtalk-group-destination-service.ts`
  - `packages/core-backend/src/routes/api-tokens.ts`
  - `packages/core-backend/src/multitable/automation-executor.ts`
- Frontend:
  - `apps/web/src/multitable/types.ts`
  - `apps/web/src/multitable/components/MetaApiTokenManager.vue`
  - `apps/web/src/multitable/components/MetaAutomationManager.vue`
  - `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- Tests:
  - `packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts`
  - `packages/core-backend/tests/unit/automation-v1.test.ts`
  - `packages/core-backend/tests/integration/dingtalk-group-destination-routes.api.test.ts`
  - `apps/web/tests/multitable-api-token-manager.spec.ts`
  - `apps/web/tests/multitable-automation-manager.spec.ts`
  - `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Notes

- This is a v1 catalog implementation. It does not add a dedicated organization admin management page; org catalog rows can be managed through the API by admins.
- Existing sheet-scoped table owners still manage table-local DingTalk robot destinations from the API token manager.
- Remote smoke with real DingTalk clients remains outside this local implementation slice and is tracked in the P4 smoke plan.
