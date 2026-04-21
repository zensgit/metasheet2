# DingTalk Person Member Group Field Picker Development

Date: 2026-04-21

## Goal

Improve authoring for `send_dingtalk_person_message` after dynamic member-group recipient fields were packaged in `#964`.

This slice does not change runtime behavior. It only makes member-group field path selection easier and less error-prone in both automation editors.

## Scope

- Add a picker for dynamic member-group recipient fields
- Only list explicit member-group fields in the picker
- Keep the existing freeform text input as the source of truth
- Do not change backend config shape or runtime execution

## Frontend Changes

Updated [MetaAutomationRuleEditor.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-picker-20260421/apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1):

- Added `Pick member group field`
- Added `memberGroupRecipientCandidateFields`
- Added `appendMemberGroupRecipientFieldPath(...)`
- Kept chips and warnings working on top of the same comma-separated `record.<fieldId>` string

Updated [MetaAutomationManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-picker-20260421/apps/web/src/multitable/components/MetaAutomationManager.vue:1):

- Added inline member-group field picker for create/edit form
- Added `dingTalkPersonMemberGroupRecipientCandidateFields`
- Added `appendDingTalkPersonMemberGroupRecipientField(...)`
- Restricted picker candidates to explicit member-group fields

Updated tests:

- [multitable-automation-rule-editor.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-picker-20260421/apps/web/tests/multitable-automation-rule-editor.spec.ts:1)
- [multitable-automation-manager.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-field-picker-20260421/apps/web/tests/multitable-automation-manager.spec.ts:1)

## Behavior Notes

- Dynamic member-group recipient paths remain freeform `record.<fieldId>` strings
- Picker candidates are limited to explicit member-group fields:
  - `link` fields with `property.refKind === 'member-group'`
  - custom field types named `member-group`, `member_group`, or `membergroup`
- No backend/runtime config or API change was made in this PR
