-- ============================================================================
-- _preamble.sql — READ-ONLY execution contract for the attachment canary census
-- ============================================================================
-- INCLUDED BY 01-top-level-attachment-census.sql via `\ir`. Never run on its
-- own; running it alone only sets session GUCs and returns nothing.
--
-- Shape copied deliberately from scripts/ops/readonly-inventory-20260916/_preamble.sql
-- (that pack's review finding F5): ONE documented way to run the file —
--
--   psql "$DATABASE_URL" -v schema=public -f 01-top-level-attachment-census.sql
--
-- What it pins:
--   ON_ERROR_STOP on  — any SQL error aborts the file with a non-zero psql exit
--     status. The census prints `INVENTORY_RESULT … status=complete` as its
--     LAST statement, so:
--       * printed `INVENTORY_RESULT … status=complete` → every query ran
--       * printed NO `INVENTORY_RESULT` line at all    → incomplete (aborted:
--         missing table/column, permission denied, statement timeout 57014,
--         cancelled query, dropped connection, Ctrl-C, truncated output pipe).
--       NEVER read a missing line, a missing result row, or an aborted run as
--       "zero hits".
--   default_transaction_read_only on — a write that slips into the census (now
--     or in a future edit) fails with SQLSTATE 25006 instead of running.
--     Defence in depth; the census must still be run as a read-only role.
--   statement_timeout 120s / lock_timeout 5s /
--   idle_in_transaction_session_timeout 30s — one query can never pin a
--     production database. A timeout is an ERROR, so ON_ERROR_STOP turns it
--     into the "no INVENTORY_RESULT line" = incomplete case above.
--   search_path — pinned to the caller-supplied `schema` variable when given
--     (`psql … -v schema=public`), else left at the role default.
--   pager off — stable, non-interactive output. Pipe the run to a file
--     (`psql … -f 01-….sql > run.log 2>&1`) to keep the evidence.
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off
\timing off

\if :{?schema}
  SET search_path = :"schema";
\endif

SET default_transaction_read_only = on;
SET statement_timeout = '120s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';
