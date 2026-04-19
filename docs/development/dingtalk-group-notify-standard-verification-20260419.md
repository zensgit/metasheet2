# DingTalk Group Notification Standard Verification

Date: 2026-04-19

## Verification Goal

Verify that the proposed standard feature plan matches the current codebase and
does not violate existing permission or public-form behavior.

## Codebase Mapping Reviewed

### DingTalk robot delivery baseline

Reviewed:

- [NotificationService.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/src/services/NotificationService.ts:172)
- [NotificationService.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/src/services/NotificationService.ts:324)

Confirmed:

- DingTalk markdown payload building exists
- webhook signing exists
- DingTalk response validation exists
- recipients are restricted to `webhook` / `group`

### Multitable webhook management baseline

Reviewed:

- [api-tokens.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/src/routes/api-tokens.ts:159)
- [MetaApiTokenManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/multitable/components/MetaApiTokenManager.vue:92)

Confirmed:

- CRUD for webhooks already exists
- delivery history UI already exists
- the destination-management proposal is grounded in existing product patterns

### Public form baseline

Reviewed:

- [types.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/router/types.ts:428)
- [MetaFormShareManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/multitable/components/MetaFormShareManager.vue:139)
- [univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/src/routes/univer-meta.ts:6048)
- [public-form-flow.test.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/packages/core-backend/tests/integration/public-form-flow.test.ts:246)

Confirmed:

- public-form route contract already exists
- share link generation already exists
- submission audit logging already exists
- public forms are already create-only and reject `recordId` updates

### Internal multitable deep-link baseline

Reviewed:

- [types.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/router/types.ts:428)
- [MultitableWorkbench.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/multitable/views/MultitableWorkbench.vue:1043)

Confirmed:

- internal multitable routes already exist
- record-scoped context already exists
- the design does not require inventing a parallel routing mechanism

### Automation-editor baseline

Reviewed:

- [MetaAutomationRuleEditor.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:127)

Confirmed:

- current automation UI already supports multiple standard actions
- adding a first-class `send_dingtalk_group_message` action fits the current
  architecture better than exposing only raw `send_webhook`

## Verification Result

The design is consistent with the current codebase:

- no contradiction with existing DingTalk sending logic
- no contradiction with existing public-form routing
- no contradiction with current create-only public-form policy
- no contradiction with existing multitable ACL behavior

The proposed plan is therefore implementation-ready as a next development
slice.

## Commands Used

```bash
rg -n "public-form|MetaFormShareManager|MULTITABLE_PUBLIC_FORM|field 权限|record 权限|member-group acl|sheet permissions|record permissions" docs apps/web packages/core-backend -g '!**/node_modules/**'
nl -ba packages/core-backend/src/services/NotificationService.ts | sed -n '168,390p'
nl -ba packages/core-backend/src/routes/api-tokens.ts | sed -n '150,270p'
nl -ba apps/web/src/multitable/components/MetaFormShareManager.vue | sed -n '130,170p'
nl -ba packages/core-backend/tests/integration/public-form-flow.test.ts | sed -n '230,280p'
nl -ba packages/core-backend/src/routes/univer-meta.ts | sed -n '6040,6065p'
nl -ba apps/web/src/router/types.ts | sed -n '400,435p'
nl -ba apps/web/src/multitable/views/MultitableWorkbench.vue | sed -n '1008,1056p'
nl -ba apps/web/src/multitable/components/MetaAutomationRuleEditor.vue | sed -n '120,185p'
nl -ba apps/web/src/multitable/components/MetaApiTokenManager.vue | sed -n '90,145p'
```
