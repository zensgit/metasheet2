-- ============================================================================
-- 03-validate.sql — VALIDATE the live_id FK, with a named outcome per SQLSTATE
-- ============================================================================
-- *** THIS FILE WRITES (it promotes a NOT VALID constraint to validated, taking
-- *** SHARE UPDATE EXCLUSIVE on integration_external_systems for the duration of
-- *** a full table scan). IT NEEDS OWNER AUTHORISATION — see README §授权点.
--
-- WHAT IT DOES. `ALTER TABLE … VALIDATE CONSTRAINT
-- fk_integration_external_systems_live_connection_id`. #5896 added that FK as
-- NOT VALID so a deploy could not be blocked by pre-existing dangling rows
-- (zzzz20260920120000_data_source_live_id_binding_lock.ts:96-113). VALIDATE is
-- the step that scans those existing rows and, on success, lets the constraint
-- be stated as a fact rather than a promise about future writes.
--
-- RUN 01 FIRST. VALIDATE is an all-or-nothing scan: with one dangling row left
-- it fails with 23503 and tells you nothing about how many there are. 01 is the
-- cheap read that sizes the problem; this file is the expensive write that
-- closes it.
--
-- LOCKS. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the referencing
-- table and ROW SHARE on `data_sources`. SHARE UPDATE EXCLUSIVE does NOT block
-- ordinary reads or writes, but it DOES queue behind (and then in front of)
-- DDL, VACUUM FULL and anything holding ACCESS EXCLUSIVE — and while it waits
-- in the lock queue it blocks the traffic behind it. `lock_timeout` is
-- therefore not optional here: without it a VALIDATE that cannot get its lock
-- becomes an outage. It is set explicitly below, after the preamble, so this
-- file owns the value that matters.
--
-- OUTCOME CLASSIFICATION. The VALIDATE runs inside a PL/pgSQL block that traps
-- exactly two SQLSTATEs and records a named outcome for each:
--   23503 foreign_key_violation → `status=failed reason=dangling-rows`. Rows
--         still point at a non-live `live_id`. Re-run 01, then 02 with APPLY=1.
--   55P03 lock_not_available    → `status=failed reason=lock-timeout`. Nothing
--         was changed; retry in a quieter window or raise -v lock_timeout.
-- NOT trapped, on purpose:
--   57014 query_canceled (statement_timeout, or an operator Ctrl-C) — that is
--         an ambiguous state, not a diagnosis, and it must not be dressed up as
--         one. It aborts the file and NO `VALIDATE_RESULT` line is printed.
--   anything else (42501 insufficient_privilege, 42704 undefined_object, …) —
--         same: abort, no RESULT line.
--   READ A MISSING `VALIDATE_RESULT` LINE AS "UNKNOWN, INVESTIGATE", NEVER AS
--   SUCCESS AND NEVER AS "NO DANGLING ROWS".
--
-- EXIT STATUS. The last statement re-raises when the recorded status is not
-- `complete`, so `psql -f 03-validate.sql` exits non-zero on 23503 and on
-- 55P03 as well as on an untrapped abort. The human-readable RESULT line is
-- printed BEFORE that, so a failing run still explains itself.
--
-- IDEMPOTENT. VALIDATE on an already-validated constraint is a no-op; the
-- RESULT line then carries `already_validated=yes`.
--
-- RUN WITH:
--   psql "$DATABASE_URL" -f 03-validate.sql
--   psql "$DATABASE_URL" -v lock_timeout=30s -f 03-validate.sql
-- ============================================================================

\ir _preamble-write.sql

-- This file owns its lock_timeout (see header). Overrides the preamble default
-- on purpose: removing this line is the mutation verify/run-verify.mjs uses to
-- show the 55P03 classification is real and not decoration.
\if :{?lock_timeout}
  SET lock_timeout = :'lock_timeout';
\else
  SET lock_timeout = '5s';
\endif

\echo '-- effective lock_timeout for the VALIDATE below:'
SHOW lock_timeout;

-- pg_temp-qualified on purpose: unqualified, this DROP would resolve through
-- search_path and could hit a REAL table of that name in the target schema.
DROP TABLE IF EXISTS pg_temp.h5_validate_result;
CREATE TEMP TABLE h5_validate_result (
  status        text NOT NULL,
  sqlstate_code text NOT NULL,
  detail        text NOT NULL
);

DO $$
DECLARE
  already boolean;
BEGIN
  SELECT convalidated INTO already
    FROM pg_constraint
   WHERE conname = 'fk_integration_external_systems_live_connection_id'
     AND conrelid = to_regclass('integration_external_systems');

  IF already IS NULL THEN
    INSERT INTO h5_validate_result
    VALUES ('failed', 'none',
            'constraint fk_integration_external_systems_live_connection_id not found; the #5896 migration has not run here');
    RETURN;
  END IF;

  IF already THEN
    INSERT INTO h5_validate_result
    VALUES ('complete', '00000', 'already_validated=yes (no-op)');
    RETURN;
  END IF;

  BEGIN
    ALTER TABLE integration_external_systems
      VALIDATE CONSTRAINT fk_integration_external_systems_live_connection_id;
    INSERT INTO h5_validate_result
    VALUES ('complete', '00000', 'already_validated=no validated_now=yes');
  EXCEPTION
    WHEN foreign_key_violation THEN
      INSERT INTO h5_validate_result
      VALUES ('failed', '23503',
              'reason=dangling-rows: rows still reference a non-live data_sources.live_id; re-run 01-inventory.sql then 02-remediate.sql -v APPLY=1');
    WHEN lock_not_available THEN
      INSERT INTO h5_validate_result
      VALUES ('failed', '55P03',
              'reason=lock-timeout: could not acquire SHARE UPDATE EXCLUSIVE within lock_timeout; nothing was changed, retry in a quieter window or raise -v lock_timeout');
  END;
END $$;

-- ── Human/machine-readable outcome (printed even when the run failed) ─────
SELECT 'VALIDATE_RESULT file=03-validate.sql status=' || status ||
       ' sqlstate=' || sqlstate_code ||
       ' detail=' || detail AS validate_result
  FROM h5_validate_result;

-- ── Exit status: anything but `complete` must fail the run ────────────────
DO $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM h5_validate_result;
  IF s IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'VALIDATE did not complete (status=%); see the VALIDATE_RESULT line above',
      COALESCE(s, 'missing');
  END IF;
END $$;
