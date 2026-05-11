# Multitable Automation Condition Schema Development - 2026-05-11

## Context

PR #1466 fixed automation condition execution so the backend evaluator honors both:

- backend-style `logic: 'and' | 'or'`;
- frontend-style `conjunction: 'AND' | 'OR'`.

That made existing rules execute correctly, but route parsing still accepted arbitrary `conditions` objects and persisted them as JSONB. A malformed payload could still survive until execution time.

This follow-up adds route-boundary validation without changing the database schema or frontend UI.

## Scope

Implemented:

- Added `normalizeConditionGroupInput(...)` in `automation-conditions.ts`.
- Added `ConditionGroupValidationError` for schema-level failures.
- Wired `parseCreateRuleInput(...)` and `parseUpdateRuleInput(...)` to validate and normalize `conditions`.
- Preserved both accepted condition group shapes:
  - `{ logic: 'and' | 'or', conditions: [...] }`
  - `{ conjunction: 'AND' | 'OR', conditions: [...] }`
- Supported nested condition groups recursively with a maximum nesting depth.
- Validated leaf conditions:
  - non-empty `fieldId`;
  - known operator;
  - required `value` for value-bearing operators;
  - array `value` for `in` / `not_in`.
- Normalized:
  - `conjunction: 'and'` to `conjunction: 'AND'`;
  - `logic: 'OR'` to `logic: 'or'`;
  - trimmed leaf `fieldId`.

Not implemented:

- Frontend nested-condition editor UI.
- Field-type-aware semantic validation, because the parser does not receive sheet field metadata.
- DB migration or persisted JSONB rewrite.
- SMTP real-send mailbox receipt verification.

## Design Decisions

### Validate At The Route Parse Boundary

The route layer already funnels create/update bodies through `parseCreateRuleInput(...)` and `parseUpdateRuleInput(...)`.

Putting validation there gives API callers deterministic `VALIDATION_ERROR` behavior while keeping the executor simple.

### Keep Evaluator Backward-Compatible

The evaluator still has a safe default for malformed old persisted rows. This follow-up only blocks new malformed route input.

Reason: existing JSONB rows may predate the validator; execution should remain fail-safe rather than crash.

### Do Not Over-Validate Field Semantics

The validator checks operator/value shape but does not verify whether a specific field supports a comparison.

Reason: field metadata is not available at this generic route parse boundary. Runtime evaluation already returns false for incompatible comparison types.

## Files Changed

- `packages/core-backend/src/multitable/automation-conditions.ts`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/tests/unit/multitable-automation-conditions.test.ts`
- `packages/core-backend/tests/unit/multitable-automation-service.test.ts`

## Follow-Ups

- Add a frontend nested-condition builder after product confirms UX.
- Add field-aware validation later if the automation rule route starts loading field metadata during create/update.
