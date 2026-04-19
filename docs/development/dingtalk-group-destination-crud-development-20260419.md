# DingTalk Group Destination CRUD Development

- Date: 2026-04-19
- Branch: `codex/dingtalk-group-notify-standard-20260419`
- Scope: P0 first slice for standard DingTalk group notification

## Goal

Deliver the first runtime slice for the standard DingTalk group notification flow:

- add DingTalk group destination CRUD
- add manual `test send`
- expose the management UI inside `MetaApiTokenManager`
- fix the existing multitable token route mismatch by mounting the backend router and supporting the frontend's canonical `/api/multitable/tokens` path

## Backend

### Shared DingTalk robot helper

Added reusable helper module:

- `packages/core-backend/src/integrations/dingtalk/robot.ts`

Included:

- markdown payload builder
- webhook signing helper
- DingTalk response validation

This removes duplicated DingTalk robot logic from `NotificationService` and lets group destination test-send use the same signing/response semantics.

### Notification service reuse cleanup

Updated:

- `packages/core-backend/src/services/NotificationService.ts`

Changes:

- import shared DingTalk robot helpers
- treat `DingTalkRobotResponseError` as non-retryable for notification delivery

### New persistence model

Added table type and migration for DingTalk group destinations:

- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/db/migrations/zzzz20260419183000_create_dingtalk_group_destinations.ts`

Table fields:

- `id`
- `name`
- `webhook_url`
- `secret`
- `enabled`
- `created_by`
- `created_at`
- `updated_at`
- `last_tested_at`
- `last_test_status`
- `last_test_error`

### Service layer

Added:

- `packages/core-backend/src/multitable/dingtalk-group-destinations.ts`
- `packages/core-backend/src/multitable/dingtalk-group-destination-service.ts`

Service responsibilities:

- create/list/update/delete DingTalk group destinations
- ownership enforcement
- manual `testSend`
- persist last test timestamp/status/error

### Route layer

Updated:

- `packages/core-backend/src/routes/api-tokens.ts`
- `packages/core-backend/src/index.ts`

Changes:

- mounted `apiTokensRouter()` in app runtime
- kept legacy `/api/multitable/api-tokens` path
- added canonical `/api/multitable/tokens` path expected by the frontend client
- aligned token/webhook response envelopes with current `MultitableApiClient`
- added DingTalk group endpoints:
  - `GET /api/multitable/dingtalk-groups`
  - `POST /api/multitable/dingtalk-groups`
  - `PATCH /api/multitable/dingtalk-groups/:id`
  - `DELETE /api/multitable/dingtalk-groups/:id`
  - `POST /api/multitable/dingtalk-groups/:id/test-send`

## Frontend

### Types and client

Updated:

- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/api/client.ts`

Added types and client methods for:

- DingTalk group destination entity
- create/update payload
- list/create/update/delete/test-send client calls

### Management UI

Updated:

- `apps/web/src/multitable/components/MetaApiTokenManager.vue`

Changes:

- preserved existing tab order for compatibility:
  - `API Tokens`
  - `Webhooks`
  - `DingTalk Groups`
- added DingTalk group create/edit form
- added list state, enabled/disabled state, last test status/error display
- added actions:
  - create
  - edit
  - enable/disable
  - manual test send
  - delete

## Tests

Added backend unit coverage:

- `packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts`

Updated frontend component coverage:

- `apps/web/tests/multitable-api-token-manager.spec.ts`

Covered:

- DingTalk groups tab render
- create destination
- manual test-send
- existing token/webhook tab behavior remains intact

## Deployment

- None
- No remote deployment
- New migration was added but not applied anywhere in this slice
