# DingTalk V1 Action Summary Development - 2026-04-21

## Goal

Make automation list summaries accurately describe V1 multi-action rules that include DingTalk actions.

Before this change, `MetaAutomationManager` rendered each automation card as:

```text
trigger description -> describeAction(rule)
```

`describeAction(rule)` only inspected the legacy top-level `rule.actionType` and `rule.actionConfig`. For V1 rules, DingTalk group/person actions can live in `rule.actions[]`, while `rule.actionType` may remain `notify` or another legacy primary action. Those rules could send DingTalk messages, but the card summary could still show only `Send notification`.

## Implementation

Changed `apps/web/src/multitable/components/MetaAutomationManager.vue`.

- `describeAction(rule)` now prefers V1 `rule.actions[]` when present.
- Added `describeActionType(actionType, actionConfig)` so both legacy and V1 paths use the same labels.
- Added labels for V1 action types:
  - `send_notification`
  - `update_record`
  - `create_record`
  - `send_webhook`
  - `lock_record`
- Preserved existing legacy labels for:
  - `notify`
  - `update_field`
  - `send_dingtalk_group_message`
  - `send_dingtalk_person_message`

Changed `apps/web/tests/multitable-automation-manager.spec.ts`.

- Added list-summary coverage for a V1 rule containing `send_dingtalk_group_message`.
- Added list-summary coverage for a V1 rule containing `send_dingtalk_person_message`.
- Added a legacy list-summary assertion for the existing `notify` rule path.

## Rebase Note

After #980/#982/#983/#985 were merged into the stacked base branch, this PR was
rebased onto `origin/codex/dingtalk-public-form-save-validation-20260421`.
Duplicate ancestor commits were skipped during rebase so the PR diff now
contains only the V1 action-summary slice.

## Scope

This slice is frontend-only.

- No backend API change.
- No database migration.
- No delivery behavior change.
- No permission behavior change.

## User Impact

Automation owners can see from the rule list that a V1 multi-step automation includes DingTalk group or person messaging, instead of seeing only the legacy primary action.
