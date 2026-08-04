-- 075_grant_sealed_export_runtime_authority_row_lock.sql
-- S6-A activation unblock: the runtime role's authority-state ROW LOCK
-- (#4693 follow-up; the gap 074 deliberately left open).
--
-- 073 and 074 are already applied on main and 073 is a pinned input of the
-- frozen S6-A package, so neither may be amended in place. This migration adds
-- exactly one privilege; it creates no object and revokes nothing.
--
-- WHAT WAS BROKEN.
--   073:571-576 grants the runtime role only SELECT on
--   integration_sealed_export_authority_state. The final visibility-CAS
--   transaction in
--   plugins/plugin-integration-core/lib/sealed-export/generation-kernel.cjs:934
--   calls trx.readAuthorityStateForUpdate(authority), which reaches
--   generation-store.cjs:383 -> scopedDb.selectOneForUpdate(...) and
--   plugins/plugin-integration-core/lib/db.cjs:212 emits
--   `SELECT * FROM <table> WHERE ... LIMIT 1 FOR UPDATE`.
--   PostgreSQL requires UPDATE on AT LEAST ONE COLUMN, in addition to SELECT,
--   for a row-level locking clause, so the statement is refused with SQLSTATE
--   42501. generation-store.cjs:381-389 wraps that raw driver error in a bare
--   catch and converts it to SEALED_EXPORT_INTERNAL_ERROR, which the S6-A walk
--   surfaces as HTTP 503 after the run row has already reached
--   GENERATION_VERIFIED. Activation could therefore never succeed.
--
-- WHY THE PRODUCT IS NOT THE THING TO CHANGE.
--   docs/development/stock-prep-sealed-export-manifest-capability-spike-20260727.md
--   §6.1 (:297-301): "Before the final visibility CAS, the server repeats the
--   same local verification in the activation transaction; it performs no
--   external probe there. A revoked, superseded, expired, or mismatched
--   binding/qualification quarantines the unactivated generation."
--   §7 (:383-385): "The server verifies system binding, key state, expiry,
--   signature, and request nonce before accepting any chunk, before sealing,
--   and again in the final activation transaction."
--   The re-verification inside the activation transaction is mandated, and §7's
--   revocation semantics ("a revoked key cannot start, resume, seal, apply, or
--   activate") are only race-free if that read holds the authority row against
--   a concurrent revocation. The row lock is the mechanism; removing it would
--   narrow a ratified contract.
--
-- WHY A COLUMN-LEVEL UPDATE, AND WHY `updated_at`.
--   Exactly the 074 precedent (074:29-45), applied to the sibling table:
--   column-level UPDATE is the minimal privilege PostgreSQL accepts for
--   SELECT ... FOR UPDATE. `updated_at` is chosen because the BEFORE UPDATE
--   trigger installed by 069:605-614 (integration_set_updated_at, 057:182-188)
--   overwrites it unconditionally with NOW(), so no caller-supplied value can
--   ever be stored, and because generation-kernel.cjs's authorityReason()
--   (:259-285) reads signer_key_id, signer_status, signer_expires_at,
--   binding_current, binding_expires_at, qualification_current,
--   qualification_digest and qualification_expires_at -- never updated_at. No
--   authority-bearing column becomes writable, no row becomes insertable or
--   deletable.
--
--   Note that has_table_privilege(runtime_role, table, 'UPDATE') stays FALSE
--   for a column-level grant -- that is expected, not a missing grant, and the
--   ratified capability matrix in
--   packages/core-backend/tests/integration/
--   sealed-export-s6a-runtime-authority.db.test.ts (runtime_authority_update:
--   false) is unchanged by this migration.
--
--   A table-level UPDATE grant would instead make every authority-bearing
--   column writable at the privilege layer, leaving only the BEFORE UPDATE
--   guard trigger (072:90-179) -- a different control -- between the runtime
--   role and an authority rewrite. The privilege layer must refuse on its own.
--
--   A grant on the generated column workspace_scope_key would also satisfy
--   PostgreSQL's any-column check and is technically narrower still (a
--   generated column can never be assigned). It is deliberately NOT used: a
--   grant whose named column can never be written is an obscure construction,
--   it diverges from 074's ratified convention on the sibling table, and it
--   would silently stop granting the lock if the generated column were ever
--   dropped. The chosen grant is the minimum *among grants following 074's
--   convention*, not the minimum imaginable; see the PR body and
--   packages/core-backend/tests/integration/
--   sealed-export-s6a-authority-row-lock.db.test.ts for both arms measured.
--
-- WHAT THE RUNTIME ROLE STILL CANNOT DO (asserted, not argued, by
-- sealed-export-s6a-authority-row-lock.db.test.ts):
--   * UPDATE any authority-bearing column -- refused 42501 at the privilege
--     layer, proven with `WHERE false` so no trigger can mask the privilege
--     check;
--   * INSERT, DELETE or TRUNCATE authority state -- refused 42501;
--   * mutate a single authority row through the one column it may name: the
--     non-SECURITY-DEFINER guard trigger (072:90-179) runs as the caller and
--     touches integration_sealed_export_terminal_signer_keys, on which the
--     runtime role holds nothing, for every value signer_status may take
--     (ACTIVE reads it, EXPIRED/REVOKED insert into it), so
--     `UPDATE ... SET updated_at = NOW()` fails closed on every row state. The
--     same statement succeeds for the provisioning role -- the positive control
--     that separates "privilege refused" from "trigger broken for everyone".
--
-- Role names are deployment inputs, not repository constants, exactly as in 073
-- and 074. Supply both settings through PGOPTIONS when migrations run:
--
--   -c metasheet.sealed_export_runtime_role=<runtime role>
--   -c metasheet.sealed_export_provisioning_role=<provisioning role>
--
-- The validation preamble below is copied from 074 (itself copied from 073)
-- deliberately so all three migrations fail closed identically: with neither
-- setting the migration NOTICEs and returns (a fresh CI database stays
-- installable); supplying only one setting, a missing role, an unsafe role,
-- mutually inheriting roles, or the same role for both duties fails the
-- migration closed with ERRCODE 55000.

DO $$
DECLARE
  runtime_role TEXT := NULLIF(
    current_setting('metasheet.sealed_export_runtime_role', TRUE),
    ''
  );
  provisioning_role TEXT := NULLIF(
    current_setting('metasheet.sealed_export_provisioning_role', TRUE),
    ''
  );
  schema_name TEXT := current_schema();
  candidate TEXT;
  candidate_row RECORD;
BEGIN
  IF runtime_role IS NULL AND provisioning_role IS NULL THEN
    RAISE NOTICE
      'sealed-export roles are not configured; privilege grants remain latent';
    RETURN;
  END IF;
  IF runtime_role IS NULL OR provisioning_role IS NULL THEN
    RAISE EXCEPTION
      'sealed-export runtime and provisioning roles must be configured together'
      USING ERRCODE = '55000';
  END IF;
  IF runtime_role = provisioning_role THEN
    RAISE EXCEPTION
      'sealed-export runtime and provisioning roles must be distinct'
      USING ERRCODE = '55000';
  END IF;

  FOREACH candidate IN ARRAY ARRAY[runtime_role, provisioning_role]
  LOOP
    SELECT
      oid,
      rolname,
      rolsuper,
      rolcreatedb,
      rolcreaterole,
      rolreplication,
      rolbypassrls,
      rolcanlogin,
      rolinherit
    INTO candidate_row
    FROM pg_roles
    WHERE rolname = candidate;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'sealed-export role does not exist'
        USING ERRCODE = '55000';
    END IF;
    IF
      candidate_row.rolsuper
      OR candidate_row.rolcreatedb
      OR candidate_row.rolcreaterole
      OR candidate_row.rolreplication
      OR candidate_row.rolbypassrls
      OR NOT candidate_row.rolcanlogin
      OR candidate_row.rolinherit
      OR candidate = current_user
      OR pg_has_role(candidate, current_user, 'MEMBER')
      OR EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        WHERE
          membership.member = candidate_row.oid
          OR membership.roleid = candidate_row.oid
      )
    THEN
      RAISE EXCEPTION 'sealed-export role has unsafe authority'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF
    pg_has_role(runtime_role, provisioning_role, 'MEMBER')
    OR pg_has_role(provisioning_role, runtime_role, 'MEMBER')
  THEN
    RAISE EXCEPTION
      'sealed-export runtime and provisioning roles must not inherit each other'
      USING ERRCODE = '55000';
  END IF;

  -- Row-lock capability only, on the one table the activation transaction
  -- locks. Column-level UPDATE is the minimal privilege PostgreSQL accepts for
  -- SELECT ... FOR UPDATE; table-level UPDATE would additionally expose every
  -- authority-bearing column at the privilege layer.
  EXECUTE format(
    'GRANT UPDATE (%I) ON TABLE %I.%I TO %I',
    'updated_at',
    schema_name,
    'integration_sealed_export_authority_state',
    runtime_role
  );
END $$;
