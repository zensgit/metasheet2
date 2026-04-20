# DingTalk Person Recipient Field Picker Development

Date: 2026-04-20
Branch: `codex/dingtalk-person-recipient-field-picker-20260420`

## Goal

Improve authoring for dynamic DingTalk personal recipients by letting admins pick a record field instead of manually typing a `record.<fieldId>` path.

## Scope

- Frontend only
- No runtime protocol changes
- No migration changes

## Changes

- Added `Pick recipient field` selects to:
  - `MetaAutomationRuleEditor`
  - `MetaAutomationManager`
- The picker writes the actual runtime-safe path:
  - `record.<fieldId>`
- Updated helper copy to clarify that automation `record` data is keyed by field ID.
- Upgraded summary text so it shows both:
  - field label
  - runtime path
  - example: `Assignees (record.assigneeUserIds)`

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Outcome

Admins no longer need to guess or hand-type a recipient path. They can pick a field from the current sheet and get the exact runtime path that the automation executor expects.
