# DingTalk Group Destination Save Validation Development Notes

Date: 2026-04-21

## Scope

This change tightens frontend save validation for DingTalk group-message automations.

Affected entry points:

- `MetaAutomationRuleEditor.vue`
- `MetaAutomationManager.vue`

## Problem

The group-message dynamic destination field previously passed validation when its raw text was non-empty. Inputs such as `record.` or `,` could enable saving, even though the save payload parser normalized them into an empty destination field-path list.

That made the save guard inconsistent with the persisted action config and could create an automation without an effective DingTalk group target when no static group destination was selected.

## Implementation

The save guard now uses the existing destination path parser before deciding whether a dynamic group destination is present:

- `destinationFieldPath` is parsed through `parseRecipientFieldPathsText`.
- Save requires at least one static destination ID or one parsed dynamic destination field path.
- Title, body, public-form link, and internal-view link validations remain unchanged.

This mirrors the previous person-message recipient fix and keeps group-message validation aligned with payload serialization.

## Tests

Added regression coverage for both frontend paths:

- Rule editor: invalid dynamic group destination paths keep the save button disabled and do not emit `onSave`.
- Inline automation manager: invalid dynamic group destination paths keep the create button disabled and do not issue a `POST`.

## Notes

This patch does not change backend delivery behavior or DingTalk webhook delivery. It only prevents invalid frontend saves before an automation can be submitted.
