# DingTalk Notification Template Lint Development

Date: 2026-04-20

## Goal

Add authoring-time syntax warnings for DingTalk notification templates so invalid placeholder forms are caught before a rule is saved or tested.

## Scope

Frontend-only governance enhancement for:

- `send_dingtalk_group_message`
- `send_dingtalk_person_message`

Surfaces covered:

- `MetaAutomationRuleEditor`
- `MetaAutomationManager`

## Implementation

### Shared lint helper

Added:

- `apps/web/src/multitable/utils/dingtalkNotificationTemplateLint.ts`

The helper flags two classes of authoring issues:

- unsupported placeholder syntax inside `{{ ... }}`
- unclosed placeholder braces

It intentionally does not try to reject arbitrary dot paths such as `{{record.anyField}}`, because runtime rendering accepts dotted lookup paths.

### Rule editor warnings

Updated:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`

Warnings now render under DingTalk title/body fields for both group and person notification actions.

### Inline automation manager warnings

Updated:

- `apps/web/src/multitable/components/MetaAutomationManager.vue`

The inline create/edit form shows the same warnings so the quick authoring path and full editor stay aligned.

### Test coverage

Updated:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

New coverage verifies:

- invalid placeholder syntax warning in the rule editor
- unclosed placeholder warning in the inline manager

## Notes

- This slice does not change backend rendering behavior.
- It adds guidance only; valid templates continue to work unchanged.
