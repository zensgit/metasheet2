# Design: Reject Non-String Cursor at REST API Boundary

**PR**: #1203  
**Date**: 2026-04-27  
**File**: `plugins/plugin-integration-core/lib/http-routes.cjs`

---

## Problem

`publicRunInput` passed `body.cursor` through without any type validation:

```javascript
const input = {
  ...
  cursor: body.cursor,  // could be object, array, number, etc.
  ...
}
```

The cursor is supposed to be a pagination token (a string returned by the previous read). When a caller sends a non-string value, it propagates to the runner:

```javascript
let cursor = input.cursor || null
// ...
await context.sourceAdapter.read({ ..., cursor, ... })
```

Adapters react badly:
- HTTP adapters URL-encode the cursor — `{ malicious: true }` becomes `[object Object]` in the query string, breaking pagination
- SQL adapters that use `cursor` in a `WHERE` clause may throw `invalid input syntax`
- K3 WISE WebAPI adapter expects a string token; non-strings cause adapter-level crashes

This is the only field in `publicRunInput` still unvalidated after the recent boundary-hardening work (#1196 mode, #1199 offset, #1201 sampleLimit).

## Fix

Validate cursor as a string at the input boundary. Empty/absent stays untouched (the existing falsy-strip loop handles it). Non-strings are rejected with `400 INVALID_CURSOR`:

```javascript
function publicRunInput(body = {}) {
  if (body.cursor !== undefined && body.cursor !== null && body.cursor !== '') {
    if (typeof body.cursor !== 'string') {
      throw new HttpRouteError(400, 'INVALID_CURSOR', 'cursor must be a string', {
        received: Array.isArray(body.cursor) ? 'array' : typeof body.cursor,
      })
    }
  }
  ...
}
```

The `received` field distinguishes `'array'` from `'object'` (which `typeof` collapses) so callers can debug malformed clients quickly.

## Semantics

| Input | Behavior |
|-------|----------|
| Absent / `null` / `''` | Cursor omitted from runner input |
| `'page-token-abc'` | Passed through unchanged |
| `{ x: 1 }` | `400 INVALID_CURSOR` (`received: 'object'`) |
| `[ 'a', 'b' ]` | `400 INVALID_CURSOR` (`received: 'array'`) |
| `42` | `400 INVALID_CURSOR` (`received: 'number'`) |

`publicRunInput` is shared between `/run` and `/dry-run`, so both endpoints are covered with a single change.

## Pattern

Mirrors `INVALID_RUN_MODE` (#1196). Same `HttpRouteError` shape: `(status, code, message, details)`. The `details` hint helps clients self-diagnose without guessing.

## Affected Files

| File | Change |
|------|--------|
| `lib/http-routes.cjs` | cursor type-check at top of `publicRunInput` |
| `__tests__/http-routes.test.cjs` | `testCursorStringGuard()` — 5 scenarios (object/array/number/string/absent) |
