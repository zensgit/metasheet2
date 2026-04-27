-- 059_integration_runs_history_index.sql
-- plugin-integration-core · Run-history and stale-run lookup index
--
-- 058 owns correctness: a partial unique index enforces at most one
-- status='running' row per tenant/workspace/pipeline.
--
-- This migration is performance-only. It supports the run-history and
-- pipeline-scoped lookup patterns used by:
--   - listPipelineRuns({ tenantId, workspaceId, pipelineId, status })
--   - createPipelineRun's friendly pre-check before the DB unique guard
--   - abandonStaleRuns({ tenantId, workspaceId, pipelineId })
--
-- workspace_id stays as a normal key column here because the query builder emits
-- "workspace_id IS NULL" or "workspace_id = $n", not a COALESCE expression.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_integration_runs_scope_pipeline_status_created_at
  ON integration_runs (tenant_id, workspace_id, pipeline_id, status, created_at DESC);
