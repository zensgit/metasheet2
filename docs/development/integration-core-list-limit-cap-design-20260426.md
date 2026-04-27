# Integration-Core List Endpoint Limit Cap · Design

> Date: 2026-04-26
> PR: #1192

## Problem

All four list endpoints (`listExternalSystems`, `listPipelines`, `listPipelineRuns`,
`listDeadLetters`) read `limit` from the query string via `asPositiveInt(query.limit)`.
`asPositiveInt` accepts any positive integer — a client can send `?limit=1000000`.

The value is passed directly to `db.select` which translates it to `SELECT ... LIMIT 1000000`.
With a large dataset this:
- Scans the entire table (O(N) DB operation)
- Allocates a large result set in Node.js heap
- Produces a response body that may exceed proxy/load-balancer limits
- Blocks the event loop during JSON serialization

For the PoC phase this is low-risk (small datasets), but the fix is trivial and prevents
the pattern from becoming load-bearing once production data accumulates.

## Solution

### `MAX_LIST_LIMIT = 500`

Chosen as:
- Large enough for any operational UI page (run history, dead-letter review)
- Small enough to keep response bodies under typical proxy limits (< 5MB for typical records)
- Round number, matches common pagination conventions

### `asListLimit(value)`

```javascript
function asListLimit(value) {
  const n = asPositiveInt(value)
  if (n === undefined) return undefined
  return Math.min(n, MAX_LIST_LIMIT)
}
```

Silently clamps rather than rejecting. Rationale: a client that asks for 1000 rows
gets 500 — correct behavior, paginate for the rest. Returning a 400 for `limit=1000`
would be surprising and break clients that don't know about the cap.

### Endpoints updated

All four `limit` usages in `createHandlers`:

```
externalSystemsList  →  asListLimit(query.limit)
pipelinesList        →  asListLimit(query.limit)
runsList             →  asListLimit(query.limit)
deadLettersList      →  asListLimit(query.limit)
```

`asPositiveInt` is retained for non-list uses (`offset`, `sampleLimit`, etc.) where
clamping would be incorrect.

## What `MAX_LIST_LIMIT` does NOT cap

- `sampleLimit` on dry-run: intentionally uncapped because the operator controls batch size
- `offset`: uncapped (pagination cursor, not a row-count multiplier)
- Internal pipeline batch size (`batchSize`, `maxPages`): different surface, not HTTP-controlled

## Files changed

| File | Change |
|---|---|
| `lib/http-routes.cjs` | `MAX_LIST_LIMIT` constant; `asListLimit` helper; 4 call-sites updated; `MAX_LIST_LIMIT` + `asListLimit` exported |
| `__tests__/http-routes.test.cjs` | Import `MAX_LIST_LIMIT`; 3 new scenarios |
| this design doc | — |
| matching verification doc | — |

## Cross-references

- `lib/pipelines.cjs` — `listPipelineRuns`, `listPipelines` (receive the capped limit)
- `lib/dead-letter.cjs` — `listDeadLetters` (receives the capped limit)
- `lib/external-systems.cjs` — `listExternalSystems` (receives the capped limit)
