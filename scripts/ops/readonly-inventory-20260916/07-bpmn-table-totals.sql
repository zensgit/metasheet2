-- ============================================================================
-- 07-bpmn-table-totals.sql — read-only row counts of the 11 legacy BPMN tables
-- ============================================================================
-- Why: owner ruling 2026-11-06 「审批和自动化不用 BPMN，运行时和设计器都弃用」.
--   Before the BPMN runtime and designer code are removed, confirm that no
--   site holds BPMN data. The tables come from migration
--   zz20251231_create_bpmn_tables.ts and exist on every migrated database;
--   only the legacy runtime (routes/workflow.ts + BPMNWorkflowEngine.ts)
--   writes them, and that runtime is closed unless ENABLE_BPMN_RUNTIME is
--   the exact literal 'true'.
--
-- Output: one row per table (table name + row count), then the
--   INVENTORY_RESULT line. Every count 0 => nothing to keep or migrate.
--
-- VALUES-FREE: only counts are selected. No id, key, name, variable, payload
--   or audit text. (bpmn_variables / bpmn_audit_log can hold business data,
--   which is why nothing but count(*) is read.)
--
-- READ ACCESS: needs SELECT on the 11 tables. A role that cannot see a table
--   gets status=incomplete (probe) or an ERROR with no INVENTORY_RESULT line,
--   never a false zero.
--
-- RUN WITH (the only supported form; `_preamble.sql` in the same directory):
--   psql -X -v schema=public -f 07-bpmn-table-totals.sql
--   (-X: ignore any .psqlrc, which could turn AUTOCOMMIT off.)
-- ============================================================================

\ir _preamble.sql
-- The preamble's default_transaction_read_only only covers LATER
-- transactions. If this file runs inside one transaction (`psql -1`, or
-- AUTOCOMMIT off), that transaction is already open, so make it read-only too.
SET transaction_read_only = on;


-- ── Probe (all 11 tables visible to this role in the resolved schemas) ──────
SELECT count(DISTINCT table_name) AS bpmn_tables_present
  FROM information_schema.tables
 WHERE table_schema = ANY (current_schemas(false))
   AND table_name IN ('bpmn_process_definitions', 'bpmn_process_instances',
                      'bpmn_activity_instances', 'bpmn_user_tasks',
                      'bpmn_timer_jobs', 'bpmn_message_events',
                      'bpmn_signal_events', 'bpmn_variables',
                      'bpmn_incidents', 'bpmn_external_tasks',
                      'bpmn_audit_log')
\gset
SELECT :bpmn_tables_present = 11 AS has_all
\gset


\if :has_all
-- ── B1. row count per table ─────────────────────────────────────────────────
SELECT table_name, row_count FROM (
            SELECT  1 AS ord, 'bpmn_process_definitions' AS table_name, count(*)::bigint AS row_count FROM bpmn_process_definitions
  UNION ALL SELECT  2, 'bpmn_process_instances',  count(*) FROM bpmn_process_instances
  UNION ALL SELECT  3, 'bpmn_activity_instances', count(*) FROM bpmn_activity_instances
  UNION ALL SELECT  4, 'bpmn_user_tasks',         count(*) FROM bpmn_user_tasks
  UNION ALL SELECT  5, 'bpmn_timer_jobs',         count(*) FROM bpmn_timer_jobs
  UNION ALL SELECT  6, 'bpmn_message_events',     count(*) FROM bpmn_message_events
  UNION ALL SELECT  7, 'bpmn_signal_events',      count(*) FROM bpmn_signal_events
  UNION ALL SELECT  8, 'bpmn_variables',          count(*) FROM bpmn_variables
  UNION ALL SELECT  9, 'bpmn_incidents',          count(*) FROM bpmn_incidents
  UNION ALL SELECT 10, 'bpmn_external_tasks',     count(*) FROM bpmn_external_tasks
  UNION ALL SELECT 11, 'bpmn_audit_log',          count(*) FROM bpmn_audit_log
) t ORDER BY ord;
\else
\echo '-- not all 11 bpmn_* tables are visible — B1 skipped.'
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- No `INVENTORY_RESULT` line printed => the run aborted => INCOMPLETE, never "zero".
SELECT 'INVENTORY_RESULT file=07-bpmn-table-totals.sql status=' ||
       CASE
         WHEN :'has_all'::boolean THEN 'complete scope=bpmn_tables:11'
         ELSE 'incomplete reason=missing-tables:' || (11 - :bpmn_tables_present) || ' scope=none'
       END AS inventory_result;
