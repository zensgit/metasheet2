-- 060_integration_runs_provenance.sql
-- plugin-integration-core · DF-N2-2a provenance storage
--
-- Storage-only migration for the Data Factory per-record provenance chain.
-- Runtime writes stay locked behind DF-N2-2b; read routes stay locked behind
-- DF-N2-2c. This migration only prepares the existing run table and a
-- read-only by-row view.
--
-- Important boundary: the DB storage anchor is integration_runs. The staging
-- multitable objects named integration_run_log / integration_exceptions are
-- not database tables and must not be referenced here.
-- ---------------------------------------------------------------------------

ALTER TABLE integration_runs
  ADD COLUMN IF NOT EXISTS provenance_events JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE VIEW integration_provenance_by_row AS
SELECT
  r.tenant_id,
  r.workspace_id,
  r.pipeline_id,
  r.id AS run_id,
  r.mode AS run_mode,
  r.status AS run_status,
  r.created_at AS run_created_at,
  r.started_at AS run_started_at,
  r.finished_at AS run_finished_at,
  provenance_item.ordinality AS event_index,
  provenance_item.event ->> 'rowId' AS row_id,
  provenance_item.event ->> 'eventType' AS event_type,
  provenance_item.event ->> 'at' AS event_at,
  COALESCE(provenance_item.event -> 'attrs', '{}'::jsonb) AS attrs,
  provenance_item.event AS event
FROM integration_runs r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(r.provenance_events) = 'array' THEN r.provenance_events
    ELSE '[]'::jsonb
  END
) WITH ORDINALITY AS provenance_item(event, ordinality)
WHERE jsonb_typeof(provenance_item.event) = 'object'
  AND provenance_item.event ? 'rowId';
