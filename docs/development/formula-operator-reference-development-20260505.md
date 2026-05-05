# Formula Operator Reference Development Notes

Date: 2026-05-05
Branch: `codex/formula-operator-reference-20260505`

## Scope

This slice aligns the multitable formula editor reference panel with the
backend formula operator support recently added on `main`.

## Problem

The formula field configuration panel already exposes a searchable reference
catalog, but the catalog only listed functions. The backend formula engine now
supports spreadsheet-style operators such as:

- numeric arithmetic: `+`, `-`, `*`, `/`
- exponentiation: `^`
- postfix percent: `%`
- text concatenation: `&`
- comparisons: `=`, `<>`, `>`, `>=`, `<`, `<=`

Without operator docs in the editor, users can discover `SUM` and `IF`, but
not the spreadsheet operators that are needed for common formulas like:

```text
={fld_price} * 10%
={fld_first_name} & " " & {fld_last_name}
={fld_base} ^ 2
```

## Implementation

`apps/web/src/multitable/utils/formula-docs.ts` now adds an `operator` category
to the formula catalog.

The new category documents:

- `left + right`
- `left - right`
- `left * right`
- `left / right`
- `left ^ right`
- `value%`
- `left & right`
- comparison operators

`MetaFieldManager.vue` changes the section label from `Function reference` to
`Formula reference` and updates the search placeholder so operators are clearly
discoverable from the same field configuration panel.

## Tests

Added frontend coverage for:

- operator catalog section construction;
- percent operator search by `%`;
- insertion text for the percent operator helper;
- rendered operator category in the formula configuration panel.

## Non-Goals

- No backend parser or evaluator changes.
- No CodeMirror or full syntax-highlighting editor.
- No natural-language formula generation.
- No changes to formula field persistence.
