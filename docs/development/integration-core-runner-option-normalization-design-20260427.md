# Design: Normalize Pipeline Runner Paging Options

**Date**: 2026-04-27  
**Files**: `plugins/plugin-integration-core/lib/pipeline-runner.cjs`

---

## Problem

`runPipeline` previously accepted `pipeline.options.batchSize` and `pipeline.options.maxPages` whenever `Number.isInteger(...)` returned true:

```javascript
const batchSize = Number.isInteger(context.pipeline.options?.batchSize)
  ? context.pipeline.options.batchSize
  : 1000
const maxPages = Number.isInteger(context.pipeline.options?.maxPages)
  ? context.pipeline.options.maxPages
  : 100
```

This let invalid but integer values through:

| Option | Bad value | Result before this change |
|---|---:|---|
| `maxPages` | `0` or negative | `while (page < maxPages)` never runs; run succeeds as a silent no-op |
| `batchSize` | `0` or negative | invalid `limit` is passed into the source adapter |
| `batchSize` | very large integer | oversized adapter read request can create memory/API pressure |

These values can happen through hand-edited pipeline JSON, import tooling, or future UI bugs.

## Fix

Add a local runner option normalizer:

```javascript
function normalizePositiveIntegerOption(value, { defaultValue, max }) {
  if (value === undefined || value === null || value === '') return defaultValue
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) return defaultValue
  return Math.min(numeric, max)
}
```

Apply it to:

| Option | Default | Max |
|---|---:|---:|
| `batchSize` | `1000` | `10000` |
| `maxPages` | `100` | `10000` |

## Behavior

- Missing, empty, non-integer, zero, or negative values fall back to defaults.
- Numeric strings such as `"200"` are accepted because pipeline configuration may come from JSON/form tooling.
- Oversized values are capped before any source adapter call.

## Why Fallback Instead of Throw?

These options are safety limits, not business data. A bad value should not turn a scheduled PLM -> ERP sync into a successful no-op, and it should not fail the whole pipeline if a safe default is available. The runner already has stable defaults; using them keeps the integration moving while bounding resource usage.

## Affected Surface

| File | Change |
|---|---|
| `lib/pipeline-runner.cjs` | Adds option constants and `normalizePositiveIntegerOption`; uses it for `batchSize` and `maxPages` |
| `__tests__/pipeline-runner.test.cjs` | Adds section 21 covering zero fallback and oversized batch cap |
