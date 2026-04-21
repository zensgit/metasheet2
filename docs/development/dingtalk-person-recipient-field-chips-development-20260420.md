# DingTalk Person Recipient Field Chips Development

Date: 2026-04-20
Branch: `codex/dingtalk-person-recipient-field-chips-20260420`

## Goal

Make multi-field dynamic recipient authoring easier by showing selected recipient fields as removable chips in both automation editors.

## Scope

- Frontend only
- no runtime protocol changes
- no backend changes
- no migration changes

## Implementation Notes

- Reuse the existing comma/newline based `recipientFieldPath` text state.
- Add selected field chips below the picker:
  - inline automation manager
  - full automation rule editor
- Clicking a chip removes that `record.<fieldId>` entry from the underlying text field.
- Keep the raw text input for direct editing and backward compatibility.

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Outcome

Admins can now:

- append multiple dynamic recipient fields with the picker
- see which fields are currently selected
- remove a field without manually editing the raw path string

This keeps the new multi-field capability from `#948` usable without forcing admins back into raw text management.
