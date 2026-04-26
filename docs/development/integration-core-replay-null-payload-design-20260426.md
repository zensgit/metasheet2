# Design: Reject Null/Non-Object sourcePayload Before Replay

**PR**: #1202  
**Date**: 2026-04-26  
**File**: `plugins/plugin-integration-core/lib/pipeline-runner.cjs`

---

## Problem

`replayDeadLetter` passes `sourceRecords: [deadLetter.sourcePayload]` to `runPipeline` without verifying the payload is a record object:

```javascript
const result = await runPipeline({
  ...
  sourceRecords: [deadLetter.sourcePayload],  // ← could be null, array, string, number
})
```

`createDeadLetter` validates that `sourcePayload` is non-null on write. But the DB row can be:
- Directly inserted with `source_payload = NULL` (ops tooling, migration error)
- From a schema version before the validation was added
- Corrupted by a partial write

When `sourcePayload` is `null`, the runner processes `[null]` as source records. `transformRecord(null, fieldMappings)` tries `null[sourceField]` → `TypeError: Cannot read properties of null`. This unhandled TypeError propagates from `processRecord` through the `for` loop, out of the success path, and into the outer `catch` block — crashing the entire replay run with a confusing error rather than a structured `PipelineRunnerError`.

Similarly, array or scalar payloads (e.g., a string or number) are not valid record objects and would cause the same crash.

## Fix

Add explicit guards immediately after the existing `PAYLOAD_TRUNCATED` check:

```javascript
if (deadLetter.sourcePayload === null || deadLetter.sourcePayload === undefined) {
  throw new PipelineRunnerError('dead letter source payload is null and cannot be replayed', {
    id: deadLetter.id,
    reason: 'NULL_PAYLOAD',
  })
}
if (typeof deadLetter.sourcePayload !== 'object' || Array.isArray(deadLetter.sourcePayload)) {
  throw new PipelineRunnerError('dead letter source payload is not a record object and cannot be replayed', {
    id: deadLetter.id,
    reason: 'INVALID_PAYLOAD_TYPE',
  })
}
```

Both checks run before `runPipeline` is called — no run record is created, no target writes happen.

## Guard Ordering

| Check | Reason |
|-------|--------|
| `PAYLOAD_TRUNCATED` (existing) | Intentionally truncated payload — `{ payloadTruncated: true }` object |
| `NULL_PAYLOAD` (new) | null or undefined — unrepresentable as a record |
| `INVALID_PAYLOAD_TYPE` (new) | Array, string, number — not a record object |

## Why Not Catch in `processRecord`?

`processRecord` already handles transform failures, validation failures, and idempotency failures by writing dead letters. But a `TypeError` from `null[field]` inside `transformRecord` is an unhandled exception — it bypasses the dead-letter path entirely and crashes the run. The pre-flight check is simpler and produces a cleaner error for ops.

## Affected Files

| File | Change |
|------|--------|
| `lib/pipeline-runner.cjs` | Two guard blocks after `PAYLOAD_TRUNCATED` check in `replayDeadLetter` |
| `__tests__/pipeline-runner.test.cjs` | Section 5b — 5 payload variants (null, undefined, array, string, number) |
