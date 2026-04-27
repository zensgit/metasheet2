# Design: Call abandonStaleRuns Best-Effort Before Pipeline Runs

**PR**: #1197  
**Date**: 2026-04-26  
**Supersedes**: #1188  
**Primary file**: `plugins/plugin-integration-core/lib/pipeline-runner.cjs`

## Problem

PR #1187 made the concurrent-run invariant real: a pipeline can have at most
one `status='running'` row in a tenant/workspace scope. That prevents duplicate
watermark reads and double ERP writes, but it also means a crash-stuck
`running` row can block the next run.

`pipelineRegistry.abandonStaleRuns()` already exists after #1187. It marks
old `running` rows as `failed`, using a default 4-hour threshold. The missing
piece is wiring it into the normal run path.

## Why #1188 Is Not Enough

#1188 added the call, but treated stale-run cleanup as a hard prerequisite:

```javascript
await pipelineRegistry.abandonStaleRuns({ ... })
```

If the cleanup query throws because the DB is temporarily unhealthy, the main
pipeline never starts. That is the wrong failure mode: stale-run cleanup is a
recovery attempt, not a new required dependency for every run.

## Solution

Call `abandonStaleRuns()` after `loadPipelineContext()` and before
`runLogger.startRun()`, but wrap it as best-effort:

```javascript
if (typeof pipelineRegistry.abandonStaleRuns === 'function') {
  try {
    await pipelineRegistry.abandonStaleRuns({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      pipelineId: context.pipeline.id,
    })
  } catch {
    // Non-fatal: stale-run cleanup is best-effort.
  }
}
```

The placement matters:

- `loadPipelineContext()` has already resolved tenant, workspace, and pipeline.
- No new run row exists yet, so a cleanup failure cannot leave another orphan.
- A stale blocking run gets one automatic recovery attempt before the DB unique
  guard from #1187 rejects the new run.

## Behavior

- Healthy cleanup path: stale rows for this pipeline are failed, then the new
  run starts normally.
- Cleanup throws: the runner continues. If a blocking `running` row still exists,
  `startRun()` returns the normal `PipelineConflictError` path from #1187.
- Registry lacks `abandonStaleRuns`: no-op for older mocks or alternate registry
  implementations.

## Scope

This PR intentionally does not add tenant-wide startup sweep logic. That can be
added later in plugin activation if operators need automatic cleanup across all
pipelines. This change only handles the high-value path: an operator triggers a
specific pipeline and gets one pipeline-scoped recovery attempt first.

## Files Changed

| File | Change |
| --- | --- |
| `plugins/plugin-integration-core/lib/pipeline-runner.cjs` | Best-effort `abandonStaleRuns()` call before `startRun()` |
| `plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs` | Section 17 coverage for call, failure suppression, and missing-method compatibility |
| `docs/development/integration-core-stale-run-besteffort-design-20260426.md` | This design note |
| `docs/development/integration-core-stale-run-besteffort-verification-20260426.md` | Verification evidence |
