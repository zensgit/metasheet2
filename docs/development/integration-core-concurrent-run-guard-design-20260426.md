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
This PR places the friendly guard at the insert point and wraps the check+insert
critical section in an in-process `(tenantId, workspaceId, pipelineId)` lock.
That closes the async race for the single-node PoC runtime while keeping the
invariant owned by `createPipelineRun`, where the `disabled` pipeline check also
lives.

### DB-authoritative partial unique index (migration 058)

The in-process lock is not enough for a multi-node deployment: two separate Node
processes can still both snapshot "no running row" before either insert commits.
Migration 058 makes the invariant database-authoritative:

```sql
WITH duplicate_running AS (...)
UPDATE integration_runs
SET status = 'failed',
    finished_at = COALESCE(finished_at, NOW()),
    error_summary = COALESCE(error_summary, 'abandoned: duplicate running run closed before unique guard migration')
WHERE id IN (SELECT id FROM duplicate_running WHERE duplicate_rank > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_runs_one_running_per_pipeline
  ON integration_runs (tenant_id, COALESCE(workspace_id, ''), pipeline_id)
  WHERE status = 'running';
```

`COALESCE(workspace_id, '')` is required because PostgreSQL unique indexes treat
`NULL` values as distinct. Without the expression, two `workspace_id IS NULL`
running rows for the same tenant/pipeline would still be allowed.

The pre-index cleanup keeps the earliest `running` row per
`(tenant_id, workspace_id, pipeline_id)` and fails duplicate running rows with a
clear `error_summary`. That makes the migration replayable on an environment
where the old bug already produced duplicate run rows instead of failing during
`CREATE UNIQUE INDEX`.

`createPipelineRun` keeps the pre-insert read for the normal operator path. If a
real race still reaches `db.insertOne`, PostgreSQL raises `23505` on
`uniq_integration_runs_one_running_per_pipeline`; the registry catches that
specific constraint and converts it to the same `PipelineConflictError` shape,
including `runningRunId` when the blocking row is visible.

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
| `packages/core-backend/migrations/058_integration_runs_running_unique.sql` | duplicate-running cleanup + DB partial unique index for one `running` row per tenant/workspace/pipeline |
| `lib/pipelines.cjs` | `PipelineConflictError` class; in-process keyed lock + friendly guard in `createPipelineRun`; DB unique-conflict normalization; `abandonStaleRuns` function; export both |
| `lib/http-routes.cjs` | `inferHttpStatus`: add `Conflict` → 409 |
| `__tests__/pipelines.test.cjs` | conflict guard + in-process race + DB unique-conflict normalization + stale cleanup |
| `__tests__/http-routes.test.cjs` | 1 new scenario (409 response shape for conflict) |
| `__tests__/migration-sql.test.cjs` | validates migration 058 partial unique index shape |
| this design doc | — |
| matching verification doc | — |

## What this does NOT fix

- **Long-running legitimate runs blocked by strict threshold**: `olderThanMs` is
  configurable; callers that need > 4h runs should pass a larger value.
- **Auto-wiring of `abandonStaleRuns`**: exported but not called anywhere yet.
  Wiring it to plugin startup or to the run-trigger route is follow-up work.

## Cross-references

- Broader-surface audit: `docs/development/bool-coercion-audit-broader-surface-20260426.md`
  (this is the "race conditions in concurrent runs" lane flagged as next audit class)
- Pipeline runner: `plugins/plugin-integration-core/lib/pipeline-runner.cjs`
- Pipelines registry: `plugins/plugin-integration-core/lib/pipelines.cjs`
