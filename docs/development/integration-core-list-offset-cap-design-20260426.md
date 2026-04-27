# Design: Cap List Endpoint Offset at MAX_LIST_OFFSET

**PR**: #1199  
**Date**: 2026-04-26  
**File**: `plugins/plugin-integration-core/lib/http-routes.cjs`

---

## Problem

All four list endpoints (external-systems, pipelines, runs, dead-letters) pass the caller's `offset` query parameter directly to the underlying registry functions with no upper bound:

```javascript
offset: asPositiveInt(query.offset),
```

`asPositiveInt` converts any positive integer string without capping. A caller submitting `offset=9999999` causes a sequential scan across millions of rows before returning results — there is no query plan that skips cheaply to a row at position 9,999,999 without visiting all preceding rows.

## Fix

Add `MAX_LIST_OFFSET = 10000` constant and `asListOffset()` helper, applied at all four list call sites:

```javascript
const MAX_LIST_OFFSET = 10000

function asListOffset(value) {
  const n = asPositiveInt(value)
  if (n === undefined) return undefined
  return Math.min(n, MAX_LIST_OFFSET)
}
```

Replace `asPositiveInt(query.offset)` with `asListOffset(query.offset)` at:
- `externalSystemsList`
- `pipelinesList`
- `runsList`
- `deadLettersList`

## Semantics

| Input | Behavior |
|-------|----------|
| Absent / `''` | `undefined` — service receives no offset (start from beginning) |
| `'0'` | `undefined` — treated as no offset |
| `'50'` | `50` — passed through unchanged |
| `'10001'` | `10000` — clamped to MAX_LIST_OFFSET |
| `'9999999'` | `10000` — clamped to MAX_LIST_OFFSET |

Clamping is preferred over rejection: the caller still gets a valid page of results and is not blocked. Pagination past offset 10000 is a product-level concern (cursor-based pagination is the correct tool beyond that depth).

## Prior Art

The limit cap (`MAX_LIST_LIMIT = 500`) was added in PR #1192 using the same pattern. This PR mirrors it for offset.

## Affected Files

| File | Change |
|------|--------|
| `lib/http-routes.cjs` | `MAX_LIST_OFFSET`, `asListOffset()`, 4 call sites |
| `__tests__/http-routes.test.cjs` | `testListOffsetCap()` — 6 assertions |
