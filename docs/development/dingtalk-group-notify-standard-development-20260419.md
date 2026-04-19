# DingTalk Group Notification Standard Development

Date: 2026-04-19

## Scope

This slice does not implement runtime code yet.

It formalizes the product and engineering plan for the standard feature:

- `表格触发 -> 钉钉群消息 -> 表单填写 / 内部处理`

## Why This Slice Was Needed

The product requirement is now clear:

- DingTalk group messaging should become a standard product capability
- internal table links must continue to respect ACL
- public form links should be used for broad fill-in flows
- personal DingTalk messaging should come later

Before implementation, the system needed one explicit design that ties together:

- DingTalk robot delivery
- multitable automation
- public form links
- internal deep links
- permission boundaries

## Work Performed

Created the standard feature design document:

- [dingtalk-group-notify-standard-design-20260419.md](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-group-notify-standard-20260419/docs/development/dingtalk-group-notify-standard-design-20260419.md:1)

The document includes:

- product principles
- current codebase baseline
- message types
- proposed data model
- link rules
- UI plan
- backend plan
- frontend plan
- permission boundaries
- rollout order
- detailed backend/frontend/test task list

## Main Decisions

### 1. Group delivery is phase 0

The standard feature should first support:

- DingTalk robot webhook based group delivery

It should not start with personal DingTalk delivery because that needs a
different recipient model and enterprise message channel.

### 2. One message may contain two links

The standard message can contain:

- a public form link for new submissions
- an internal deep link for authenticated handling

These two links solve different business problems and must remain distinct.

### 3. Notification does not grant access

The design explicitly fixes this rule:

- sending a link to a group never grants internal table access

### 4. Public form remains create-only

The design preserves the current public form invariant:

- public forms do not expose internal table data
- public forms do not edit existing records

### 5. First-class automation action is preferred

Instead of forcing users to handwire a generic webhook action, the plan
recommends a standard action:

- `send_dingtalk_group_message`

This keeps the feature understandable and governable.

## Delivery Recommendation

Implementation should proceed in this order:

1. DingTalk destination CRUD + test send
2. standard multitable automation action
3. dual-link message rendering
4. delivery history / audit
5. personal DingTalk later
