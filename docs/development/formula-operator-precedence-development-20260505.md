# Formula Operator Precedence Development

Date: 2026-05-05
Branch: `codex/formula-left-associative-operators-20260505`

## Scope

This slice continues formula parser correctness hardening after string escaping,
top-level operator tokenization, and signed numeric literal parsing.

The parser previously scanned operators one token at a time in a fixed order.
That produced two incorrect behaviors:

- same-precedence arithmetic such as `5 - 3 - 1` parsed as right-associative;
- comparisons mixed with arithmetic such as `1 + 2 > 2` could split on `+`
  before `>`.

## Design

`FormulaEngine.parseFormula(...)` now scans top-level operators by precedence
group:

- comparison: `>=`, `<=`, `<>`, `=`, `>`, `<`;
- additive: `+`, `-`;
- multiplicative: `*`, `/`.

The scanner still ignores operators inside quoted strings, function arguments,
and array literals. Within each precedence group it keeps the rightmost
top-level operator, which preserves left-associative evaluation through the
existing recursive parser.

Multi-character operators are matched before single-character operators and the
scanner skips over the matched token body. This prevents `>=` from being
overwritten by its internal `=`.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/formula-engine.test.ts`

## Non-Goals

- No full formula grammar rewrite.
- No parentheses grouping feature.
- No frontend formula editor changes.
- No multitable runtime or OpenAPI changes.
