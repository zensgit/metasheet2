# Multitable Automation Field-Aware Operators Development - 2026-05-11

## Context

PR #1467 added backend validation for automation condition payloads.
PR #1470 aligned the frontend editor with that schema by preserving nested groups and serializing `in` / `not_in` values as arrays.

This follow-up reduces bad authoring at the UI layer by filtering condition operators based on the selected field type.

## Scope

Implemented:

- Added field-aware operator lists in `MetaAutomationRuleEditor`.
- Text-like fields keep text operators such as `contains` and `not_contains`.
- Numeric/date/system-time fields get comparison operators such as `greater_than` and `less_or_equal`.
- Boolean, select, person, link, lookup, rollup, and system-user fields get equality/list/empty-state operators.
- Multi-select fields get membership and empty-state operators.
- Attachment fields only get empty-state operators.
- Changing a condition field resets incompatible operators to the selected field's default operator.
- Changing an operator clears stale value state so old text values do not leak across operator types.

Not implemented:

- Field metadata dependent value widgets.
- Full nested-condition group authoring.
- Backend field-aware semantic validation.

## Design Decisions

### Filter In The Editor, Keep Backend Generic

The backend parser intentionally validates JSON shape rather than loading field metadata.
This slice keeps the backend generic and improves the authoring UX where the field list is already available.

### Reset Incompatible Operators

When a user switches a condition from a text field to a numeric field, `contains` is no longer a meaningful option.
The editor now resets that operator to the first valid operator for the new field and clears the old value.

### Preserve Existing Schema Behavior

This change does not alter payload shape. It only changes which operators the UI presents and how stale local draft state is cleaned.

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Follow-Ups

- Add type-specific value widgets, for example date pickers, number inputs, boolean selects, and option pickers.
- Add a full nested-condition builder after UX confirmation.
