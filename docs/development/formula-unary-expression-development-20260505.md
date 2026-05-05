# Formula Unary Expression Development

Date: 2026-05-05
Branch: `codex/formula-unary-expression-20260505`

## Scope

This slice continues formula parser correctness hardening after string escaping,
top-level operator tokenization, strict numeric literals, operator precedence,
and parenthesized expression parsing.

Parenthesized expressions were supported, but unary signs only worked when the
operand was a complete numeric literal such as `-3`. Expressions such as
`-(1+2)`, `5*-(1+2)`, and `-SUM(1,2)` still fell through to string parsing.

## Design

The formula AST now has an explicit `unary` node:

- `operator`: `+` or `-`;
- `operand`: any existing formula AST node.

`parseFormula(...)` scans binary operators before parsing unary expressions.
This preserves existing binary behavior such as `-3+5` by splitting on the
top-level `+` first, then parsing `-3` as the left operand.

Unary parsing only applies when the sign is a true unary sign according to the
existing `isUnarySign(...)` rules. Evaluation coerces the operand with
`Number(...)`, matching the existing arithmetic operator behavior.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/formula-engine.test.ts`
- `packages/core-backend/tests/unit/multitable-formula-engine.test.ts`

## Non-Goals

- No full formula grammar rewrite.
- No custom error typing for unary coercion failures.
- No frontend formula editor changes.
- No OpenAPI changes.
