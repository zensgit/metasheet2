# DingTalk Group Notification Standard Feature Design

Date: 2026-04-19

## Objective

Standardize the product flow:

- `multitable trigger`
- `send DingTalk group message`
- `public form fill-in and/or internal record handling`

The first production slice targets **group delivery** only.

Direct personal DingTalk delivery is intentionally postponed to a later phase.

## Product Principles

### 1. Notification surface is not authorization surface

Sending a message into a DingTalk group does **not** grant table access.

- users with internal table permissions can open internal links
- users without permissions must be blocked from internal table links

### 2. Public form is not internal table access

Public form links are only for **new submissions**.

They must not allow:

- browsing the internal table
- opening arbitrary records
- editing existing records

### 3. Group first, personal DingTalk later

The current standard feature should target:

- DingTalk robot webhook based group messages

The following should be phase 2:

- DingTalk personal / enterprise work notifications

because they require user-level DingTalk identity resolution and a different
delivery mechanism than robot webhooks.

## User Stories

### Story A: Ask a group to fill a form

When a record reaches a trigger condition, the system posts a DingTalk group
message containing:

- the trigger reason
- key record summary fields
- a public form link for new submissions

Any recipient holding the valid public form link can submit a new response, but
cannot access the internal table.

### Story B: Ask internal operators to process a record

When a record reaches a trigger condition, the system posts a DingTalk group
message containing:

- the trigger reason
- key record summary fields
- an internal deep link to the record

Only users with existing ACL access can open the record and view or edit it.

### Story C: Combined message

For the most common operational flow, one message should contain both:

- `填写入口` — public form link
- `处理入口` — internal record deep link

This lets external or broader recipients submit new information while internal
operators process the record safely under ACL.

## Current Codebase Baseline

### DingTalk robot sending already exists

The backend already supports DingTalk robot markdown messages with signing:

- [NotificationService.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/src/services/NotificationService.ts:172)
- [NotificationService.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/src/services/NotificationService.ts:324)

Important current behavior:

- it accepts only `webhook` / `group` recipients
- it signs webhook URLs when a secret exists
- it already validates DingTalk business-level responses

### Multitable webhook management already exists

The multitable API already supports webhook CRUD and delivery history:

- [api-tokens.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/src/routes/api-tokens.ts:159)
- [MetaApiTokenManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/multitable/components/MetaApiTokenManager.vue:92)

This is useful as a reference for:

- destination configuration UX
- secret storage/update flows
- delivery visibility

### Public form links already exist

Public multitable forms already have:

- route contract:
  - [types.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/router/types.ts:428)
- link generation:
  - [MetaFormShareManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/multitable/components/MetaFormShareManager.vue:139)
- public submission audit:
  - [univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/src/routes/univer-meta.ts:6048)

### Public forms are already create-only

This is already enforced by integration tests:

- [public-form-flow.test.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/tests/integration/public-form-flow.test.ts:246)

This existing rule should remain unchanged.

### Internal multitable deep links already exist

The app already has internal multitable routes and record-scoped context:

- [types.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/router/types.ts:428)
- [MultitableWorkbench.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/multitable/views/MultitableWorkbench.vue:1043)

This is enough to standardize:

- sheet/view links
- record deep links

without inventing a second link system.

## Standard Feature Scope

### Phase 0

Deliver a standard feature called:

- `钉钉群通知`

This feature must support:

- multitable trigger conditions
- DingTalk group destinations
- templated message bodies
- public form link inclusion
- internal record link inclusion
- delivery history and failure handling

### Explicitly out of scope for phase 0

- personal DingTalk direct messages
- arbitrary external IM adapters
- cell-level ACL
- authorization bypass via message links

## Standard Message Types

### Type 1: Form request message

Purpose:

- ask a group to submit new information

Payload contents:

- title
- trigger reason
- key record summary
- due time (optional)
- public form link

### Type 2: Internal action message

Purpose:

- ask internal operators to review, view, or edit a record

Payload contents:

- title
- trigger reason
- key record summary
- assignee / status (optional)
- internal record link

### Type 3: Combined message

Purpose:

- one message for both broad collection and internal handling

Payload contents:

- title
- trigger reason
- summary
- public form link
- internal record link

## Proposed Data Model

### 1. DingTalk group destination

Create a managed destination entity, for example:

- `id`
- `name`
- `webhook_url`
- `secret`
- `enabled`
- `scope_type`
- `scope_id`
- `created_by`
- `created_at`
- `updated_at`

Recommended scope model:

- `platform`
- `organization`
- `plugin_namespace`

### 2. DingTalk message template

- `id`
- `name`
- `type`
  - `form_request`
  - `record_action`
  - `combined`
- `title_template`
- `body_template`
- `enabled`

### 3. Trigger binding

