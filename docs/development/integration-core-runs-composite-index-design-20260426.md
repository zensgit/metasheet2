# Integration-Core Runs Composite Index · Design

> Date: 2026-04-26
> PR: #1189
> Companion to: PR #1187 (DB-authoritative concurrent-run guard), PR #1197 (stale-run best-effort autowire)

## Problem

#1187 and #1197 add three access patterns to `integration_runs`. #1187 now owns
correctness with migration 058's partial unique index; this PR is only a
performance follow-up for read/query shape.

### Pattern 1 — Concurrent-run guard (LIMIT 1)

```sql
SELECT * FROM integration_runs
WHERE tenant_id = $1
  AND workspace_id = $2
  AND pipeline_id = $3
  AND status = 'running'
LIMIT 1
```

Fires on every `POST /pipelines/:id/run` request. Correctness is guaranteed by
`uniq_integration_runs_one_running_per_pipeline` from migration 058. This PR
only gives the friendly pre-check a regular lookup path before the insert hits
the unique guard.

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
  AND pipeline_id = $3
  AND status = 'running'
```

Called once per `runPipeline` invocation by #1197. The #1197 call is
pipeline-scoped, so the lookup includes `pipeline_id`.

### Pattern 3 — Run history for one pipeline and status

```sql
SELECT * FROM integration_runs
WHERE tenant_id = $1
  AND workspace_id = $2
  AND pipeline_id = $3
  AND status = $4
ORDER BY created_at DESC
LIMIT $5
```

This powers operator run-history screens such as:
`GET /api/integration/runs?pipelineId=...&status=succeeded`.

## Solution

Migration 059 adds a single composite index:

```sql
CREATE INDEX IF NOT EXISTS idx_integration_runs_scope_pipeline_status_created_at
  ON integration_runs (tenant_id, workspace_id, pipeline_id, status, created_at DESC);
```

### Why these columns and this order

- `tenant_id`, `workspace_id` first — matches the integration scope guard used
  throughout the plugin registries.
- `pipeline_id` third — narrows to one pipeline's runs in the remaining scoped set.
- `status` fourth — supports both `running` pre-check/stale cleanup and status
  filtered run history.
- `created_at DESC` last — supports the run-history `ORDER BY created_at DESC`
  without an extra sort when all preceding equality predicates are present.

### Why `workspace_id` is a normal key column

The DB unique index in 058 uses `COALESCE(workspace_id, '')` because it needs
NULL-deterministic uniqueness. This performance index uses plain `workspace_id`
because the safe query builder emits `workspace_id IS NULL` or
`workspace_id = $n`; using a plain column keeps the index aligned with the query.

### Why not `CONCURRENTLY`

The repo's SQL migration provider executes migrations through Kysely's migrator,
which wraps each migration in a transaction. PostgreSQL rejects
`CREATE INDEX CONCURRENTLY` inside a transaction block, so this migration uses
plain `CREATE INDEX IF NOT EXISTS` to stay compatible with existing migration
replay and deployment tooling.

Operational trade-off: this can briefly lock writes to `integration_runs` while
the index is built. The current table is expected to be small during the K3 PoC
phase. If this table becomes large before production rollout, build a dedicated
non-transactional maintenance path for concurrent indexes rather than bypassing
the normal migration runner in this PR.

## Secondary benefit

The earlier draft used migration number 058 and an index on
`(tenant_id, pipeline_id, status)`. That is no longer correct after #1187 merged:

- 058 is already used by the DB-authoritative running-run unique index.
- The original index did not include `workspace_id`, so it did not match the
  full tenant/workspace scope used by integration registry queries.
- The original index did not include `created_at DESC`, so it did less for
  ordered run-history pages.

## Files changed

| File | Change |
|---|---|
| `packages/core-backend/migrations/059_integration_runs_history_index.sql` | New performance index migration |
| `plugins/plugin-integration-core/__tests__/migration-sql.test.cjs` | Validates 059 index structure |
| this design doc | — |
| matching verification doc | — |

## What this does NOT change

- No application code changes — pure schema/index addition
- The 057/058 migrations are untouched
- This PR does not change locking correctness; 058's partial unique index remains
  the final concurrent-run guard.

## Cross-references

- PR #1187 — DB-authoritative concurrent-run guard
- PR #1197 — stale-run best-effort autowire
- `plugins/plugin-integration-core/lib/pipelines.cjs` — `createPipelineRun` and `abandonStaleRuns`
