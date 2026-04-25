-- 058_add_approval_breach_notified_at.sql
-- Persist breach-notification dispatch so the SLA notifier survives restarts.
--
-- Background: ApprovalBreachNotifier maintains an in-memory Set<instanceId>
-- to dedupe within a single leader process. On restart, that set is lost,
-- and any row whose dispatch was attempted but not yet acknowledged becomes
-- permanently un-notified (the row's sla_breached flag is already TRUE so
-- checkSlaBreaches's WHERE clause excludes it from future cycles).
--
-- This migration adds a persistent breach_notified_at column so:
--   1. Successful dispatches survive restarts.
--   2. A separate "find unnotified breaches" query can retry rows that were
--      flagged but never dispatched.
--   3. Operations / observability can answer "did we notify for instance X?"
--      directly from the DB, without log-grepping.
--
-- The column is nullable (existing rows are backfilled to NULL implicitly)
-- and a partial index optimises the common retry-query
-- (sla_breached = TRUE AND breach_notified_at IS NULL).

ALTER TABLE approval_metrics
  ADD COLUMN IF NOT EXISTS breach_notified_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_approval_metrics_unnotified_breach
  ON approval_metrics(instance_id)
  WHERE sla_breached = TRUE AND breach_notified_at IS NULL;
