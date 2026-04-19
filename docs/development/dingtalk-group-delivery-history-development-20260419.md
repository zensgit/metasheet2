# DingTalk Group Delivery History Development — 2026-04-19

## Scope

This slice adds delivery history and audit visibility for DingTalk group destinations used by multitable automation.

The goal is to make both manual `test-send` attempts and automation-triggered DingTalk group messages inspectable in the same management UI, instead of relying only on the latest `last_test_*` health fields.

## Backend Changes

### Persistence

Added a new table:

- `dingtalk_group_deliveries`

Migration:

- `packages/core-backend/src/db/migrations/zzzz20260419203000_create_dingtalk_group_deliveries.ts`

Stored attributes:

- destination id
- source type (`manual_test` or `automation`)
- rendered subject/content
- success/failure
- HTTP status
- raw response body
- error message
- automation rule id
- record id
- initiating user id
- created / delivered timestamps

### Service Layer

Extended:

- `packages/core-backend/src/multitable/dingtalk-group-destination-service.ts`
- `packages/core-backend/src/multitable/dingtalk-group-destinations.ts`

New behavior:

- manual `testSend()` now writes a delivery row on both success and failure
- delivery history persistence is now best-effort, so a delivery log insert failure does not turn a real DingTalk send into an application failure
- DingTalk application-level failures (`HTTP 200` with non-zero `errcode`) now retain `httpStatus` and `responseBody` in the delivery record
- destination list remains driven by `last_test_*`, but historical attempts are now queryable
- added `listDeliveries()` for recent destination-level history

### Automation Execution

Extended:

- `packages/core-backend/src/multitable/automation-executor.ts`

New behavior:

- `send_dingtalk_group_message` writes a delivery row for both success and failure
- automation delivery logging is also best-effort and no longer blocks a successful DingTalk send
- automation failure logs now keep parsed DingTalk response diagnostics when robot validation fails
- automation delivery rows capture `automationRuleId`, `recordId`, and initiating actor where available

### API

Extended:

- `packages/core-backend/src/routes/api-tokens.ts`

New endpoint:

- `GET /api/multitable/dingtalk-groups/:id/deliveries`

Guardrails:

- authenticated only
- owner-only access
- bounded `limit`

## Frontend Changes

Extended:

- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/components/MetaApiTokenManager.vue`

New behavior:

- DingTalk group cards now expose a `Deliveries` action
- inline history panel shows:
  - success/failure
  - source (`Manual test` / `Automation`)
  - subject
  - HTTP status
  - timestamp
- expanded delivery history now refreshes automatically after `Test send`
- delivery history panel now has explicit loading and empty states
- delivery history requests are guarded against stale async responses when switching between groups
- deleting the currently expanded destination clears the active delivery panel state

## Tests Updated

Backend:

- `packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`

Frontend:

- `apps/web/tests/multitable-api-token-manager.spec.ts`

## Notes

- The frontend test failure encountered during implementation was caused by the generic webhook `/deliveries` mock intercepting the DingTalk destination deliveries request. The mock matcher was narrowed to `/webhooks/.../deliveries` so the DingTalk-specific branch can return its own history payload.
- A backend TypeScript build issue surfaced because insert-time `delivered_at` was using `nowTimestamp()` (`RawBuilder<Date>`). That path now uses `sql\`CURRENT_TIMESTAMP\`` for insert compatibility with the table’s timestamp string column type.
- Local `plugins/**/node_modules` and `tools/cli/node_modules` noise remains outside this slice and must not be committed.
