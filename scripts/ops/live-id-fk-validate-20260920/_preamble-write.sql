-- ============================================================================
-- _preamble-write.sql — WRITE execution contract for 02-remediate / 03-validate
-- ============================================================================
-- INCLUDED BY 02-remediate.sql and 03-validate.sql via `\ir`. Never run alone.
--
-- WHY A SECOND PREAMBLE. _preamble.sql pins `default_transaction_read_only =
-- on`, which is the right default for an inventory and the WRONG one for the
-- two files that actually change rows / validate a constraint. Rather than
-- teach the operator "include this one but unset that GUC", the two contracts
-- are separate files, and the read-only guarantee of 01 stays unconditional.
--
-- WHAT THIS DOES NOT DO. It does not make 02/03 safe to run. 02 with APPLY=1
-- and 03 are PRODUCTION WRITES and require owner authorisation — see README.md
-- §"授权点". 02 without APPLY=1 is a dry run that always ends in ROLLBACK.
--
-- What it pins:
--   ON_ERROR_STOP on — any error aborts the file with a non-zero psql exit
--     status. Because 02 wraps everything in a single explicit transaction, an
--     abort leaves the database untouched: psql disconnects with the
--     transaction open and the server rolls it back.
--   statement_timeout 120s — a runaway UPDATE cannot pin production. NOTE: a
--     statement timeout is SQLSTATE 57014 `query_canceled`, which 03's
--     classifier deliberately does NOT catch (see 03's header) — it surfaces as
--     an abort with no RESULT line, which the README reads as "unknown, re-run".
--   lock_timeout 5s (override with `-v lock_timeout=…`) — neither file may sit
--     in a lock queue behind application traffic. 03 turns the resulting 55P03
--     into a named outcome instead of a stack trace.
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

SET statement_timeout = '120s';
SET idle_in_transaction_session_timeout = '30s';
