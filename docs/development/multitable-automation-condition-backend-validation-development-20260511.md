# Multitable Automation Condition Backend Validation Development - 2026-05-11

## Context

The automation rule editor now filters condition operators by field type and
serializes number / boolean values with the right primitive types. The backend
route still only validated the condition JSON shape, so direct API clients could
persist rules that the UI would never author:

- unknown `fieldId` values;
- text-only operators such as `contains` on numeric fields;
- scalar value type mismatches such as `"42"` for a number field or `"false"`
  for a boolean field;
- attachment fields using non-empty-state operators.

This slice closes that REST boundary gap without changing the condition runtime
evaluator or stored payload shape.

## Scope

Implemented:

- Added `validateConditionGroupAgainstFields()` in the automation condition
  engine.
- Mirrored the frontend field-type operator families:
  - comparable: `number`, `currency`, `percent`, `rating`, `date`, `dateTime`,
    `createdTime`, `modifiedTime`, `autoNumber`;
  - equality-only: `boolean`, `select`, `person`, `user`, `link`, `lookup`,
    `rollup`, `createdBy`, `modifiedBy`;
  - multi-value: `multiSelect`;
  - empty-state only: `attachment`;
  - text fallback: other field types.
- Added scalar value type validation for number, boolean, and string-like
  fields.
- Added `preflightAutomationConditionFields()` to load `meta_fields` by
  `sheet_id` and convert condition validation failures into
  `AutomationRuleValidationError`.
- Wired the preflight into automation rule create and update routes before
  persistence.
- Added unit tests for the condition validator and route-level tests for create
  / update API rejection.

Not implemented:

- No migration or DB schema change.
- No evaluator behavior change.
- No frontend change.
- No live staging smoke.

## Design Decisions

### Route Preflight, Not Executor-Time Validation

The automation executor should only evaluate already-saved rules. Field metadata
validation belongs at the API boundary where malformed rules are created or
updated. This keeps the runtime path stable and prevents invalid data from being
persisted.

### Preserve Existing Payload Shape

Conditions still store the same `ConditionGroup` JSON shape. The validator
checks field existence, operator compatibility, and scalar value primitives, but
does not rewrite payload values.

### Allow Numeric Strings Only In List Operators

The current frontend list fallback can produce string entries for `in` /
`not_in`. To avoid making that existing fallback unusable, list entries for
numeric field types accept finite numeric strings. Scalar numeric operators
remain strict and require actual numbers.

### Keep Empty Conditions Valid

An empty condition group continues to mean "always pass". Field lookup still
runs only when a rule carries a condition group, but an empty group has no leaf
fields to reject.

## Files Changed

- `packages/core-backend/src/multitable/automation-conditions.ts`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/unit/multitable-automation-conditions.test.ts`
- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`

## Follow-Ups

- Consider coercing numeric `in` / `not_in` entries to numbers in the frontend
  so stored list payloads match evaluator strict equality for numeric record
  values.
- Add async option validation for person/link/lookup fields after those option
  sources are standardized.
