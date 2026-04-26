# Integration-Core Stale-Run Autowire · Design

> Date: 2026-04-26
> PR: #1188
> Depends on: PR #1187 (abandons the stale run; this PR wires the call)

## Problem

PR #1187 exported `pipelineRegistry.abandonStaleRuns` but left it uncalled. The tool
exists; no caller invokes it automatically. Result: a process crash between `startRun`
and `finishRun`/`failRun` leaves a run permanently `status='running'`. Once #1187's
concurrent-run guard is active, this becomes a silent deadlock — every subsequent trigger
of that pipeline returns HTTP 409 CONFLICT with `runningRunId` pointing at a ghost run
that will never complete. The operator has no automated recovery path.

## Solution

`runPipeline` calls `pipelineRegistry.abandonStaleRuns` immediately after
`loadPipelineContext` (pipeline validated) and before `runLogger.startRun`
(run record created):

```javascript
if (typeof pipelineRegistry.abandonStaleRuns === 'function') {
  await pipelineRegistry.abandonStaleRuns({
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    pipelineId: context.pipeline.id,
  })
}
```

**Why here:** The sweep is scoped to the specific pipeline being triggered.
This is the natural gate: an operator triggers pipeline P → the runner sweeps
for stuck runs of P (only P, not all pipelines) → clears any crash-ghost →
startRun proceeds → concurrent-run guard checks again and finds nothing.

**Why scoped to pipelineId:** A stuck run on pipeline Q should not be swept when
pipeline P is triggered. The sweep only clears the ghost that would block the
imminent trigger. This prevents unexpected side effects on unrelated pipelines.

**Default staleness threshold:** `abandonStaleRuns` defaults to 4 hours. The
longest expected PoC full-sync run is < 30 min. 4h means a crashed run is
cleared no later than the next trigger after the 4h window closes.

**typeof guard:** The call is conditional on `typeof pipelineRegistry.abandonStaleRuns
=== 'function'`. This ensures:
- Registries without `abandonStaleRuns` (pre-#1187 or test mocks) are unaffected
- No new required dependency is added to `requireDependency` validation

## Execution order after this PR

```
runPipeline(input)
  ├─ loadPipelineContext  — validate pipeline exists + active
  ├─ abandonStaleRuns     — [NEW] sweep crashed ghost runs for this pipeline
  ├─ startRun             — concurrent-run guard fires here (#1187)
  ├─ ... run body ...
  └─ finishRun / failRun  — mark run terminal, watermark advance
```

## Files changed

| File | Change |
|---|---|
| `lib/pipeline-runner.cjs` | 7 lines added between `loadPipelineContext` and `startRun` |
| `__tests__/pipeline-runner.test.cjs` | `abandonStaleRunsCalls` tracker added to mock registry; `pipelineRegistry` added to `createRunnerHarness` return; 2 new scenarios |
| this design doc | — |
| matching verification doc | — |

## What this does NOT change

- **`abandonStaleRuns` API** — unchanged from #1187; threshold, return type, and scope
  semantics are identical
- **Happy-path behavior** — `abandonStaleRuns` returns `[]` (no stale runs) in the normal
  case; no observable difference for successful previous runs
- **Error handling** — if `abandonStaleRuns` itself throws, the error propagates out of
  `runPipeline` before `startRun` is called; no orphaned run records are created

## Cross-references

- PR #1187 — `abandonStaleRuns` implementation + concurrent-run guard
- PR #1189 — composite index for the concurrent-run guard query (independent)
