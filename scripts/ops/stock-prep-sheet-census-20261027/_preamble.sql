-- ============================================================================
-- _preamble.sql — shared execution contract for the stock-prep doubled-sheet
--                 census pack (batch-refresh step 6d-1a, 2026-10-27)
-- ============================================================================
-- INCLUDED BY 01-sheet-census.sql via `\ir`. Never run on its own; running it
-- alone only sets session GUCs and returns nothing.
--
-- Copied from scripts/ops/readonly-inventory-20260916/_preamble.sql (the
-- read-only pack precedent, F6-28) so this pack has exactly ONE documented way
-- to run it:
--
--   psql "$READONLY_DATABASE_URL" -X -f 01-sheet-census.sql
--
-- What it pins:
--   ON_ERROR_STOP on  — any SQL error aborts the file with a non-zero psql exit
--     status. Combined with the `CENSUS_RESULT` line the file prints as its
--     LAST statement, this gives a reliable completion signal:
--       * a run that printed `CENSUS_RESULT … status=complete`   → complete
--       * a run that printed `… status=incomplete reason=…`      → incomplete
--       * a run that printed NO `CENSUS_RESULT` line at all      → incomplete
--         (aborted: syntax error, permission denied, statement timeout 57014,
--          cancelled query, dropped connection, Ctrl-C, or an output pipe
--          truncated mid-file). NEVER read a missing line as "zero doubled
--          sheets".
--   default_transaction_read_only on — a write that slipped into this pack (or
--     into a future edit of it) fails with SQLSTATE 25006 instead of running.
--     Defence in depth; the pack must still be run as a read-only role.
--   statement_timeout 120s / lock_timeout 5s /
--   idle_in_transaction_session_timeout 30s — a single query can never pin a
--     production database. A timeout is an ERROR, so ON_ERROR_STOP turns it
--     into the "no CENSUS_RESULT line" = incomplete case above.
--   search_path — pinned to the caller-supplied `schema` variable when given
--     (`psql … -v schema=public`), else left at the role default. Every probe
--     resolves through the same search_path the queries use.
--   pager off — stable, non-interactive output. Pipe the run to a file
--     (`psql … -f 01-sheet-census.sql > census.log 2>&1`) to keep the evidence.
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
