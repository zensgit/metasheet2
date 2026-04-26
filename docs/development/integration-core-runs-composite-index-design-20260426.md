# Integration-Core Runs Composite Index · Design

> Date: 2026-04-26
> PR: #1189
> Companion to: PR #1187 (concurrent-run guard), PR #1188 (stale-run autowire)

## Problem

PR #1187 added two access patterns to `integration_runs` that the existing single-column
indexes do not serve efficiently:

### Pattern 1 — Concurrent-run guard (LIMIT 1)

```sql
SELECT * FROM integration_runs
WHERE tenant_id = $1
  AND workspace_id = $2
  AND pipeline_id = $3
  AND status = 'running'
LIMIT 1
```

Fires on every `POST /pipelines/:id/run` request. With existing indexes:

| Index | Selectivity | Action |
|---|---|---|
| `idx_integration_runs_scope` (tenant_id, workspace_id) | Good — narrows to one tenant | Used as leading index |
| `idx_integration_runs_pipeline` (pipeline_id) | Good — narrows to one pipeline | Must merge-join |
| `idx_integration_runs_status` (status) | Poor — 'running' rows are a tiny fraction of all rows | May not be used |

Postgres must merge-join across two indexes and filter by status, or do a nested-loop
scan of the pipeline's runs. For a tenant with many historical runs, this is O(N) per
trigger.

### Pattern 2 — `abandonStaleRuns` scan

```sql
SELECT * FROM integration_runs
WHERE tenant_id = $1
  AND workspace_id = $2
  AND [pipeline_id = $3]
  AND status = 'running'
```

Same multi-index join problem. Called once per `runPipeline` invocation (PR #1188).

## Solution

Migration 058 adds a single composite index:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_integration_runs_tenant_pipeline_status
  ON integration_runs (tenant_id, pipeline_id, status);
```

### Why these columns and this order

- `tenant_id` first — highest selectivity in multi-tenant deployments; eliminates
  cross-tenant rows immediately
- `pipeline_id` second — narrows to one pipeline's runs in the remaining set
- `status` third — the guard filters only `'running'` rows; with the composite, Postgres
  can scan `(tenant_1, pipe_1, 'running')` as a single key lookup → LIMIT 1 short-circuits
  after the first match (or no rows found)

### Why `workspace_id` is not in the leading columns

Most deployments use one workspace per tenant. Including `workspace_id` in the index key
would create a second dimension before `pipeline_id`, increasing index size while providing
minimal additional filtering benefit. The `workspace_id` condition is cheap to evaluate
as a residual predicate after the `(tenant_id, pipeline_id, status)` prefix narrows to O(1) rows.

### Why `CONCURRENTLY`

The migration runs against a live database. `CONCURRENTLY` avoids an exclusive table lock
that would block all reads/writes to `integration_runs` during the migration. The trade-off
is that the index build takes longer (two table scans) but poses zero downtime risk.

## Secondary benefit

`listPipelineRuns` with both `pipelineId` and `status` filters also benefits:

```sql
SELECT * FROM integration_runs
WHERE tenant_id = $1 AND workspace_id = $2 AND pipeline_id = $3 AND status = $4
```

This is the `GET /api/integration/runs?pipelineId=...&status=succeeded` access pattern
used by the operator UI run-history view.

## Files changed

| File | Change |
|---|---|
| `packages/core-backend/migrations/058_integration_runs_composite_index.sql` | New migration (29 lines, comments included) |
| this design doc | — |
| matching verification doc | — |

## What this does NOT change

- No application code changes — pure schema/index addition
- The 057 migration is untouched
- `migration-sql.test.cjs` validates 057 only; the 058 migration is tested by CI's
  `migration-replay` job which replays all migrations against a real Postgres instance

## Cross-references

- PR #1187 — concurrent-run guard (introduces the query this index serves)
- PR #1188 — stale-run autowire (introduces `abandonStaleRuns` call inside `runPipeline`)
- `plugins/plugin-integration-core/lib/pipelines.cjs` — `createPipelineRun` and `abandonStaleRuns`