- `id`
- `sheet_id`
- `view_id` nullable
- `rule_name`
- `trigger_type`
- `trigger_config`
- `destination_id`
- `template_id`
- `public_form_view_id` nullable
- `include_internal_link`
- `enabled`

### 4. Delivery history

Reuse the existing notification history model where practical, but for product
clarity the standard feature should expose:

- delivery status
- failed reason
- DingTalk response status
- rendered title/body preview
- destination used
- trigger source record

## Proposed Link Rules

### Public fill-in link

Format:

- `/multitable/public-form/:sheetId/:viewId?publicToken=...`

Rules:

- can be opened by anyone holding the valid token
- create-only
- no internal table browsing
- no editing existing records

### Internal handling link

Format:

- `/multitable/:sheetId/:viewId`
- `/multitable/:sheetId/:viewId?recordId=...`

Rules:

- can only be opened by authenticated users
- access continues to respect existing sheet/view/field/record ACL
- users without permission must be blocked

## UI Plan

### A. Destination management

Add a dedicated management surface for DingTalk group destinations:

- list destinations
- create destination
- update webhook/secret
- enable / disable
- test send
- view delivery history

Recommended entry point:

- near existing multitable webhook / automation settings

### B. Trigger configuration

Extend multitable automation with a first-class action:

- `send_dingtalk_group_message`

instead of forcing users to model this manually as a raw generic webhook.

Required fields:

- destination
- message type
- template
- include public form link
- include internal link
- fields to summarize

### C. Message preview

Operators should be able to preview:

- title
- body
- resolved links

before enabling the rule.

## Backend Plan

### Step 1: destination service

Add a standard backend service and routes for DingTalk destinations.

Suggested endpoints:

- `GET /api/dingtalk-group-destinations`
- `POST /api/dingtalk-group-destinations`
- `PATCH /api/dingtalk-group-destinations/:id`
- `POST /api/dingtalk-group-destinations/:id/test-send`
- `GET /api/dingtalk-group-destinations/:id/deliveries`

### Step 2: standard action adapter

Add `send_dingtalk_group_message` into multitable automation execution.

It should:

- resolve destination
- render title/body templates
- resolve public form/internal links
- call existing DingTalk notification sending logic
- record delivery history

### Step 3: template renderer

Support variables such as:

- table name
- view name
- record id
- record title
- operator name
- status
- due time
- public form URL
- internal URL

### Step 4: delivery observability

Expose:

- success / failure counts
- last delivery time
- last failed reason
- rendered preview for operators

## Frontend Plan

### Step 1: destination admin UI

Create a focused UI for DingTalk group configuration.

Minimum functions:

- create
- edit
- enable/disable
- test send
- list deliveries

### Step 2: automation editor integration

In the multitable automation editor:

- add action type `send_dingtalk_group_message`
- show destination selector
- show template selector or inline editor
- toggle public/internal link inclusion

### Step 3: link preview and safety hints

Show two distinct hints:

- `公开填写入口：任何持有 publicToken 的人可填写，但不能查看内部表格`
- `内部处理入口：仅有权限的用户可打开`

## Permission Boundaries

### Must enforce

- internal links do not bypass ACL
- public form links do not expose internal table data
- public form links remain create-only
- message recipients do not equal authorized users

### Must not do

- auto-upgrade group recipients into internal viewers
- treat DingTalk group membership as table permission
- reuse public form links for record editing

## Recommended Rollout Order

### P0

- destination configuration
- test send
- delivery history
- standard action `send_dingtalk_group_message`
- public form + internal link composition

### P1

- plugin/organization scoped destination governance
- reusable template library
- richer summary rendering

### P2

- personal DingTalk delivery
- user-level recipient resolution from DingTalk identity

## Detailed Development Task List

### Backend

1. Add DingTalk destination persistence model and CRUD routes.
2. Add destination-level test send using existing signing logic.
3. Add automation action type `send_dingtalk_group_message`.
4. Add link resolver for:
   - public form URL
   - internal record URL
5. Add templated rendering context.
6. Add delivery history read API.
7. Add audit logging.

### Frontend

1. Add DingTalk destination management page or settings module.
2. Add destination test-send flow.
3. Extend multitable automation editor with the new action type.
4. Add public/internal link preview blocks.
5. Add delivery history viewer.

### Tests

1. Destination CRUD route tests.
2. DingTalk test-send unit tests.
3. Automation execution tests for `send_dingtalk_group_message`.
4. Public/internal link rendering tests.
5. Frontend automation editor tests.
6. Permission regression tests:
   - no internal ACL bypass
   - public forms remain create-only

## Recommendation

Ship this as a standard product capability in the following sequence:

1. standardize DingTalk group destinations
2. standardize group-message automation from multitable triggers
3. standardize dual-link messages
4. postpone personal DingTalk delivery to the next phase

This gives the fastest business value with the least permission risk.
