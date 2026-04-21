# DingTalk Test Run V1 Risk Feedback Development - 2026-04-21

## Goal

Tighten automation Test Run risk feedback now that DingTalk automations can be represented as V1 `actions[]`.

Two behaviors matter for users:

- Saved V1 rules with DingTalk actions must still require confirmation before Test Run, even when the legacy top-level `actionType` is not DingTalk.
- Non-DingTalk rules should not show a running-state warning that says DingTalk messages may be sent.

## Implementation

Changed `apps/web/src/multitable/components/MetaAutomationManager.vue`.

- `onTestRule(ruleId)` now looks up the saved rule and checks both DingTalk action types through the existing V1-aware `ruleHasActionType(...)` helper.
- Running state now uses:
  - `Running test. DingTalk actions may send real messages.` for saved rules with DingTalk group/person actions.
  - `Running test.` for non-DingTalk rules.

Changed `apps/web/tests/multitable-automation-manager.spec.ts`.

- Added a deferred Test Run response path in the local mock client so tests can assert the intermediate running state.
- Added coverage that a non-DingTalk automation displays a generic running message and does not mention DingTalk.

Changed `apps/web/tests/multitable-automation-rule-editor.spec.ts`.

- Added coverage that a saved V1 rule with `actionType: 'notify'` and `actions[]` containing `send_dingtalk_group_message` still shows the DingTalk warning and requires confirmation.

## Scope

This slice is frontend-only.

- No backend API change.
- No database migration.
- No DingTalk delivery behavior change.
- No permission behavior change.

## User Impact

Users get precise Test Run feedback:

- Real DingTalk send risk is still confirmed for V1 multi-action rules.
- Internal-only automations do not display a misleading DingTalk risk warning while running.
