-- ============================================================================
-- _preamble.sql — shared execution contract for the 2026-09-16 read-only pack
-- ============================================================================
-- INCLUDED BY every 0N-*.sql file in this directory via `\i`. Never run on its
-- own; running it alone only sets session GUCs and returns nothing.
--
-- WHY THIS FILE EXISTS (review finding F5): the first version of this pack told
-- the operator three mutually incompatible things — "run the whole file with
-- psql -f", "psql stops on error", "do NOT run the whole file, psql continues
-- on error by default". Only the third was true of stock psql. This preamble
-- makes the FIRST one true instead, so there is exactly one documented way to
-- run the pack:
--
--   psql "$DATABASE_URL" -f 0N-....sql
--
-- What it pins:
--   ON_ERROR_STOP on  — any SQL error aborts the file with a non-zero psql exit
--     status. Combined with the `INVENTORY_RESULT` line each file prints as its
--     LAST statement, this gives a reliable completion signal:
--       * a run that printed `INVENTORY_RESULT … status=complete`  → complete
--       * a run that printed `… status=incomplete reason=…`        → incomplete
--       * a run that printed NO `INVENTORY_RESULT` line at all     → incomplete
--         (aborted: syntax error, permission denied, statement timeout 57014,
--          cancelled query 57014/57P01, dropped connection, Ctrl-C, or an
--          output pipe truncated mid-file). NEVER read a missing line, a
--          missing result row, or an aborted run as "zero hits".
--   default_transaction_read_only on — a write that slipped into this pack (or
--     into a future edit of it) fails with SQLSTATE 25006 instead of running.
--     This is defence in depth; the pack must still be run as a read-only role.
--   statement_timeout 120s / lock_timeout 5s /
--   idle_in_transaction_session_timeout 30s — a single query can never pin a
--     production database. A timeout is an ERROR, so ON_ERROR_STOP turns it
--     into the "no INVENTORY_RESULT line" = incomplete case above.
--   search_path — pinned to the caller-supplied `schema` variable when given
--     (`psql … -v schema=public`), else left at the role default. Every probe
--     below resolves tables through `current_schemas(false)`, i.e. exactly the
--     schemas the queries themselves would resolve, so the probe cannot report
--     a table that the queries would not see.
--   pager off / tuples-only off — stable, non-interactive output. Pipe the run
--     to a file (`psql … -f 0N-….sql > run.log 2>&1`) to keep the evidence.
--
-- OUTPUT BUDGET: the id-bearing queries are unbounded by design (the owner
-- asked for "count AND id"). If a count comes back in the thousands, re-run the
-- count-only half and ask for an explicit budget before pulling the id list.
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off
\timing off

-- Pin search_path only when the caller passed -v schema=…; otherwise keep the
-- role's own default (and let the probes resolve through current_schemas()).
\if :{?schema}
  SET search_path = :"schema";
\endif

SET default_transaction_read_only = on;
SET statement_timeout = '120s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';
