# DingTalk Person Member Group Field Chips Development

Date: 2026-04-21

## Goal

Improve authoring for `send_dingtalk_person_message` after dynamic member-group field paths were added in `#957`.

This slice does not change runtime behavior. It only makes dynamic member-group paths easier to inspect and remove in both automation editors.

## Scope

- Add selected chips for `memberGroupRecipientFieldPath`
- Allow removing dynamic member-group field paths by clicking a chip
- Keep the existing freeform text input as the source of truth
- Do not change backend config shape or runtime execution

## Frontend Changes

Updated [MetaAutomationRuleEditor.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-chips-20260421/apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1):

- Added selected chips for parsed `Record member group field paths`
- Added `removeMemberGroupRecipientFieldPath(...)`
- Reused the existing summary-label helper so chips show field name when available, otherwise `record.<fieldId>`

Updated [MetaAutomationManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-chips-20260421/apps/web/src/multitable/components/MetaAutomationManager.vue:1):

- Added selected chips for inline create/edit form
- Added `removeDingTalkPersonMemberGroupRecipientField(...)`
- Kept the summary card aligned with the rule editor behavior

Updated tests:

- [multitable-automation-rule-editor.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-chips-20260421/apps/web/tests/multitable-automation-rule-editor.spec.ts:1)
- [multitable-automation-manager.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-chips-20260421/apps/web/tests/multitable-automation-manager.spec.ts:1)

## Behavior Notes

- Dynamic member-group field paths remain freeform `record.<fieldId>` strings
- No new picker was introduced
- No backend/runtime config or API change was made in this PR
