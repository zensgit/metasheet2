# DingTalk Group Destination Field Warnings Development

- Date: 2026-04-21
- Scope: authoring guardrails for dynamic DingTalk group destination fields
- Branch: `codex/dingtalk-group-destination-field-warnings-20260421`
- Base: `codex/dingtalk-group-dynamic-destinations-20260421`

## Goal

Add guardrails for the dynamic DingTalk group destination fields introduced in the parent dynamic-destination slice.

## What Changed

The full automation rule editor and inline automation manager now warn when a dynamic DingTalk group destination field path points to a field that is clearly not intended to hold DingTalk group destination IDs:

- `user` fields now warn that DingTalk person recipient fields should be used instead.
- member-group fields now warn that DingTalk person member-group recipient fields should be used instead.
- existing unknown-field warnings are preserved.
- The warning parser and member-group field detection now live in one shared frontend utility, so the full editor and inline manager cannot drift in wording or field classification.

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/utils/dingtalkRecipientFieldWarnings.ts`
- `apps/web/tests/dingtalk-recipient-field-warnings.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Design Notes

- This is an authoring-only guardrail.
- It does not change the runtime protocol from the parent slice.
- It does not introduce a dedicated DingTalk group-destination field type.
- The generic picker remains available because there is still no reliable field metadata discriminator for "stores DingTalk group destination IDs".
- `property.refKind = member-group` and the existing member-group type aliases are treated consistently through `isDingTalkMemberGroupRecipientField`.

## Migrations

- None

## Deployment Impact

- Frontend authoring behavior only
- No backend runtime change
- No schema change
