# Formula Percent Operator Development Notes

Date: 2026-05-05
Branch: `codex/formula-percent-operator-20260505`

## Scope

This slice adds spreadsheet-style postfix percent support to the shared backend
formula engine.

## Problem

Spreadsheet users commonly write percentages directly in formulas:

```text
=50%
=200 * 10%
```

Before this slice, the formula parser had no postfix percent syntax. Users had
to write decimal equivalents such as `0.5` or `0.1`, which is less natural and
does not match Excel/Feishu-style formula entry.

## Implementation

`FormulaEngine` now has a `percent` AST node. During parsing, the engine detects
a trailing top-level `%` that is:

- at the end of the current expression after trimming whitespace;
- not inside quoted strings;
- not inside parentheses or array brackets;
- backed by a non-empty operand.

Evaluation converts the operand with `Number(value) / 100`.

This keeps `%` as a high-precedence postfix operator while preserving lower
precedence binary parsing. Examples:

- `=1 + 10%` parses as `1 + (10%)`;
- `=200 * 10%` parses as `200 * (10%)`;
- `=-50%` parses as `-(50%)`;
- `="50%"` remains a string literal.

## Test Coverage

Added formula-engine coverage for:

- standalone percent values;
- multiplication and addition with percent operands;
- unary negative percent;
- percent as an exponent operand;
- parenthesized percent power;
- string literals ending in `%`.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/formula-engine.test.ts`
- `docs/development/formula-percent-operator-development-20260505.md`
- `docs/development/formula-percent-operator-verification-20260505.md`

## Non-Goals

- No percentage formatting or display-layer changes.
- No frontend formula editor/catalog update in this slice.
- No full formula grammar rewrite.
- No database or migration changes.
