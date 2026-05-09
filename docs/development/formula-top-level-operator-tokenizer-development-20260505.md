# Formula Top-Level Operator Tokenizer Development

Date: 2026-05-05
Branch: `codex/formula-operator-tokenizer-20260505`

## Scope

This slice hardens the formula parser after the multitable string escaping fix.
The prior parser found binary operators with `formula.split(op)`, so quoted
string literals containing operator characters could be interpreted as formula
operators.

Examples that should stay literal:

- `"A+B"`
- `"A=B"`
- `"a>b"`

## Design

`FormulaEngine.parseFormula(...)` now resolves binary operators through
`findTopLevelOperator(...)`.

The helper scans the expression once for each operator and ignores operator
text while inside:

- quoted string literals;
- escaped quote sequences;
- parenthesized function arguments;
- array literals.

This preserves the existing parser shape and operator ordering while removing
the unsafe global split behavior. The change intentionally does not rewrite
formula precedence or introduce a new parser grammar.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/multitable-formula-engine.test.ts`

## Non-Goals

- No formula precedence rewrite.
- No support for new formula functions.
- No frontend formula editor work.
- No OpenAPI or database changes.
