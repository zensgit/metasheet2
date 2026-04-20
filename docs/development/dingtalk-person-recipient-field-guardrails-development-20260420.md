# DingTalk Person Recipient Field Guardrails Development

Date: 2026-04-20
Branch: `codex/dingtalk-person-recipient-field-guardrails-20260420`

## Goal

Add authoring guardrails for dynamic DingTalk person recipient fields so admins are guided toward real user fields instead of arbitrary record paths.

## Scope

- Frontend only
- no backend protocol changes
- no migration changes
- no runtime behavior changes

## Implementation Notes

- Limit the dynamic recipient field picker to fields with `type === 'user'`.
- Keep manual text entry available for backward compatibility and advanced cases.
- When a manually entered path points at a non-user field, show a warning instead of blocking save.
- Update both automation editors:
  - inline automation manager
  - full rule editor

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Outcome

Dynamic DingTalk personal notifications now guide admins toward valid user fields by default, while still preserving the existing text-based escape hatch for nonstandard record schemas.
