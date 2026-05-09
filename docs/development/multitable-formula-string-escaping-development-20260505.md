# Multitable Formula String Escaping Development

Date: 2026-05-05
Branch: `codex/multitable-formula-string-escaping-20260505`

## Scope

This slice fixes the string-literal gap called out in the Feishu parity audit:
multitable formula field references were interpolated with raw double quotes.
Values containing quotes, backslashes, or control characters could therefore
produce malformed formula expressions and return `#ERROR!`.

## Design

`MultitableFormulaEngine.evaluateField()` now converts string field values with
`JSON.stringify(...)` before injecting them into the formula expression. This
produces a valid quoted string literal for:

- embedded double quotes;
- backslashes;
- newlines and other JSON-escaped control characters.

The base `FormulaEngine` string parser now decodes quoted literals with
`JSON.parse(...)` instead of returning `slice(1, -1)`. That keeps escaped
multitable values semantically correct after parsing. Malformed quoted string
literals now become `#ERROR!` instead of being treated as a partially escaped
plain string.

## Files Changed

- `packages/core-backend/src/multitable/formula-engine.ts`
- `packages/core-backend/src/formula/engine.ts`
- `packages/core-backend/tests/unit/multitable-formula-engine.test.ts`

## Compatibility

Normal quoted formula strings keep the same behavior. The change only affects
escaped quoted literals, where previous behavior either broke parsing or leaked
escape backslashes into the result.

No database, API, frontend, OpenAPI, or DingTalk/public-form files are touched.
