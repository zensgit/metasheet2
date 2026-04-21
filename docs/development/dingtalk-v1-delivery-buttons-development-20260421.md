# DingTalk V1 Delivery Buttons Development - 2026-04-21

## Goal

Expose DingTalk delivery viewers for V1 multi-action automation rules.

Previously the automation manager showed the delivery viewer buttons only when the legacy top-level `rule.actionType` was exactly:

- `send_dingtalk_group_message`
- `send_dingtalk_person_message`

V1 automation rules can store multiple actions in `rule.actions[]`. In that shape the top-level `actionType` may be a different primary action, while a DingTalk group or person action still exists inside the action list. Those rules could send DingTalk messages, but the UI did not show the delivery history button.

## Implementation

Changed `apps/web/src/multitable/components/MetaAutomationManager.vue`.

- Added `ruleHasActionType(rule, actionType)` to check both the legacy top-level `rule.actionType` and V1 `rule.actions[]`.
- Updated the group delivery viewer button to use `ruleHasActionType(rule, 'send_dingtalk_group_message')`.
- Updated the person delivery viewer button to use `ruleHasActionType(rule, 'send_dingtalk_person_message')`.
- Kept legacy behavior unchanged for rules that still use a single top-level action.

Changed `apps/web/tests/multitable-automation-manager.spec.ts`.

- Added coverage for a V1 multi-action rule containing `send_dingtalk_group_message`.
- Added coverage for a V1 multi-action rule containing `send_dingtalk_person_message`.
- Verified that clicking each button opens the correct delivery viewer and calls the expected delivery endpoint.

## Rebase Note

After #980/#982/#983 were merged into the stacked base branch, this PR was
rebased onto `origin/codex/dingtalk-public-form-save-validation-20260421`.
Duplicate ancestor commits were skipped during rebase so the PR diff now
contains only the V1 delivery button slice.

## Scope

This slice is frontend-only.

- No database migration.
- No backend API contract change.
- No delivery payload change.
- No permission model change.

## User Impact

After this change, users can inspect DingTalk delivery records from the automation list even when a rule is configured as a V1 multi-step automation and DingTalk sending is not the top-level legacy action.
