-- 058_integration_runs_composite_index.sql
-- plugin-integration-core · Performance index for concurrent-run guard and stale-run cleanup
--
-- Background:
--   PR #1187 added a concurrent-run guard inside createPipelineRun that queries:
--     SELECT * FROM integration_runs
--     WHERE tenant_id=? AND workspace_id=? AND pipeline_id=? AND status='running'
--     LIMIT 1
--
--   abandonStaleRuns() (also from PR #1187) queries:
--     SELECT * FROM integration_runs
--     WHERE tenant_id=? AND workspace_id=? AND [pipeline_id=?] AND status='running'
--
--   The existing indexes (idx_integration_runs_scope on tenant+workspace,
--   idx_integration_runs_pipeline on pipeline_id, idx_integration_runs_status on status)
--   force the planner to merge-join or nested-loop across three separate indexes.
--
--   A composite covering index on (tenant_id, pipeline_id, status) lets both queries
--   be satisfied by a single index scan with LIMIT 1 short-circuit. workspace_id is
--   intentionally excluded from the leading columns because most deployments use a
--   single workspace per tenant; the per-row workspace_id filter is cheap after
--   the (tenant_id, pipeline_id, status) prefix narrows the scan to O(1) rows.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_integration_runs_tenant_pipeline_status
  ON integration_runs (tenant_id, pipeline_id, status);

-- Also covers the common "list recent runs for a pipeline" access pattern used by
-- listPipelineRuns when filtering by both pipelineId and status, sharing the same index.
