# DingTalk V1 Editor Stale Top-Level Coverage Development - 2026-04-21

## Goal

Lock the rule editor behavior for V1 DingTalk automation rules where the legacy top-level fields are stale.

V1 automation rules should treat `rule.actions[]` as the source of truth. Older or migrated records may still carry legacy `actionType/actionConfig` values that do not match the real V1 action list. The editor already prefers `actions[]`, but the test suite did not prove this for DingTalk group/person configurations.

## Implementation

Changed `apps/web/tests/multitable-automation-rule-editor.spec.ts`.

- Added a regression test for a DingTalk group message rule where:
  - `actionType` is stale `notify`.
  - `actionConfig` contains only a stale internal notification value.
  - `actions[]` contains `send_dingtalk_group_message`.
  - The editor loads group destinations/templates from `actions[]`.
  - Save emits a DingTalk group action and matching top-level compatibility fields.
- Added a regression test for a DingTalk person message rule where:
  - `actionType` is stale `notify`.
  - `actionConfig` contains only a stale internal notification value.
  - `actions[]` contains `send_dingtalk_person_message` with dynamic record recipients.
  - The editor loads dynamic recipient paths/templates from `actions[]`.
  - Save emits a DingTalk person action and matching top-level compatibility fields.

No production code changed. The existing `draftFromRule(...)` implementation already gives `rule.actions[]` precedence.

## Scope

This slice is frontend test coverage only.

- No runtime code change.
- No backend API change.
- No database migration.
- No DingTalk delivery behavior change.

## User Impact

This prevents future regressions where editing a V1 DingTalk automation could accidentally read stale legacy action fields and overwrite the real DingTalk configuration.
