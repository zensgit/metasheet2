# Multitable Automation Boolean List Condition Development - 2026-05-12

## Context

Automation conditions already expose `in` / `not_in` for boolean fields, and
backend field-aware validation accepts boolean arrays for those operators. The
frontend editor still rendered the single-value true/false select for boolean
fields even after switching the operator to `in` or `not_in`.

That made boolean list conditions impossible to save: the draft value became a
single boolean, while the editor completeness check expected a list.

## Scope

Implemented:

- Added a boolean multi-select value widget for boolean `in` / `not_in`
  conditions.
- Serialized boolean list condition payloads as `boolean[]`.
- Kept Save disabled when a boolean list condition has no selected values.
- Preserved existing single-value boolean behavior for `equals` /
  `not_equals`.
- Added unit coverage for both the happy path and empty-list disabled state.

Not implemented:

- No backend changes.
- No evaluator changes.
- No browser smoke.

## Design Decisions

### Match Backend Contract

The backend already validates boolean list values as booleans. The frontend now
emits the same primitive shape instead of string arrays or a scalar boolean.

### Dedicated Boolean Multi-Select

Reusing the option-backed `multiSelect` path would require fake field options.
A dedicated widget keeps the true/false choices explicit and avoids conflating
boolean fields with select fields.

### Empty List Is Incomplete

An empty `in` / `not_in` condition is not useful and would be rejected by the
backend semantic validator. The editor therefore keeps Save disabled until at
least one boolean value is selected.

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Follow-Ups

- Add async option/value validation for person/link/lookup once those option
  sources are standardized.
