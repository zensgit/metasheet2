# Formula Case-Insensitive Functions Development Notes

Date: 2026-05-05
Branch: `codex/formula-case-insensitive-functions-20260505`

## Scope

This change makes backend formula function names case-insensitive. It applies to
both classic `FormulaEngine` formulas and multitable formula fields because
multitable formulas delegate to the same shared engine after resolving field
references.

## Problem

The formula engine registers built-in functions with uppercase names such as
`SUM`, `CONCAT`, and `DATEDIF`, while the parser only recognized function calls
matching uppercase tokens:

```ts
/^([A-Z]+)\((.*)\)$/
```

That meant common user-entered formulas like `=sum(1,2)` or
`=concat("a","b")` were not parsed as function calls. They fell through to the
plain-string fallback and returned literal text instead of calculated values.

## Implementation

`packages/core-backend/src/formula/engine.ts` now:

- recognizes function tokens beginning with a letter and followed by letters,
  digits, or underscores;
- normalizes the parsed function name to uppercase before storing it in the AST;
- keeps the existing function registry unchanged.

The parser still rejects unknown function names through the existing
`Unknown function` error path.

## Test Coverage

Added direct formula engine coverage for:

- `=sum(1, 2, 3)` -> `6`
- `=CoUnT(1, 2, "", 4)` -> `3`
- `=concatenate("Hello", " ", "World")` -> `Hello World`
- `=LoWeR("HELLO")` -> `hello`

Added multitable coverage for:

- `=concat({fld_name}," x")` after field-reference resolution.

## Non-Goals

- No new formula functions.
- No changes to function implementations.
- No frontend formula editor changes.
- No parser grammar rewrite beyond function-token recognition.
