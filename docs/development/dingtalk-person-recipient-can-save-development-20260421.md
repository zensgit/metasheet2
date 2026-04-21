# DingTalk Person Recipient Save Validation Development Notes

Date: 2026-04-21

## Scope

This change tightens the frontend save guard for DingTalk person-message automations.

Affected entry points:

- `MetaAutomationRuleEditor.vue`
- `MetaAutomationManager.vue`

## Problem

The UI previously treated a dynamic recipient field input as valid when the raw text was non-empty. Inputs such as `record.` or `,` passed the raw `.trim()` check, but the save payload parser normalized them into an empty field-path list.

That allowed a DingTalk person-message automation to be saved without any effective recipient when no static users or member groups were selected.

## Implementation

The save guard now uses the same recipient path parser used by the save payload:

- `recipientFieldPath` is parsed before validation.
- `memberGroupRecipientFieldPath` is parsed before validation.
- Save remains disabled unless at least one effective recipient source exists:
  - static user IDs,
  - static member group IDs,
  - parsed user field paths,
  - parsed member-group field paths.

This keeps validation behavior aligned with the final action config persisted by the editor.

## Tests

Added regression coverage for both frontend paths:

- Rule editor: invalid dynamic person-recipient paths keep the save button disabled and do not emit `onSave`.
- Inline automation manager: invalid dynamic person-recipient paths keep the create button disabled and do not issue a `POST`.

## Notes

This slice only changes DingTalk person-message recipient validation. The existing group-message destination validation was intentionally left unchanged to keep this patch narrowly scoped.
