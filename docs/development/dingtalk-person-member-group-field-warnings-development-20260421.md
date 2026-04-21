# DingTalk Person Member Group Field Warnings Development

Date: 2026-04-21

## Goal

Add authoring warnings for dynamic member-group field paths in `send_dingtalk_person_message`.

This slice does not change runtime behavior. It only helps admins catch obvious misconfiguration earlier in both automation editors.

## Scope

- Warn when `record.<fieldId>` does not resolve to a field in the current sheet
- Warn when a dynamic member-group recipient path points at a `user` field
- Keep freeform text input and runtime config shape unchanged
- Do not change backend execution or API contracts

## Frontend Changes

Updated [MetaAutomationRuleEditor.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-warnings-20260421/apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1):

- Added `memberGroupRecipientFieldPathWarnings(...)`
- Rendered warning hints under `Record member group field paths`
- Reused existing path parsing so comma-separated `record.<fieldId>` input continues to work

Updated [MetaAutomationManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-warnings-20260421/apps/web/src/multitable/components/MetaAutomationManager.vue:1):

- Added inline warning rendering for draft member-group recipient field paths
- Warns on unknown field IDs in the current sheet
- Warns when a path points at a `user` field and should instead use `Record recipient field paths`

Updated tests:

- [multitable-automation-rule-editor.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-warnings-20260421/apps/web/tests/multitable-automation-rule-editor.spec.ts:1)
- [multitable-automation-manager.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-warnings-20260421/apps/web/tests/multitable-automation-manager.spec.ts:1)

## Behavior Notes

- Member-group recipient paths remain freeform `record.<fieldId>` strings
- Unknown paths are still editable; the UI only warns
- Paths targeting `user` fields are still preserved for backward compatibility; the UI now points admins to the user-recipient field input instead
- No backend/runtime payload or execution change was made in this PR
