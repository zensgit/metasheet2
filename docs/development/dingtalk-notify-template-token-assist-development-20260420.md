# DingTalk Notification Template Token Assist Development

Date: 2026-04-20

## Goal

Reduce template authoring mistakes for DingTalk notification actions by exposing a small, shared token reference and one-click token insertion in both automation authoring surfaces.

## Scope

Frontend-only authoring enhancement for:

- `send_dingtalk_group_message`
- `send_dingtalk_person_message`

Surfaces covered:

- `MetaAutomationRuleEditor`
- `MetaAutomationManager`

## Implementation

### Shared token helper

Added:

- `apps/web/src/multitable/utils/dingtalkNotificationTemplateTokens.ts`

The helper defines:

- title-safe tokens
- body tokens
- append behavior with sensible spacing/newline handling

### Rule editor

Updated:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`

Added token rows under:

- group title/body template fields
- person title/body template fields

Each button appends a supported token into the current template field without overwriting the existing value.

### Inline automation manager

Updated:

- `apps/web/src/multitable/components/MetaAutomationManager.vue`

Added the same token assist behavior to the inline create/edit form so quick authoring stays aligned with the full rule editor.

### Tests

Updated:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

New coverage verifies token insertion in both surfaces.

## Notes

- This change does not alter runtime payloads or backend execution.
- It is intentionally scoped to authoring guidance and template consistency.
