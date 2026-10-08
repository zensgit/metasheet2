-- ============================================================================
-- _preamble.sql — READ-ONLY execution contract for the live_id FK pack
-- ============================================================================
-- INCLUDED BY 01-inventory.sql via `\ir`. Never run on its own; running it
-- alone only sets session GUCs and returns nothing.
--
-- Shape copied deliberately from scripts/ops/readonly-inventory-20260916/_preamble.sql
-- (that pack's review finding F5): ONE documented way to run the file —
--
--   psql "$DATABASE_URL" -f 01-inventory.sql
--
-- What it pins:
--   ON_ERROR_STOP on  — any SQL error aborts the file with a non-zero psql exit
--     status. Combined with the `INVENTORY_RESULT` line 01 prints as its LAST
--     statement this gives a reliable completion signal:
--       * printed `INVENTORY_RESULT … status=complete`    → complete
--       * printed `INVENTORY_RESULT … status=incomplete …` → incomplete, reason given
--       * printed NO `INVENTORY_RESULT` line at all        → incomplete (aborted:
--         syntax error, permission denied, statement timeout 57014, cancelled
--         query, dropped connection, Ctrl-C, truncated output pipe).
--       NEVER read a missing line, a missing result row, or an aborted run as
--       "zero dangling rows".
--   default_transaction_read_only on — a write that slips into 01 (now or in a
--     future edit) fails with SQLSTATE 25006 instead of running. Defence in
--     depth; 01 must still be run as a read-only role. This is ALSO why 02/03
--     do NOT include this file — they are writes and use _preamble-write.sql.
--   statement_timeout 120s / lock_timeout 5s /
--   idle_in_transaction_session_timeout 30s — one query can never pin a
--     production database. A timeout is an ERROR, so ON_ERROR_STOP turns it
--     into the "no INVENTORY_RESULT line" = incomplete case above.
--   search_path — pinned to the caller-supplied `schema` variable when given
--     (`psql … -v schema=public`), else left at the role default. Every probe
--     resolves tables through `current_schemas(false)`, i.e. exactly the
--     schemas the queries themselves resolve, so the probe cannot report a
--     table the queries would not see.
--   pager off — stable, non-interactive output. Pipe the run to a file
--     (`psql … -f 01-inventory.sql > run.log 2>&1`) to keep the evidence.
--
-- OUTPUT BUDGET: the HIT rows are unbounded by design (this pack exists to hand
-- the owner an id list). If TOTAL comes back in the thousands, stop and ask for
-- an explicit budget before pulling the full id list.
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
