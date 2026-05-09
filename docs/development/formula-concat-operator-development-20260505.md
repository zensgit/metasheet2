# Formula Concatenation Operator Development Notes

Date: 2026-05-05
Branch: `codex/formula-concat-operator-20260505`

## Scope

This slice adds spreadsheet-style text concatenation with the `&` operator to
the shared backend formula engine.

## Problem

The previous formula-hardening slice intentionally made `+` numeric-only so
formulas such as `="1" + 2` return `3` instead of JavaScript's `"12"`.

That fixed numeric addition, but it left no operator-level way to concatenate
text. Users coming from Excel or Feishu-style formulas expect:

```text
="Hello" & " " & "World"
```

to return `Hello World`.

`CONCAT(...)` and `CONCATENATE(...)` already exist, but operator-level
concatenation is common in spreadsheet formulas and is easier to combine with
cell references and arithmetic.

## Implementation

`FormulaEngine` now includes `&` in the top-level operator scan.

Precedence is intentionally spreadsheet-like:

1. comparison operators split first;
2. `&` splits after comparison and before arithmetic;
3. `+` / `-` and `*` / `/` keep their existing precedence.

Because the parser recursively splits on the lowest-precedence top-level
operator first, this means:

```text
="Total: " & 1 + 2
```

evaluates as:

```text
"Total: " & (1 + 2)
```

and returns `Total: 3`.

At evaluation time `&` uses `String(left) + String(right)`.

## Test Coverage

Added formula-engine coverage for:

- chained text concatenation;
- concatenation with function results;
- concatenation inside comparison expressions;
- arithmetic precedence around `&`.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/formula-engine.test.ts`
- `docs/development/formula-concat-operator-development-20260505.md`
- `docs/development/formula-concat-operator-verification-20260505.md`

## Non-Goals

- No frontend formula editor/catalog update in this slice.
- No full formula grammar rewrite.
- No changes to `CONCAT` or `CONCATENATE`.
- No database or migration changes.
