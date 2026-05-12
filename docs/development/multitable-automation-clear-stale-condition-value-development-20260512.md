# Multitable Automation Clear Stale Condition Value Development

Date: 2026-05-12
Branch: `codex/multitable-automation-clear-stale-condition-value-20260512`
Baseline: `origin/main@3ce512401`

## Context

The backend now validates configured `select` and `multiSelect` option values at
the automation route boundary. The rule editor still had a stale-value UX gap:
when a user changed a condition from one compatible field to another, the
existing operator stayed valid and the old value was kept.

Example:

1. Choose `Priority equals high`.
2. Change the field to another select field such as `Stage`.
3. The editor could keep `high`, even if `Stage` does not define that option.

That value would be rejected by the backend on save. This slice prevents the
bad payload before submit.

## Design

- Keep the existing operator-reset behavior when the old operator is not
  supported by the new field type.
- Additionally clear the condition value whenever the selected `fieldId`
  changes.
- Preserve the operator when it remains compatible, so users do not lose their
  intended comparison mode.
- Leave same-field changes untouched; only actual field identity changes clear
  value state.

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## User-Facing Behavior

Switching a condition field now clears the value control and disables Save until
the user chooses or enters a value valid for the new field.

## Follow-Ups

- Async person/link/lookup option pickers remain separate work. This slice only
  addresses stale editor state across field switches.
