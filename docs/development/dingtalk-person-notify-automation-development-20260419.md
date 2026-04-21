# DingTalk Person Notification Automation Development

- Date: 2026-04-19
- Branch: `codex/dingtalk-person-notify-20260419`
- Scope: P1 first slice for direct DingTalk person messaging from multitable automation

## Goal

Deliver the first standard runtime path for sending DingTalk messages to specific linked users:

- add `send_dingtalk_person_message` as a first-class automation action
- allow automation authors to target local platform users by `userId`
- resolve those users to linked DingTalk accounts at execution time
- support the same optional `填写入口` and `处理入口` links already used by group messages
- record per-recipient delivery history for audit and troubleshooting

## Backend

### Action model

Updated:

- `packages/core-backend/src/multitable/automation-actions.ts`
- `packages/core-backend/src/routes/univer-meta.ts`

Changes:

- added `send_dingtalk_person_message` to the automation action type set and route allowlists
- defined config shape:
  - `userIds`
  - `titleTemplate`
  - `bodyTemplate`
  - `publicFormViewId?`
  - `internalViewId?`

### DingTalk client support

Updated:

- `packages/core-backend/src/integrations/dingtalk/client.ts`
- `.env.example`

Changes:

- added `readDingTalkMessageConfig()` for org-app message credentials
- added `sendDingTalkWorkNotification()` for direct DingTalk work notifications
- added `DingTalkBusinessError` so application-level DingTalk failures can be surfaced with response payloads
- made the client request path accept an injectable `fetchFn` so automation tests do not depend on global network
- documented the required `DINGTALK_AGENT_ID`

### Automation execution

Updated:

- `packages/core-backend/src/multitable/automation-executor.ts`

Changes:

- added `executeSendDingTalkPersonMessage()`
- validates:
  - at least one local `userId`
  - non-empty title/body templates
  - shared public form when `publicFormViewId` is set
  - existing internal view when `internalViewId` is set
- resolves local users through `directory_account_links` and active DingTalk `directory_accounts`
- fails cleanly when a requested user is inactive or has no linked DingTalk account
- renders the message body with optional:
  - `填写入口` public form link
  - `处理入口` internal multitable record link
- batches direct DingTalk sends and records per-recipient delivery rows
- preserves `httpStatus` and `responseBody` when DingTalk returns request or business errors

### Persistence compatibility

Updated:

- `packages/core-backend/src/db/types.ts`

Added migrations:

- `packages/core-backend/src/db/migrations/zzzz20260419213000_add_dingtalk_person_message_automation_action.ts`
- `packages/core-backend/src/db/migrations/zzzz20260419214000_create_dingtalk_person_deliveries.ts`

Purpose:

- allow `send_dingtalk_person_message` in `automation_rules`
- persist recipient-level DingTalk person delivery history in `dingtalk_person_deliveries`

## Frontend

### Shared automation types

Updated:

- `apps/web/src/multitable/types.ts`

Changes:

- added `send_dingtalk_person_message` to the frontend automation action union

### Rule editor + manager

Updated:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`

Changes:

- added `Send DingTalk person message` to the action selector
- introduced authoring fields for:
  - local user IDs textarea
  - title template
  - body template
  - optional public form view
  - optional internal processing view
- normalize comma/newline separated local user IDs into the backend config shape
- keep legacy single-action and action-chain editing paths aligned with the new action type

## Tests

Updated backend coverage:

- `packages/core-backend/tests/unit/dingtalk-work-notification.test.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`

Covered:

- work notification config requires `DINGTALK_AGENT_ID`
- direct DingTalk notification payload includes `agent_id` and `userid_list`
- successful automation send against linked DingTalk users
- missing DingTalk link failure path

Updated frontend coverage:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

Covered:

- editor emits `send_dingtalk_person_message` with optional public/internal links
- manager quick-create form can save the new action payload

## Deployment

- None
- No remote deployment
- Two new migrations were added but not applied anywhere in this slice
