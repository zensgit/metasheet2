# Formula Numeric Plus Development Notes

Date: 2026-05-05
Branch: `codex/formula-numeric-plus-20260505`

## Scope

This slice aligns the formula engine's `+` operator with spreadsheet numeric
addition semantics.

## Problem

The formula engine evaluated `+` with raw JavaScript addition:

```ts
(left as number) + (right as number)
```

The TypeScript cast does not coerce at runtime. If either operand is a string,
JavaScript performs string concatenation. That means formulas such as:

```text
="1" + 2
```

returned `"12"` instead of `3`.

Other arithmetic operators already use JavaScript numeric coercion implicitly,
so `+` was the only arithmetic operator with string-concatenation behavior.

## Implementation

`FormulaEngine.evaluateOperator(...)` now evaluates `+` as:

```ts
Number(left) + Number(right)
```

This keeps the existing return type and keeps invalid numeric inputs in the same
JavaScript numeric-conversion family as unary `+` / unary `-`.

## Test Coverage

Added direct formula-engine coverage for:

- string numeric operand addition: `="1" + 2`;
- boolean numeric coercion: `=TRUE + 1`;
- function result plus string numeric operand: `=SUM(1, 2) + "4"`.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/formula-engine.test.ts`
- `docs/development/formula-numeric-plus-development-20260505.md`
- `docs/development/formula-numeric-plus-verification-20260505.md`

## Non-Goals

- No text-concatenation operator support.
- No full formula type-system rewrite.
- No frontend formula editor changes.
- No database or migration changes.
