# Design: Per-Record Guard for Null/Non-Object Source Records

**PR**: #1205  
**Date**: 2026-04-27  
**File**: `plugins/plugin-integration-core/lib/pipeline-runner.cjs`

---

## Problem

`processRecord` calls `transformRecord(sourceRecord, fieldMappings)` directly, with no per-record type check:

```javascript
async function processRecord({ context, run, sourceRecord, ... }) {
  metrics.rowsRead += 1
  const transformed = transformRecord(sourceRecord, context.pipeline.fieldMappings || [])
  ...
}
```

`transformRecord` itself enforces a hard precondition (`transform-engine.cjs:182`):

```javascript
function transformRecord(sourceRecord, fieldMappings = []) {
  if (!isPlainObject(sourceRecord)) {
    throw new TransformError('sourceRecord must be an object')
  }
  ...
}
```

When a source adapter returns `[null, validRecord, null]` (buggy or partially-failed paged read), `transformRecord(null, ...)` throws. The throw escapes `processRecord` → the `for` loop → the `while` loop → into `runPipeline`'s outer `catch (error)` block. The entire run is marked `failed`. The valid record that came after the bad one never gets a chance to write.

The replay path was protected in #1202 (`NULL_PAYLOAD` / `INVALID_PAYLOAD_TYPE` pre-flight check), but the regular run path was left exposed — adapters that emit one bad row poison the whole batch.

## Fix

Add a per-record check at the top of `processRecord`. Anything that isn't a plain object becomes its own dead letter with `errorCode: 'INVALID_SOURCE_RECORD'`, and the loop continues:

```javascript
async function processRecord({ context, run, sourceRecord, cleanRecords, metrics, preview, dryRun }) {
  metrics.rowsRead += 1
  if (sourceRecord === null || sourceRecord === undefined ||
      typeof sourceRecord !== 'object' || Array.isArray(sourceRecord)) {
    metrics.rowsFailed += 1
    const failure = {
      ...
      sourcePayload: sourceRecord === null || sourceRecord === undefined
        ? { _adapterReturnedNullRecord: true }
        : sanitizeIntegrationPayload({ _adapterReturnedNonObject: true, value: sourceRecord }),
      transformedPayload: null,
      errorCode: 'INVALID_SOURCE_RECORD',
      errorMessage: `adapter returned ${typeOfSourceRecord} instead of a record object`,
      dryRun,
    }
    await writeDeadLetter(failure)
    if (preview) preview.errors.push({ ...failure, dryRun: undefined })
    return
  }
  const transformed = transformRecord(sourceRecord, context.pipeline.fieldMappings || [])
  ...
}
```

## Why At This Layer?

- `transformRecord` is a pure function; modifying it to handle non-objects would muddy its contract
- `processRecord` already owns the dead-letter routing for `TRANSFORM_FAILED`, `VALIDATION_FAILED`, `IDEMPOTENCY_FAILED` — `INVALID_SOURCE_RECORD` belongs in the same family
- The check needs the run/context/preview wiring that only `processRecord` has

## Error Code Family

| Code | Trigger |
|------|---------|
| `INVALID_SOURCE_RECORD` (new) | Adapter returned null/array/scalar instead of object |
| `TRANSFORM_FAILED` | Field mapping transform threw (bad type coercion, etc.) |
| `VALIDATION_FAILED` | Field validator rejected (required missing, pattern mismatch, etc.) |
| `IDEMPOTENCY_FAILED` | Couldn't compute idempotency key |
| `TARGET_WRITE_FAILED` | Target adapter rejected the record |

## Sanitized Payload

For `null`/`undefined`, the dead letter payload is a marker object `{ _adapterReturnedNullRecord: true }` (no actual data to redact). For other non-objects (string, number, array), the value is wrapped via `sanitizeIntegrationPayload({ _adapterReturnedNonObject: true, value })` so the redaction layer still scrubs sensitive content if any leaked into a string.

## Affected Files

| File | Change |
|------|--------|
| `lib/pipeline-runner.cjs` | Type check + dead-letter write at top of `processRecord` |
| `__tests__/pipeline-runner.test.cjs` | Section 20 — 6-record mixed batch (null, valid, undefined, string, valid, array) → 2 written, 4 dead letters with `INVALID_SOURCE_RECORD` |
