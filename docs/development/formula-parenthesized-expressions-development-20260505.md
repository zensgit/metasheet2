# Formula Parenthesized Expressions Development Notes

Date: 2026-05-05
Branch: `codex/formula-parenthesized-expressions-20260505`

## Scope

This slice adds grouped-expression support to the shared backend formula parser.
It applies to both classic formula engine usage and multitable formula fields
because `MultitableFormulaEngine` delegates resolved expressions to
`FormulaEngine`.

## Problem

Recent formula fixes on `main` corrected string escaping, top-level operator
tokenization, signed numeric literals, and operator precedence. One common
spreadsheet syntax gap remained: parenthesized grouping.

Examples that users naturally write:

- `=(1 + 2) * 3`
- `=10 / (2 + 3)`
- `=({fld_price}+{fld_fee})*{fld_qty}`

Without grouped-expression parsing, the parser can treat a parenthesized segment
such as `(1 + 2)` as a string-like fallback instead of recursively evaluating the
inner expression.

## Implementation

`packages/core-backend/src/formula/engine.ts` now recognizes expressions fully
wrapped by one balanced outer pair of parentheses and recursively parses the
inner expression before operator splitting.

The helper intentionally stays narrow:

- It only strips when the first `(` and final `)` wrap the whole expression.
- It tracks quote state so parentheses inside strings are ignored.
- It preserves the precedence and left-associativity logic from the prior
  `fix(formula): respect operator precedence` change.
- It does not attempt a full formula grammar rewrite.

## Test Coverage

Added direct formula engine coverage for:

- Arithmetic groups: `=(1 + 2) * 3`, `=10 / (2 + 3)`,
  `=((1 + 2) * (4 - 1))`.
- Comparison groups: `=(1 + 2) > 2`, `=(1 + 2) = (5 - 2)`.

Added multitable coverage for:

- Field-reference grouping: `=({fld_price}+{fld_fee})*{fld_qty}`.

Existing multitable tests also keep coverage for function arguments such as
`=SUM((1+2),3)`.

## Non-Goals

- No formula grammar rewrite.
- No new spreadsheet functions.
- No frontend formula editor changes.
- No database or migration changes.
