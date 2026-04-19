# DingTalk Group Automation Action Development

- Date: 2026-04-19
- Branch: `codex/dingtalk-group-notify-standard-20260419`
- Scope: P0 second slice for standard DingTalk group notification

## Goal

Deliver the first automation runtime action for the standard DingTalk group notification flow:

- add `send_dingtalk_group_message` as a first-class automation action
- let automation authors choose a DingTalk group destination
- allow optional `public form` and `internal processing` links in the same message
- keep internal link access behind existing ACL

## Backend

### Action model

Updated:

- `packages/core-backend/src/multitable/automation-actions.ts`

Added:

- `send_dingtalk_group_message` to the action type set
- config shape:
  - `destinationId`
  - `titleTemplate`
  - `bodyTemplate`
  - `publicFormViewId?`
  - `internalViewId?`

### Action execution

Updated:

- `packages/core-backend/src/multitable/automation-executor.ts`

Added runtime behavior:

- resolve the target DingTalk group destination from `dingtalk_group_destinations`
- validate required config before send
- render `{{record.xxx}}`, `{{recordId}}`, `{{sheetId}}`, `{{actorId}}` placeholders
- optionally append:
  - `填写入口` public form link
  - `处理入口` internal multitable record link
- require `PUBLIC_APP_URL` or `APP_BASE_URL` only when links are requested
- post a signed DingTalk robot markdown payload and validate the DingTalk response body

### Route allowlists

Updated:

- `packages/core-backend/src/routes/univer-meta.ts`

Changes:

- added `send_dingtalk_group_message` to automation create/update validation allowlists

### Persistence compatibility

Added migration:

- `packages/core-backend/src/db/migrations/zzzz20260419193000_add_dingtalk_group_message_automation_action.ts`

Purpose:

- extend `automation_rules.action_type` constraint to allow `send_dingtalk_group_message`

## Frontend

### Shared automation types

Updated:

- `apps/web/src/multitable/types.ts`

Changes:

- added `send_dingtalk_group_message` to the frontend automation action union

### Rule editor

Updated:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`

Changes:

- added `Send DingTalk group message` to the action selector
- loaded available DingTalk group destinations from the current multitable client
- added editor fields for:
  - destination
  - title template
  - body template
  - optional public form view
  - optional internal processing view
- reset stale per-action config when the action type changes so old `fieldUpdates` / `fieldValues` state is not carried into the new action

### Manager + workbench wiring

Updated:

- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`

Changes:

- quick-create automation form now also supports the DingTalk group action
- manager passes `client` and `views` into the richer rule editor
- workbench now threads `workbench.views.value` into the automation manager
- rule list description now renders `Send DingTalk group message` instead of falling back to raw enum text

## Tests

Updated backend unit coverage:

- `packages/core-backend/tests/unit/automation-v1.test.ts`

Covered:

- successful DingTalk group automation send
- missing destination failure path

Updated frontend component coverage:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

Covered:

- editor emits the new DingTalk action config with optional links
- manager quick-create form can save a DingTalk action payload

## Deployment

- None
- No remote deployment
- New migration was added but not applied anywhere in this slice
