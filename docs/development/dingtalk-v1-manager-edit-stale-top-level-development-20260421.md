# DingTalk V1 Manager Edit Stale Top-Level Coverage Development - 2026-04-21

## Goal

Lock the full automation-list edit path for V1 DingTalk rules whose legacy top-level action fields are stale.

`MetaAutomationRuleEditor` already prefers `rule.actions[]`, and PR #988 added direct editor coverage. This slice adds integration coverage through `MetaAutomationManager`: a user clicks `Edit` from the automation list, the manager passes the saved rule into the editor, and the editor must hydrate from V1 `actions[]` rather than stale `actionType/actionConfig`.

## Implementation

Changed `apps/web/tests/multitable-automation-manager.spec.ts`.

- Added a regression test for a saved rule where:
  - top-level `actionType` is stale `notify`.
  - top-level `actionConfig` is a stale notification payload.
  - `actions[]` contains the real `send_dingtalk_group_message` config.
  - clicking list `Edit` opens the rule editor with DingTalk group destinations/templates loaded from `actions[]`.
- Added a regression test for a saved rule where:
  - top-level `actionType` is stale `notify`.
  - top-level `actionConfig` is a stale notification payload.
  - `actions[]` contains the real `send_dingtalk_person_message` dynamic-recipient config.
  - clicking list `Edit` opens the rule editor with the dynamic recipient path/templates loaded from `actions[]`.

No production code changed.

## Scope

This slice is frontend test coverage only.

- No runtime code change.
- No backend API change.
- No database migration.
- No DingTalk delivery behavior change.

## User Impact

This prevents regressions where a V1 DingTalk rule looks correct in the list but opens in the editor with stale legacy notification fields, which could otherwise lead to accidental overwrite of real DingTalk settings.
