# Design: Cap Run errorSummary at MAX_ERROR_SUMMARY_LENGTH

**PR**: #1206  
**Date**: 2026-04-27  
**File**: `plugins/plugin-integration-core/lib/run-log.cjs`

---

## Problem

`failRun` builds the `errorSummary` written to `integration_runs.error_summary`:

```javascript
async function failRun(run, error, metrics = {}, extra = {}) {
  return finishRun(run, metrics, 'failed', {
    ...extra,
    errorSummary: extra.errorSummary || (error && error.message) || String(error),
  })
}
```

Adapter errors commonly include:
- Full HTTP response body (K3 WISE WebAPI returns multi-line XML/JSON error envelopes)
- Deep stack traces (Node.js `Error.stack` can be 10KB+ for adapter chains)
- DB driver errors that include the full failed query parameters

A few percent of pipeline runs producing 100KB+ `error_summary` rows results in:
- Slow `SELECT *` on the runs table (the column is a TEXT field — no row size limit, but each row read pulls the whole thing)
- Bloated DB exports (a 1000-row export with 10 huge errors is ~1MB instead of ~100KB)
- Unexpected memory usage when many rows are loaded into application memory at once

## Fix

Add `truncateErrorSummary()` and apply it in both `finishRun` (for `extra.errorSummary`) and `failRun` (for the derived summary). Truncated strings end with `'… [truncated]'` so downstream tooling can detect truncation without needing to compare against the original:

```javascript
const MAX_ERROR_SUMMARY_LENGTH = 2000
const TRUNCATION_SUFFIX = '… [truncated]'

function truncateErrorSummary(value) {
  if (value === undefined || value === null) return value
  const str = typeof value === 'string' ? value : String(value)
  if (str.length <= MAX_ERROR_SUMMARY_LENGTH) return str
  return str.slice(0, MAX_ERROR_SUMMARY_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX
}
```

Applied in `finishRun`:
```javascript
errorSummary: truncateErrorSummary(extra.errorSummary),
```

And in `failRun`:
```javascript
errorSummary: truncateErrorSummary(
  extra.errorSummary || (error && error.message) || String(error),
),
```

## Why 2000?

- Long enough to capture the gist of an HTTP error (status, key fields, first error in a list)
- Short enough that 1000 partial-failure runs cost ~2MB instead of ~100MB+
- A round number that's easy to remember and document

If finer detail is needed, the full error belongs in dead-letter `errorMessage`/`sourcePayload` (already capped via the dead-letter payload sanitizer), not in the per-run summary.

## Semantics

| Input | Behavior |
|-------|----------|
| `undefined` / `null` | Pass through unchanged (DB column accepts NULL) |
| `'connection refused'` (short) | Pass through unchanged |
| 10KB string | Truncated to 2000 chars including `'… [truncated]'` suffix |

## Affected Files

| File | Change |
|------|--------|
| `lib/run-log.cjs` | `MAX_ERROR_SUMMARY_LENGTH`, `truncateErrorSummary()`, applied in `finishRun` + `failRun`; export added |
| `__tests__/runner-support.test.cjs` | 4 scenarios: huge `failRun` message, huge `finishRun` extra, short message, null/absent |
