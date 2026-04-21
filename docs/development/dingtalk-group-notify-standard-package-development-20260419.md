# DingTalk Group Notify Standard P0 Package Development — 2026-04-19

## Scope

This package turns the previously separate DingTalk notification slices into one reviewable P0 feature line:

- DingTalk group destination management
- standard automation action `send_dingtalk_group_message`
- public form link + internal record/view deep link support
- delivery history and audit visibility

This package intentionally stops at **group notification**. Direct DingTalk messaging to individual users remains out of scope.

## Included Commits

- `cf26ef3ec` `docs(dingtalk): define standard group notification flow`
- `01928b4aa` `feat(dingtalk): add group destination management`
- `af9c81816` `feat(dingtalk): add automation group message action`
- `aeae067ca` `feat(dingtalk): add group delivery history and audit`

## Functional Outcome

### 1. DingTalk Group Destinations

Added destination management for DingTalk robot webhooks:

- create / update / enable / disable / delete
- owner-scoped access
- manual `test-send`

Core pieces:

- migration for `dingtalk_group_destinations`
- backend destination service + routes
- frontend `DingTalk Groups` tab in `MetaApiTokenManager`

### 2. Standard Automation Action

Added automation action:

- `send_dingtalk_group_message`

Supported configuration:

- destination selection
- title/body template
- optional public form view link
- optional internal multitable deep link

Outcome:

- one automation rule can notify a DingTalk group with both:
  - a create-only public form entry point
  - an internal processing link guarded by existing ACL

### 3. Delivery History / Audit

Added history persistence and visibility for both:

- manual `test-send`
- automation-triggered DingTalk group messages

Delivery rows persist:

- source type
- rendered subject/content
- success/failure
- HTTP status
- response body
- error message
- automation rule id
- record id
- initiating actor

### 4. Hardening Included In P0

This package also includes the following guardrails:

- open delivery panel refreshes after `test-send`
- delivery history has loading + empty states
- stale async responses do not overwrite the currently selected destination
- DingTalk application errors (`HTTP 200` with non-zero `errcode`) keep response diagnostics
- delivery-history persistence is best-effort and does not convert a real send success into an application failure

## Boundaries

In scope:

- DingTalk group robot destinations
- multitable automation integration
- delivery history / audit visibility

Out of scope:

- direct DingTalk personal messaging
- remote deployment
- production migration execution
- organization-wide routing policies beyond per-destination selection

## Related Slice Documents

- `docs/development/dingtalk-group-notify-standard-design-20260419.md`
- `docs/development/dingtalk-group-destination-crud-development-20260419.md`
- `docs/development/dingtalk-group-automation-action-development-20260419.md`
- `docs/development/dingtalk-group-delivery-history-development-20260419.md`
