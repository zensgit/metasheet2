# Formula Cell Reference Case Development

Date: 2026-05-05
Branch: `codex/formula-cell-reference-case-20260505`

## Scope

This slice continues formula parser compatibility hardening after function names
became case-insensitive.

Function calls such as `=sum(...)` were accepted, but cell and range references
still required uppercase column letters. Common spreadsheet input such as
`=a1` or `=sum(a1:a3)` fell through to string parsing instead of resolving the
cell or range.

## Design

`FormulaEngine.parseFormula(...)` now accepts uppercase or lowercase ASCII
letters for cell and range references:

- single cell: `A1`, `a1`, `AA1`, `aa1`;
- range: `A1:A3`, `a1:a3`, `A1:a3`.

`parseCellReference(...)` uses the same case-insensitive reference shape, and
`columnLetterToIndex(...)` normalizes column letters to uppercase before the
existing base-26 conversion.

This keeps the DB lookup path unchanged: lowercase references map to the same
zero-based row and column indexes as uppercase references.

## Files Changed

- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/formula-engine.test.ts`

## Non-Goals

- No support for absolute references such as `$A$1`.
- No sheet-qualified references.
- No R1C1 notation.
- No frontend formula editor changes.
