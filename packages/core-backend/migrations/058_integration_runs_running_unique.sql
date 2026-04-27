-- 058_integration_runs_running_unique.sql
-- plugin-integration-core · DB-authoritative concurrent-run guard
--
-- Enforce the invariant that a pipeline can have at most one active
-- status='running' run in a tenant/workspace scope. The application-level
-- check in plugin-integration-core gives a friendly 409 for normal requests,
-- but this partial unique index is the final cross-process guard for real
-- concurrent inserts.
--
-- workspace_id is nullable in the integration scope model, so COALESCE keeps
-- NULL workspace rows in one deterministic bucket instead of allowing duplicate
-- NULL keys through PostgreSQL unique-index semantics.
-- ---------------------------------------------------------------------------

WITH duplicate_running AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, COALESCE(workspace_id, ''), pipeline_id
      ORDER BY started_at NULLS LAST, created_at, id
    ) AS duplicate_rank
  FROM integration_runs
  WHERE status = 'running'
)
UPDATE integration_runs
SET
  status = 'failed',
  finished_at = COALESCE(finished_at, NOW()),
  error_summary = COALESCE(error_summary, 'abandoned: duplicate running run closed before unique guard migration')
WHERE id IN (
  SELECT id FROM duplicate_running WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_runs_one_running_per_pipeline
  ON integration_runs (tenant_id, COALESCE(workspace_id, ''), pipeline_id)
  WHERE status = 'running';
