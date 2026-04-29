# Wave M-Feishu-4 Formula Catalog Design — 2026-04-29

## Scope

Lane B adds a lightweight formula function catalog and insertion helper to the existing multitable formula field configuration in `MetaFieldManager.vue`.

This lane is frontend-only by design. It does not change `packages/core-backend/src/multitable/formula-engine.ts` or backend formula evaluation semantics.

## Current Context

- Formula fields already persist `field.property.expression`.
- The backend multitable formula engine resolves stable `{fld_xxx}` tokens before passing formulas into the shared formula engine.
- The existing editor already had a textarea, field-token chips, simple diagnostics, and a flat function reference list.
- Wave M-Feishu-1 delivery left "Formula editor + Chinese function docs" as future work; this lane implements the small catalog/insert-assist slice without a larger formula parser rewrite.

## Design

### Catalog source

`apps/web/src/multitable/utils/formula-docs.ts` remains the single frontend catalog source. It now exposes:

- `FORMULA_FUNCTION_CATEGORIES`: stable category metadata for UI rendering.
- `FORMULA_FUNCTION_DOCS`: documented functions aligned to currently registered backend built-ins.
- `getFormulaFunctionCatalog(query, category)`: pure grouping/filtering for component and tests.
- `buildFormulaFieldTokenInsertion(expression, fieldId)`: pure stable field-token insertion.
- `buildFormulaFunctionInsertion(expression, docOrName)`: pure function snippet insertion.

### UI behavior

Formula field configuration now renders:

- Expression textarea.
- Existing diagnostics for empty formulas, unbalanced parentheses, unknown `{fld_xxx}` refs, and undocumented function calls.
- Existing field chips that insert stable `{fieldId}` tokens.
- Function reference toolbar with text search and category filter.
- Grouped function cards with signature, description, and example.

Clicking a function card appends the documented `insertText`. Empty expressions are prefixed with `=`, matching the existing editor convention.

### Non-goals

- No backend parser or evaluation changes.
- No cursor-position-aware insertion. Insertions still append to the expression, preserving the existing low-risk behavior.
- No formula runtime validation beyond the existing lightweight diagnostics.
- No persistence schema change.

## Risk Controls

- Pure helper tests cover catalog grouping and insertion rules.
- Component tests cover category filtering and card insertion.
- Existing unknown-field-reference blocking behavior remains covered.
- Backend formula engine file was read for supported built-ins but left unchanged.
