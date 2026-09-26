-- ============================================================================
-- 03-validate.sql — VALIDATE the 073 live FK, with a named outcome per SQLSTATE
-- ============================================================================
-- *** THIS FILE WRITES (it promotes a NOT VALID constraint to validated, taking
-- *** SHARE UPDATE EXCLUSIVE on integration_sealed_export_stock_prep_bindings
-- *** for the duration of a full table scan). IT NEEDS OWNER AUTHORISATION —
-- *** see README §4 授权点.
--
-- WHAT IT DOES. `ALTER TABLE integration_sealed_export_stock_prep_bindings
-- VALIDATE CONSTRAINT fk_sealed_export_stock_prep_binding_live_external_system`.
-- Migration zzzz20260926140000 added that FK as NOT VALID so a deploy could not
-- be blocked by pre-existing dangling rows. VALIDATE is the step that scans
-- those rows and, on success, lets the constraint be stated as a fact.
--
-- RUN 01 FIRST. VALIDATE is all-or-nothing: with one dangling row left it
-- fails 23503 and says nothing about how many there are. 01 is the cheap read
-- that sizes the problem; this file is the write that closes it.
--
-- LOCKS. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the referencing
-- table (the 073 bindings) and ROW SHARE on integration_external_systems. SHARE
-- UPDATE EXCLUSIVE does NOT block ordinary reads or writes, but while it waits
-- in the lock queue it blocks the traffic behind it, so `lock_timeout` is set
-- explicitly below, after the preamble.
--
-- OUTCOME CLASSIFICATION. Exactly two SQLSTATEs are trapped:
--   23503 foreign_key_violation → `status=failed reason=dangling-rows`. An
--         ACTIVE binding still names an absent system. Re-run 01, then 02
--         with APPLY=1 (owner).
--   55P03 lock_not_available    → `status=failed reason=lock-timeout`. Nothing
--         was changed; retry in a quieter window or raise -v lock_timeout.
-- NOT trapped, on purpose: 57014 query_canceled (statement_timeout / Ctrl-C)
-- and everything else (42501, 42704, …). They abort the file and NO
-- `VALIDATE_RESULT` line is printed. READ A MISSING `VALIDATE_RESULT` LINE AS
-- "UNKNOWN, INVESTIGATE", NEVER AS SUCCESS.
--
-- EXIT STATUS. The last statement re-raises when the recorded status is not
-- `complete`, so `psql -f 03-validate.sql` exits non-zero on 23503 and 55P03
-- as well as on an untrapped abort. The RESULT line is printed BEFORE that.
--
-- IDEMPOTENT. VALIDATE on an already-validated constraint is a no-op; the
-- RESULT line then carries `already_validated=yes`.
--
-- VALUES-FREE. The RESULT line carries a status, a SQLSTATE and a fixed text —
-- never the server's error detail (which would name the offending key).
--
-- RUN WITH:
--   psql "$DATABASE_URL" -f 03-validate.sql
--   psql "$DATABASE_URL" -v lock_timeout=30s -f 03-validate.sql
-- ============================================================================

\ir _preamble-write.sql

-- This file owns its lock_timeout (see header). Removing the effective timeout
-- is the mutation verify/run-verify.mjs uses to show 55P03 is really classified.
\if :{?lock_timeout}
  SET lock_timeout = :'lock_timeout';
\else
  SET lock_timeout = '5s';
\endif

\echo '-- effective lock_timeout for the VALIDATE below:'
SHOW lock_timeout;

-- pg_temp-qualified on purpose: unqualified, this DROP would resolve through
-- search_path and could hit a REAL table of that name in the target schema.
DROP TABLE IF EXISTS pg_temp.s073_validate_result;
CREATE TEMP TABLE s073_validate_result (
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
   WHERE conname = 'fk_sealed_export_stock_prep_binding_live_external_system'
     AND conrelid = to_regclass('integration_sealed_export_stock_prep_bindings');

  IF already IS NULL THEN
    INSERT INTO s073_validate_result
    VALUES ('failed', 'none',
            'constraint fk_sealed_export_stock_prep_binding_live_external_system not found; migration zzzz20260926140000 has not run here');
    RETURN;
  END IF;

  IF already THEN
    INSERT INTO s073_validate_result
    VALUES ('complete', '00000', 'already_validated=yes (no-op)');
    RETURN;
  END IF;

  BEGIN
    ALTER TABLE integration_sealed_export_stock_prep_bindings
      VALIDATE CONSTRAINT fk_sealed_export_stock_prep_binding_live_external_system;
    INSERT INTO s073_validate_result
    VALUES ('complete', '00000', 'already_validated=no validated_now=yes');
  EXCEPTION
    WHEN foreign_key_violation THEN
      INSERT INTO s073_validate_result
      VALUES ('failed', '23503',
              'reason=dangling-rows: an ACTIVE binding still names an absent external system; re-run 01-inventory.sql then 02-remediate.sql -v APPLY=1');
    WHEN lock_not_available THEN
      INSERT INTO s073_validate_result
      VALUES ('failed', '55P03',
              'reason=lock-timeout: could not acquire SHARE UPDATE EXCLUSIVE within lock_timeout; nothing was changed, retry in a quieter window or raise -v lock_timeout');
  END;
END $$;

-- ── Human/machine-readable outcome (printed even when the run failed) ─────
SELECT 'VALIDATE_RESULT file=03-validate.sql status=' || status ||
       ' sqlstate=' || sqlstate_code ||
       ' detail=' || detail AS validate_result
  FROM s073_validate_result;

-- ── Exit status: anything but `complete` must fail the run ────────────────
DO $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM s073_validate_result;
  IF s IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'VALIDATE did not complete (status=%); see the VALIDATE_RESULT line above',
      COALESCE(s, 'missing');
  END IF;
END $$;
