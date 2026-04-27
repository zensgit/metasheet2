# Design: Wrap Success-Path finishRun in Try-Catch

**PR**: #1200  
**Date**: 2026-04-26  
**File**: `plugins/plugin-integration-core/lib/pipeline-runner.cjs`

---

## Problem

In `runPipeline`, after all ERP writes have committed, the success path calls `finishRun` to mark the run as `succeeded` or `partial`:

```javascript
run = await runLogger.finishRun(run, metrics, status, { details: { ... } })
return { run, metrics, preview }
```

If `updatePipelineRun` fails here (e.g. DB goes down in the narrow window after ERP writes but before the run-record update), the exception propagates to the outer `catch (error)` block:

```javascript
} catch (error) {
  // error = the DB failure from finishRun
  run = await runLogger.finishRun(run, metrics, 'failed', {
    errorSummary: error.message || String(error),
  })  // ← also throws (same DB down)
  throw new PipelineRunnerError('pipeline run failed', { ... })
}
```

The caller receives a `PipelineRunnerError` indicating failure, even though ERP writes already succeeded. Callers may retry the entire run — duplicate ERP writes can result (idempotency keys help but it's still unclean and generates noise in ERP change logs).

## Fix

Wrap `finishRun` in the success path with a dedicated try-catch. On failure, return the result with a `warning` field rather than propagating to the error path:

```javascript
let finishRunWarning = null
try {
  run = await runLogger.finishRun(run, metrics, status, {
    details: { dryRun, watermarkAdvanced: ..., nextCursor: cursor, erpFeedback },
  })
} catch (finishError) {
  // ERP writes already committed — don't propagate to catch block where
  // callers would see a failure and potentially retry (duplicate writes).
  finishRunWarning = {
    code: 'FINISH_RUN_FAILED',
    message: finishError.message || String(finishError),
  }
}
return {
  run,
  metrics,
  preview,
  ...(finishRunWarning && { warning: finishRunWarning }),
}
```

## Pattern

Same pattern as PR #1195 (`markReplayed` best-effort in `replayDeadLetter`): once the irreversible external operation has completed, subsequent bookkeeping failures return a `warning` rather than masking the outcome as a failure.

## Caller Contract

- **Normal case**: `{ run, metrics, preview }` — no `warning` field; caller can read `run.status`.
- **finishRun failure**: `{ run, metrics, preview, warning: { code: 'FINISH_RUN_FAILED', message: '...' } }` — caller receives 202; `run.status` is still `'running'` (the record was never updated); the ERP write outcome is in `metrics`.

Callers checking `result.warning` can surface the issue in observability without triggering a retry.

## Boundary

Only the success path is wrapped. The catch block is intentionally left as-is (handled by PR #1193's nested try-catch): errors during the pipeline run itself are genuine failures and should propagate as `PipelineRunnerError`.

## Affected Files

| File | Change |
|------|--------|
| `lib/pipeline-runner.cjs` | `finishRunWarning` try-catch in success path of `runPipeline` |
| `__tests__/pipeline-runner.test.cjs` | Section 18 — 2 scenarios (18a: throws → warning, 18b: normal → no warning) |
