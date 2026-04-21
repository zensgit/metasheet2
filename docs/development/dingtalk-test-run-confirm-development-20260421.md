# DingTalk Test Run Confirmation Development

Date: 2026-04-21
Branch: `codex/dingtalk-test-run-confirm-20260421`
Base: `codex/dingtalk-test-run-feedback-20260421`

## Goal

Prevent accidental real DingTalk sends from automation Test Run.

The previous slice made Test Run feedback visible and warned that DingTalk rules can send real messages. This slice adds an explicit browser confirmation before the saved DingTalk rule is executed.

## Changes

- Added a DingTalk-only confirmation in `MetaAutomationRuleEditor`.
- The confirmation is triggered when the saved rule contains:
  - `send_dingtalk_group_message`, or
  - `send_dingtalk_person_message`.
- Canceling the confirmation stops the test event and no API call is triggered by the parent manager.
- Non-DingTalk automation actions do not require confirmation.

## Rebase Note

After #980 and #982 were merged into the stacked base branch, this PR was
rebased onto `origin/codex/dingtalk-public-form-save-validation-20260421`.
Duplicate #980/#982 commits were skipped during rebase so the PR diff now
contains only the Test Run confirmation slice.

## Confirmation Message

`Test Run executes the saved rule and can send real DingTalk messages to configured groups or users. Unsaved changes are not included. Continue?`

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Risk Notes

- This is frontend-only governance; backend execution semantics are unchanged.
- The confirmation is based on the saved rule because Test Run executes by `ruleId` and does not include unsaved draft edits.
- The existing saved-rule gate remains in place, so new unsaved rules still cannot be tested.
