# Formula Function Arity Diagnostics Development - 2026-05-05

## Scope

This slice tightens the multitable formula editor before-save diagnostics for documented functions.

It does not change backend formula evaluation, formula persistence, or the existing unknown-function warning behavior.

## Problem

The editor already catches structural syntax problems such as unclosed quotes and unbalanced delimiters, but it still allowed obvious incomplete function calls:

- `IF(condition, value_if_true)` could be saved even though the backend function expects a false branch.
- `ROUND(value, digits, extra)` could be saved even though the backend only accepts up to two arguments.
- Snippet placeholders such as `ROUND(, 2)` were syntactically balanced but semantically incomplete.

These failures were deferred by the previous formula diagnostics slice as "semantic validation of function argument counts".

## Design

The implementation adds editor-local function arity metadata and a quote-aware parser in `apps/web/src/multitable/utils/formula-docs.ts`.

Key decisions:

- Validation only applies to documented backend-compatible functions.
- Unknown functions still use the existing documentation warning path.
- Operator pseudo-docs are not validated as function calls.
- `ROUND` is treated as `1..2` because the backend defaults digits to zero.
- Lookup helpers with optional flags use bounded ranges, for example `VLOOKUP` and `HLOOKUP` are `3..4`.
- Zero-argument helpers such as `TODAY()` and `NOW()` reject provided arguments.
- Empty arguments are reported directly, so snippet placeholders disable save until the user fills them.

The parser scans function calls with quote and nested-delimiter awareness, then splits arguments only on top-level commas. Nested calls are recursively collected so expressions such as `IF(AND(...), ..., ...)` are validated at every documented function boundary.

## Files Changed

- `apps/web/src/multitable/utils/formula-docs.ts`
- `apps/web/tests/multitable-formula-editor.spec.ts`

## Expected Behavior

- `=IF({fld_price} > 0, "ok")` reports `IF expects at least 3 arguments.`
- `=ROUND({fld_price}, 2, 3)` reports `ROUND expects at most 2 arguments.`
- `=ROUND(, 2)` reports `ROUND has an empty argument.`
- `=DATEDIF({fld_start}, {fld_end})` reports `DATEDIF expects at least 3 arguments.`
- `=TODAY(1)` reports `TODAY expects at most 0 arguments.`
- `=ROUND({fld_price}, 2)` remains valid.

