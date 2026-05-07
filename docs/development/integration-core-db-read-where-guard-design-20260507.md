# Integration Core DB Read Where Guard Design - 2026-05-07

## Context

The scoped DB helper intentionally exposes only structured CRUD operations. Write paths already reject invalid or empty predicates where an unbounded operation would be dangerous.

Read paths were more permissive: passing a non-object `where` value such as a string or array was silently treated as no filter. A malformed caller payload could therefore widen a query to a full scoped table read.

## Change

- Preserve the intentional `undefined` / `null` behavior for unfiltered reads.
- Reject non-object and array `where` values in `buildWhereClause()`.
- Add regression coverage for string, array, and numeric `where` shapes.

## Scope

This does not change valid read filters, `null` predicates inside a valid object, or unfiltered reads where callers omit `where`.

## Impact

Malformed read predicates now fail closed with `ScopeViolationError` instead of widening the read.
