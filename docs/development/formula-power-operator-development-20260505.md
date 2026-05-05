# Formula Power Operator Development Notes

Date: 2026-05-05
Branch: `codex/formula-power-operator-20260505`

## Scope

This slice adds spreadsheet-style exponentiation with the `^` operator to the
shared backend formula engine.

## Problem

The engine already exposed `POWER(a, b)`, but spreadsheet users commonly write
exponentiation inline:

```text
=2^3
```

Without `^`, those formulas fell through to string-like fallback parsing or
other incorrect behavior instead of returning a numeric result.

## Implementation

`FormulaEngine` now evaluates `^` with:

```ts
Math.pow(Number(left), Number(right))
```

Parser handling is intentionally split from the existing left-associative
operator groups:

- comparison, text concatenation, addition/subtraction, and
  multiplication/division keep their existing left-associative behavior;
- unary signs are parsed before exponentiation so `-2^2` becomes `-(2^2)`;
- exponentiation then scans the leftmost top-level `^`, making chained powers
  right-associative: `2^3^2` becomes `2^(3^2)`.

`isUnarySign(...)` also treats `^` as an operator boundary, so formulas such as
`2^-3` parse as `2^(-3)`.

## Test Coverage

Added formula-engine coverage for:

- basic power: `=2 ^ 3`;
- right-associative chaining: `=2^3^2`;
- multiplication precedence: `=2 * 3^2`;
- signed exponents: `=2^-3`;
- unary sign precedence: `=-2^2`, `=(-2)^2`, `=--2^2`.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/formula-engine.test.ts`
- `docs/development/formula-power-operator-development-20260505.md`
- `docs/development/formula-power-operator-verification-20260505.md`

## Non-Goals

- No full formula grammar rewrite.
- No frontend formula editor/catalog update in this slice.
- No changes to the existing `POWER(...)` function.
- No database or migration changes.
