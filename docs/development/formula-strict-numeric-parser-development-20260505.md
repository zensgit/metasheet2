# Formula Strict Numeric Parser Development

Date: 2026-05-05
Branch: `codex/formula-strict-numeric-parser-20260505`

## Scope

This slice continues the formula parser correctness hardening after the string
escaping and top-level operator fixes.

The parser previously scanned for `+` and `-` operators before recognizing
complete numeric literals. That caused valid numeric literals such as `-3` and
`1e-3` to be interpreted as binary expressions.

## Design

`FormulaEngine.parseFormula(...)` now recognizes complete finite numeric
literals with `Number(...)` before top-level operator scanning. This supports:

- signed literals such as `-3` and `+3`;
- exponent literals such as `1e-3` and `1e+3`;
- signed literals on the right side of expressions such as `5*-3`.

The top-level operator scanner also skips unary `+`/`-` signs when they appear:

- at the start of an expression;
- after another operator;
- after `(`, `[`, or `,`;
- as an adjacent exponent sign after a numeric mantissa and `e` or `E`.

This preserves normal binary expressions such as `5 - 3` while allowing signed
numeric literals to parse correctly. It also preserves binary operators after
identifiers ending in `E`, such as `TRUE-1`.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/formula-engine.test.ts`

## Non-Goals

- No full grammar rewrite.
- No operator precedence rewrite beyond existing parser behavior.
- No frontend formula editor changes.
- No multitable runtime or OpenAPI changes.
