# DingTalk Person Recipient Candidate Status Development - 2026-04-22

## Goal

Continue the DingTalk person-message workflow by making local user and member-group recipient selection safer in the automation UI.

## Implemented

- Added candidate status details to DingTalk person recipient search results in both automation editors.
- Show whether a candidate is a `User` or `Member group`.
- Show the candidate access level when the backend returns one.
- Disable inactive local user candidates so they cannot be added to `send_dingtalk_person_message` recipients.
- Filter role candidates out of DingTalk person recipient search results because direct person delivery only supports local users and member groups.
- Added defensive guards in the add-recipient handlers so inactive users and unsupported candidate types cannot be added programmatically.

## Files

- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `docs/development/dingtalk-person-recipient-candidate-status-development-20260422.md`
- `docs/development/dingtalk-person-recipient-candidate-status-verification-20260422.md`

## Behavior Notes

- This is a frontend-only safety and clarity slice.
- Existing manual ID entry is preserved.
- Existing dynamic record recipient field paths are preserved.
- Member groups remain selectable.
- Inactive local users remain visible with an explanatory message, but their buttons are disabled.
- Role candidates are hidden because they are not valid DingTalk person-message recipients.
