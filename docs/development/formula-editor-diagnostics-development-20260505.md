# Formula Editor Diagnostics Development Notes

Date: 2026-05-05
Branch: `codex/formula-editor-diagnostics-20260505`

## Scope

This slice improves the multitable formula editor's pre-save diagnostics for
common syntax mistakes.

## Problem

The backend formula engine still returns a coarse `#ERROR!` for many invalid
expressions. The frontend formula editor already blocked unknown field
references and unbalanced parentheses, but the check was a raw character count
and did not understand quoted strings or other delimiter types.

That left avoidable save-time mistakes such as:

- unclosed string literals;
- unbalanced array brackets;
- unbalanced `{fld_xxx}` field-reference braces;
- formulas ending with a binary operator.

## Implementation

`apps/web/src/multitable/utils/formula-docs.ts` now has a small quote-aware
syntax scanner used by `validateFormulaExpression()`.

The scanner tracks:

- quoted string state with escaped quote handling;
- parentheses depth;
- array bracket depth;
- field-reference brace depth;
- unexpected closing delimiters;
- trailing binary operators.

It intentionally stays shallow. It does not parse or evaluate formulas; it only
flags syntax shapes that are clearly incomplete before the user saves the field
configuration.

## Tests

`apps/web/tests/multitable-formula-editor.spec.ts` now covers:

- unclosed quoted string detection;
- unbalanced array bracket detection;
- unbalanced field-reference brace detection;
- trailing binary operator detection;
- quoted parentheses not being counted as real parentheses.

## Non-Goals

- No backend formula error payload changes.
- No full formula parser in the browser.
- No CodeMirror integration or syntax highlighting.
- No semantic validation of function argument counts.
