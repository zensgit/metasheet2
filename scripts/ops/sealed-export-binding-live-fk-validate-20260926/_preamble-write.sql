-- ============================================================================
-- _preamble-write.sql — WRITE execution contract for 02-remediate / 03-validate
-- ============================================================================
-- INCLUDED BY 02-remediate.sql and 03-validate.sql via `\ir`. Never run alone.
--
-- WHY A SECOND PREAMBLE. _preamble.sql pins `default_transaction_read_only =
-- on`, which is the right default for an inventory and the WRONG one for the
-- two files that change a row / validate a constraint. The two contracts are
-- separate files so the read-only guarantee of 01 stays unconditional.
--
-- WHAT THIS DOES NOT DO. It does not make 02/03 safe to run. 02 with APPLY=1
-- and 03 are PRODUCTION WRITES and require owner authorisation — see README.md
-- §4 授权点. 02 without APPLY=1 is a dry run that always ends in ROLLBACK.
--
-- What it pins:
--   ON_ERROR_STOP on — any error aborts the file with a non-zero psql exit
--     status. Because 02 wraps everything in a single explicit transaction, an
--     abort leaves the database untouched: psql disconnects with the
--     transaction open and the server rolls it back.
--   statement_timeout 120s (override with `-v statement_timeout=…`). A
--     statement timeout is SQLSTATE 57014, which 03 deliberately does NOT
--     classify — it surfaces as an abort with no RESULT line ("unknown").
--   lock_timeout 5s (override with `-v lock_timeout=…`) — neither file may sit
--     in a lock queue behind application traffic.
--   idle_in_transaction_session_timeout 30s — an operator who walks away
--     mid-dry-run cannot hold the transaction open indefinitely.
--   search_path — pinned only when the caller passed -v schema=… .
--   pager off — non-interactive output; pipe the run to a log file.
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off
\timing off

\if :{?schema}
  SET search_path = :"schema";
\endif

\if :{?lock_timeout}
  SET lock_timeout = :'lock_timeout';
\else
  SET lock_timeout = '5s';
\endif

\if :{?statement_timeout}
  SET statement_timeout = :'statement_timeout';
\else
  SET statement_timeout = '120s';
\endif
SET idle_in_transaction_session_timeout = '30s';
