# Formula Function Expression Development Notes

Date: 2026-05-05
Branch: `codex/formula-next-hardening-20260505`

## Scope

This slice hardens the shared backend formula parser so function calls can
participate in larger expressions instead of being parsed only as whole-formula
roots.

Examples now covered:

- `=SUM(1, 2) + SUM(3, 4)`
- `=SUM(10, 5) / SUM(1, 2)`
- `=(SUM(1, 2) + 3) * 2`
- `=SUM(1, 2) = SUM(3)`

## Problem

The parser previously used a greedy function-call regular expression:

```ts
/^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/
```

That worked for formulas where the entire expression was a single function
call, but it was too broad. Expressions such as `SUM(1)+SUM(2)` start with a
function-like prefix and end with `)`, so the regex swallowed the full string as
one `SUM(...)` call before operator parsing had a chance to split the top-level
`+`.

The result was incorrect parsing for common spreadsheet expressions that mix
functions with arithmetic or comparison operators.

## Implementation

`FormulaEngine.parseFormula(...)` now delegates function recognition to
`parseFunctionCall(...)`.

The helper:

- recognizes a function call only when the matching closing parenthesis closes
  at the final character of the current expression;
- tracks nested parentheses and quoted strings;
- returns `null` when a function-like prefix is only part of a larger
  expression, allowing the existing top-level operator parser to handle it;
- returns a malformed signal for unclosed function-like expressions so existing
  bad-input behavior remains `#ERROR!`.

`parseFormula(...)` also trims the current expression before parsing. This keeps
operator-recursive parsing stable when the left or right side has harmless outer
whitespace.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/formula-engine.test.ts`
- `docs/development/formula-function-expression-development-20260505.md`
- `docs/development/formula-function-expression-verification-20260505.md`

## Non-Goals

- No full formula grammar rewrite.
- No frontend formula editor changes.
- No new spreadsheet functions.
- No DB or migration changes.
