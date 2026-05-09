# Formula Catalog Parity Development Notes

Date: 2026-05-05
Branch: `codex/formula-catalog-parity-20260505`

## Scope

This slice closes the discoverability gap between the backend formula engine and
the multitable frontend formula reference catalog.

## Problem

The shared backend `FormulaEngine` registers 46 built-in functions, but the
formula editor catalog only documented 19 backend functions plus the separate
operator reference entries. That created two issues:

- users could call supported backend functions that were not discoverable in the
  field configuration panel;
- `validateFormulaExpression()` derives documented function names from the same
  catalog, so supported-but-undocumented functions were shown as not documented.

Examples of backend-supported functions that were missing from the frontend
catalog included `CEILING`, `FLOOR`, `POWER`, `SQRT`, `MOD`, `LEFT`, `RIGHT`,
`MID`, `LOWER`, `TRIM`, `SUBSTITUTE`, `NOT`, `SWITCH`, `DATE`, `DATEDIF`,
`HLOOKUP`, `INDEX`, `MATCH`, `STDEV`, `VAR`, and `MODE`.

## Implementation

`apps/web/src/multitable/utils/formula-docs.ts` now documents every backend
registered built-in function.

The existing categories were sufficient:

- `math`: numeric helpers such as `CEILING`, `FLOOR`, `POWER`, `SQRT`, `MOD`;
- `text`: text slicing and normalization helpers;
- `logic`: boolean and branching helpers;
- `date`: `NOW`, `DATE`, `DATEDIF`, `MONTH`, `DAY`;
- `lookup`: `HLOOKUP`, `INDEX`, `MATCH`;
- `statistical`: `STDEV`, `VAR`, `MODE`.

The existing operator entries remain separate because they document parser
operators rather than functions registered through `this.functions.set(...)`.

## Tests

`apps/web/tests/multitable-formula-editor.spec.ts` now includes a backend
function parity guard. The test enumerates the backend registered function names
and asserts every one is present in `FORMULA_FUNCTION_DOCS`.

This is intentionally a frontend unit guard rather than a runtime import from
the backend package, so the web test does not couple to backend module loading.

## Non-Goals

- No backend formula evaluation changes.
- No CodeMirror or full formula builder.
- No semantic rewrite of existing function behavior.
- No docs for future AI formula generation.
