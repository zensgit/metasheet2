# Integration-Core Concurrent Run Guard · Design

> Date: 2026-04-26
> PR: #1187
> Audit lane: race conditions in concurrent runs (new bug class post bool-coercion series)

## Problem

Two invariants were missing from `pipeline-runner` / `createPipelineRun`:

### Invariant 1 — exclusivity

At most one run may be in status `'running'` per pipeline at a time.

Without this, two simultaneous `POST /pipelines/:id/run` calls both call
`runLogger.startRun()` → `createPipelineRun()`. Both succeed. Both then:
- read from the same watermark baseline
- advance the watermark to the same endpoint
- write to the target ERP

Idempotency blocks duplicate ERP writes. But the double watermark advance
means both runs consumed the same source records, and the watermark
advances once to the value it would have taken if only one run had fired.
Records that arrived *after* the read window but *before* the watermark
advance are silently marked as processed in both runs — they will not be
picked up by the next incremental run.

In a K3 WISE PoC context this is particularly dangerous: a double-click on
"Run" or two operators both triggering simultaneously would cause duplicate
`autoSubmit`/`autoAudit` attempts (even with those flags off in PoC mode,
the write-path executes twice against the test account).

### Invariant 2 — bounded lifetime

A run in status `'running'` must eventually reach a terminal status
(`succeeded`, `partial`, `failed`, `cancelled`).

`runPipeline` wraps its body in a try/catch and calls `failRun` in the
catch block. But a SIGKILL, OOM, or infrastructure restart between
`startRun` and the try/catch can leave the run permanently `'running'`.

Once Invariant 1 is enforced, a permanently-stuck run means no future run
of that pipeline can ever start. Without a cleanup mechanism, the pipeline
is permanently deadlocked with no operator-facing error.

## Solution

### `PipelineConflictError` (pipelines.cjs)

New error class, name matches `/Conflict/` so `inferHttpStatus` maps it to 409.

### Concurrent run guard in `createPipelineRun` (pipelines.cjs)

After validating the pipeline exists and is not disabled, query for existing
`running` runs on the same `(tenant_id, workspace_id, pipeline_id)` tuple:

```javascript
const runningRows = unwrapRows(await db.select(RUNS_TABLE, {
  where: { ...scopeWhere(normalized), pipeline_id: normalized.pipelineId, status: 'running' },
  limit: 1,
}))
if (runningRows.length > 0) {
  throw new PipelineConflictError('pipeline already has a run in progress', {
    pipelineId: normalized.pipelineId,
    runningRunId: runningRows[0].id,
  })
}
```

**Why here and not in `runPipeline`:** `createPipelineRun` is the DB-authoritative
gate. Checking in `runPipeline` before calling `startRun` would have a TOCTOU
window — two callers check simultaneously, both see no running run, both insert.
Placing the guard *inside* `createPipelineRun` (the insert point) does not
close the window in pure application logic, but it is the correct layer to
own the invariant since `createPipelineRun` is also where the `disabled`
pipeline check lives. A true distributed lock (advisory PG lock,
`SELECT ... FOR UPDATE SKIP LOCKED`) would close the window fully but is
out of scope for single-node PoC.

**Error fields in details:**
- `pipelineId` — which pipeline is blocked
- `runningRunId` — the run that is blocking; operator can look it up in the
  run log to understand why it is stuck

### `abandonStaleRuns` (pipelines.cjs)

```
registry.abandonStaleRuns({ tenantId, workspaceId, [pipelineId], [olderThanMs], [now] })
```

1. Selects all `running` runs (scoped to tenant/workspace, optionally to pipeline)
2. Filters in JS: `started_at < (now - olderThanMs)`
   - JS filtering because `db.select` is equality-only (no `<` operator in the
     current safe structured-query builder; a raw `WHERE started_at < $1` would
     require `rawQuery` which is explicitly excluded for injection safety)
3. For each stale run: `updateRow` → `status: 'failed'`, `finished_at: now`,
   `error_summary: 'abandoned: run exceeded stale threshold ...'`
4. Returns the list of abandoned `PipelineRun` objects

Default threshold: **4 hours**. Chosen because the longest legitimate full-sync
run in the PoC context (full BOM tree) is expected to complete in < 30 min.
4h gives 8× headroom while still catching crashes within a working day.

**When to call:** callers decide the lifecycle. Suggested places:
- Plugin activation (`index.cjs`) — sweep all tenants' stale runs on startup
- Before `POST /pipelines/:id/run` — sweep for the specific pipeline before
  adding the new guard check (gives the operator one automatic recovery attempt)

Both invocation patterns are out of scope for this PR; `abandonStaleRuns` is
exported and available for the caller to wire up.

### `inferHttpStatus` update (http-routes.cjs)

```javascript
if (/Conflict/.test(name)) return 409
```

Placed before the `Validation` check so `PipelineConflictError` → 409, not 400.
Also future-proofs any other `*ConflictError` class in the codebase.

## Files changed

| File | Change |
|---|---|
| `lib/pipelines.cjs` | `PipelineConflictError` class; guard in `createPipelineRun`; `abandonStaleRuns` function; export both |
| `lib/http-routes.cjs` | `inferHttpStatus`: add `Conflict` → 409 |
| `__tests__/pipelines.test.cjs` | 5 new scenarios (conflict guard + stale cleanup) |
| `__tests__/http-routes.test.cjs` | 1 new scenario (409 response shape for conflict) |
| this design doc | — |
| matching verification doc | — |

## What this does NOT fix

- **Distributed concurrent runs**: two Node processes on separate hosts can both
  pass the guard simultaneously (TOCTOU). Not a concern for single-node PoC.
- **Long-running legitimate runs blocked by strict threshold**: `olderThanMs` is
  configurable; callers that need > 4h runs should pass a larger value.
- **Auto-wiring of `abandonStaleRuns`**: exported but not called anywhere yet.
  Wiring it to plugin startup or to the run-trigger route is follow-up work.

## Cross-references

- Broader-surface audit: `docs/development/bool-coercion-audit-broader-surface-20260426.md`
  (this is the "race conditions in concurrent runs" lane flagged as next audit class)
- Pipeline runner: `plugins/plugin-integration-core/lib/pipeline-runner.cjs`
- Pipelines registry: `plugins/plugin-integration-core/lib/pipelines.cjs`
