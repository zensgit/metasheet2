# DingTalk Notification Template Preview Development

Date: 2026-04-20

## Goal

Make DingTalk notification authoring safer by showing a live message summary while the rule is being configured.

## Scope

Frontend-only enhancement for:

- `send_dingtalk_group_message`
- `send_dingtalk_person_message`

Surfaces covered:

- `MetaAutomationRuleEditor`
- `MetaAutomationManager`

## Implementation

Updated:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`

Added live summary cards that show:

- destination group or selected recipients
- current title template
- current body template
- public form link target
- internal processing link target

The preview is read-only and derives directly from the current draft state, so it does not change payload format or backend behavior.

## Test coverage

Updated:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

New coverage verifies:

- group summary rendering in the full rule editor
- person summary rendering in the inline automation manager

## Notes

- This is intentionally a governance/UX slice only.
- No API, migration, or runtime execution changes were introduced.
