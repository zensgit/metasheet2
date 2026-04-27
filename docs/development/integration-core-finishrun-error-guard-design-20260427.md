# Integration-Core FinishRun Error Guard Design - 2026-04-27

## Context

`createPipelineRunner().runPipeline()` records run completion through `runLogger.finishRun()`. On the error path, the original pipeline failure is caught and the runner attempts to mark the run as `failed`.

Before this change, a secondary failure inside `finishRun()` could replace the original pipeline error. That made diagnosis harder: an operator would see a database/update failure instead of the source adapter, transform, validation, or target write failure that actually caused the pipeline to stop.

## Goal

Preserve the original pipeline error as the caller-visible failure, even when the best-effort run-log update also fails.

## Design

The catch path still computes `metrics.durationMs` and still tries to persist a failed run:

```javascript
try {
  run = await runLogger.finishRun(run, metrics, 'failed', {
    errorSummary: error.message || String(error),
  })
} catch {
  // Secondary failure: original error takes priority.
}
```

The runner then throws the same `PipelineRunnerError('pipeline run failed', { run, cause })` shape as before.

## Why Best-Effort Is Correct Here

- The pipeline has already failed; the most useful error is the original root cause.
- The run may remain stuck in `running`, but PR #1197 added best-effort stale-run abandonment before new runs start.
- Throwing the secondary `finishRun()` error would hide whether the source read, transform, target write, or ERP feedback step failed.

## Merge Interaction

This PR overlaps with PR #1191 in `pipeline-runner.test.cjs`. The conflict resolution keeps both behaviors:

- non-open dead-letter replay is rejected before any ERP write path
- failed-run finalization errors do not mask the original pipeline failure

## Files

- `plugins/plugin-integration-core/lib/pipeline-runner.cjs`
- `plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs`

## Non-Goals

- This does not make successful run finalization best-effort.
- This does not introduce a new warning channel for failed run-log persistence.
- This does not change stale-run thresholds or run recovery policy.
