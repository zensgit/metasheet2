# Design: Cap Dry-Run sampleLimit at MAX_SAMPLE_LIMIT

**PR**: #1201  
**Date**: 2026-04-26  
**File**: `plugins/plugin-integration-core/lib/http-routes.cjs`

---

## Problem

`publicRunInput` converts `body.sampleLimit` to a positive integer without any upper bound:

```javascript
sampleLimit: asPositiveInt(body.sampleLimit),
```

A caller submitting `sampleLimit: 9999999` signals they want a "sample" preview, but the pipeline runner would stream up to `maxPages × batchSize` records (e.g. 100 × 1000 = 100,000 rows). The name "sample" implies a bounded read; the missing cap breaks that contract.

The underlying runner uses:

```javascript
const effectiveBatchSize = dryRun && sampleLimit > 0
  ? Math.min(input.sampleLimit, batchSize)    // bounded by batchSize per page
  : batchSize

let remainingDryRunSamples = dryRun && sampleLimit > 0
  ? input.sampleLimit                         // total cross-page cap — unbounded
  : null
```

With `sampleLimit=9999999` and `batchSize=1000`, the effective per-page limit is 1000 but the total cap across 100 pages is 9,999,999 — effectively uncapped.

## Fix

Add `MAX_SAMPLE_LIMIT = 10000` and `asSampleLimit()` helper; apply in `publicRunInput`:

```javascript
const MAX_SAMPLE_LIMIT = 10000

function asSampleLimit(value) {
  const n = asPositiveInt(value)
  if (n === undefined) return undefined
  return Math.min(n, MAX_SAMPLE_LIMIT)
}

// in publicRunInput:
sampleLimit: asSampleLimit(body.sampleLimit),
```

`publicRunInput` is called by both `/run` and `/dry-run` handlers, so both endpoints are covered with a single change.

## Semantics

| Input | Behavior |
|-------|----------|
| Absent / `''` / `0` | Stripped — runner reads all pages (no sample cap) |
| `'5'` | `5` — passed through |
| `'10001'` | `10000` — clamped |
| `'9999999'` | `10000` — clamped |

Clamping is preferred over rejection: the caller still gets a valid preview, just limited to a safe depth.

## Prior Art

Same pattern as `MAX_LIST_LIMIT = 500` (#1192) and `MAX_LIST_OFFSET = 10000` (#1199).

## Affected Files

| File | Change |
|------|--------|
| `lib/http-routes.cjs` | `MAX_SAMPLE_LIMIT`, `asSampleLimit()`, applied in `publicRunInput` |
| `__tests__/http-routes.test.cjs` | `testSampleLimitCap()` — 4 assertions |
