# DingTalk Person Static Recipient Save Validation Development Notes

Date: 2026-04-21

## Scope

This change tightens frontend save validation for DingTalk person-message automations.

Affected entry points:

- `MetaAutomationRuleEditor.vue`
- `MetaAutomationManager.vue`

## Problem

The previous frontend guard treated static recipient text as valid whenever the raw text was non-empty. Inputs such as `,` or `,\n,` enabled save/create, but the final payload parser split and filtered those values into empty recipient arrays.

That allowed the UI to submit a DingTalk person-message automation without any effective recipient when no dynamic record recipient fields were selected.

## Implementation

The save guard now uses the same static recipient parsers used by payload serialization:

- `parseUserIdsText(...)` for local user IDs.
- `parseMemberGroupIdsText(...)` for member group IDs.
- Existing parsed dynamic user and member-group field path checks remain unchanged.

Save/create now requires at least one effective recipient source:

- parsed static user ID,
- parsed static member group ID,
- parsed dynamic user field path,
- parsed dynamic member-group field path.

## Tests

Added regression coverage for both frontend paths:

- Rule editor: static recipient lists containing only separators keep the save button disabled and do not emit `onSave`.
- Inline automation manager: static recipient lists containing only separators keep the create button disabled and do not issue a `POST`.

## Notes

This patch is frontend-only. Backend runtime execution already rejects DingTalk person actions that resolve to no recipients; this change prevents invalid submissions earlier in the UI.
