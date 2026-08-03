-- 074_repair_sealed_export_runtime_authority_privileges.sql
-- S6-A privilege repair for migration 073 (#4693 follow-up).
--
-- 073 is already applied on main and is a pinned input of the frozen S6-A
-- package, so it MUST NOT be amended in place. This migration adds only the
-- privileges 073 omitted; it creates no object and revokes nothing.
--
-- Gap 1 — provisioning role cannot lock signer public-key rows.
--   073:619-624 grants SELECT, INSERT on
--   integration_sealed_export_signer_public_keys to the provisioning role, but
--   plugins/plugin-integration-core/lib/sealed-export/
--   sealed-export-lifecycle-provisioning.cjs:505
--   (provisionInitialStockPreparationBinding) reads that row with
--   trx.selectOneForUpdate(PUBLIC_KEY_TABLE, ...), and
--   plugins/plugin-integration-core/lib/db.cjs:212 emits
--   `SELECT * FROM <table> WHERE ... LIMIT 1 FOR UPDATE`.
--   PostgreSQL requires UPDATE on AT LEAST ONE COLUMN, in addition to SELECT,
--   for row-level locking clauses. The minimal grant is therefore a
--   column-level UPDATE, not table-level UPDATE. `updated_at` is chosen because
--   the BEFORE UPDATE trigger installed by
--   070_create_integration_sealed_export_signer_authority.sql:62-65
--   (integration_set_updated_at, 057:182-188) overwrites it unconditionally
--   with NOW(), so the only capability added is "acquire the row lock": no
--   column carrying key material becomes writable, and no row becomes
--   deletable. Note that has_table_privilege(role, table, 'UPDATE') stays FALSE
--   for a column-level grant — that is expected, not a missing grant.
--
-- Gap 2 — runtime role cannot read back its own audit insert.
--   073:583-588 grants INSERT only on
--   integration_sealed_export_generation_audit to the runtime role, but every
--   write helper in db.cjs appends RETURNING (insertOne db.cjs:231, insertMany
--   db.cjs:261, updateRow db.cjs:281, deleteRows db.cjs:291), and
--   generation-store.cjs:318/364/436/518 consume the returned row
--   (`if (inserted === null) return null`). PostgreSQL requires SELECT on every
--   column named in RETURNING; `RETURNING *` names all of them, so table-level
--   SELECT is the minimal grant. Audit rows stay append-only: the UPDATE/DELETE
--   guard trigger from 069:582 is untouched and no UPDATE/DELETE privilege is
--   granted here.
--
-- Deliberately NOT repaired here (see the PR body): the runtime role holds only
-- SELECT on integration_sealed_export_authority_state (073:571-576) while
-- generation-kernel.cjs:934 locks that row via generation-store.cjs:383 on the
-- activation path (stock-preparation-runtime-core.cjs:470/480). Granting that
-- lock would invert a ratified assertion —
-- packages/core-backend/tests/integration/
-- sealed-export-s6a-runtime-authority.db.test.ts:497-503 asserts the refusal —
-- so it is an owner contract decision, not an omission this migration may fix.
--
-- Role names are deployment inputs, not repository constants, exactly as in
-- 073. Supply both settings through PGOPTIONS when migrations run:
--
--   -c metasheet.sealed_export_runtime_role=<runtime role>
--   -c metasheet.sealed_export_provisioning_role=<provisioning role>
--
-- The validation preamble below is copied from 073 deliberately so both
-- migrations fail closed identically: with neither setting the migration
-- NOTICEs and returns (a fresh CI database stays installable); supplying only
-- one setting, a missing role, an unsafe role, mutually inheriting roles, or
-- the same role for both duties fails the migration closed with ERRCODE 55000.

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

  -- Gap 1: row-lock capability only. Column-level UPDATE is the minimal
  -- privilege PostgreSQL accepts for SELECT ... FOR UPDATE; table-level UPDATE
  -- would additionally expose the public-key material columns.
  EXECUTE format(
    'GRANT UPDATE (%I) ON TABLE %I.%I TO %I',
    'updated_at',
    schema_name,
    'integration_sealed_export_signer_public_keys',
    provisioning_role
  );

  -- Gap 2: read-back of the runtime's own INSERT ... RETURNING on the audit
  -- ledger. No UPDATE/DELETE is granted, so audit rows stay append-only.
  EXECUTE format(
    'GRANT SELECT ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_generation_audit',
    runtime_role
  );
END $$;
