# DingTalk Notification Template Governance Development

Date: 2026-04-20

## Goal

Reduce authoring friction for DingTalk notification automations by adding one-click message presets for:

- `send_dingtalk_group_message`
- `send_dingtalk_person_message`

The presets standardize the common cases:

- form request
- internal processing
- form + processing

## Scope

Frontend-only governance enhancement:

- add a shared preset helper
- expose preset buttons in the rule editor
- expose the same preset buttons in the inline automation manager create form
- preserve existing recipient and action payload structure

No backend API or migration changes were needed.

## Implementation

### Shared preset helper

Added:

- `apps/web/src/multitable/utils/dingtalkNotificationPresets.ts`

This helper centralizes:

- preset ids and labels
- default title/body templates
- default public form view selection
- default internal view selection

It applies presets without changing unrelated action fields.

### Rule editor

Updated:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`

Added preset buttons for both DingTalk message actions:

- group message presets
- person message presets

The preset buttons populate:

- `titleTemplate`
- `bodyTemplate`
- `publicFormViewId`
- `internalViewId`

For person messages, recipient ids remain unchanged.

### Inline automation manager

Updated:

- `apps/web/src/multitable/components/MetaAutomationManager.vue`

The inline create flow now supports the same presets so the quick-create path and full editor stay aligned.

### Test coverage

Updated:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

New coverage verifies:

- group preset application in the rule editor
- person preset application in the rule editor
- group preset application in the inline create form
- person preset application in the inline create form
- recipient ids are preserved for person-message presets

## Notes

- This change is deliberately scoped to authoring ergonomics.
- It does not alter delivery semantics, ACL behavior, or runtime execution.
