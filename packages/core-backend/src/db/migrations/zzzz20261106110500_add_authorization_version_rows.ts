import { sql, type Kysely } from 'kysely'

/**
 * D21 authorization version protocol — the database half (slice Y5a, design baseline v2.3 §7.2
 * 「分界是准入提交」, three protection layers plus the hard condition).
 *
 * WHY. A YiDa admission transaction (slice Y5) re-runs the four source checks INSIDE its own
 * transaction and must be serialized against every REVOCATION that could land between the check and
 * the commit. Positive grants are already covered by the live-authority `FOR SHARE` order
 * (`src/integration/automation-live-authority.ts:58-59`). Revocations that are INSERTS (a new deny
 * row, joining a member group that carries a deny row, a field turned hidden) cannot be row-locked in
 * advance, so the baseline adds two version rows and one rule: the WRITER takes the version row's
 * write lock FIRST, the admission holds it `FOR SHARE` until commit.
 *
 * WHY TRIGGERS (coordinator decision 2026-11-06, T-level default-forward, owner may veto). The
 * takeover deep read found writers that no TypeScript helper can reach — four autocommit routes,
 * raw-SQL ops scripts, data migrations, FK cascades and every plugin's raw `database.query` handle —
 * so the rule is enforced HERE, by BEFORE ROW triggers that upsert-and-bump the version row inside
 * the writer's own transaction (an autocommit statement is one implicit transaction, so the bump
 * and the write still commit together). TypeScript writers ADDITIONALLY call the explicit bump
 * helpers (`src/multitable/authz-version-protocol.ts`) as their first statement in canonical order,
 * which fixes the lock ORDER; the triggers are the completeness safety net.
 *
 * Layer 1 — per-sheet permission version (`sheet_permission_versions`, key = sheet id):
 *   - `spreadsheet_permissions`, `field_permissions`, `record_permissions`: every INSERT / UPDATE /
 *     DELETE (grants, deny rows, de-escalation, copy-sheet, migrations, cascades);
 *   - `meta_sheets`: UPDATE (whole-row trigger; the function bumps ONLY when one of the check-2 /
 *     check-4 configuration columns `row_level_read_permissions_enabled`, `conditional_read_rules`,
 *     `grid_export_closure`, `deleted_at`, `system_kind` actually changes), and DELETE;
 *   - `meta_fields`: UPDATE (whole-row trigger; the function bumps ONLY when the `hidden === true` /
 *     `visible === false` visibility derivation of `property` — `permission-derivation.ts
 *     isFieldPermissionHidden` — changes; ordinary property edits (options, formats, rules) and
 *     renames never bump).
 *   NOT `meta_records` (the admission locks its ONE bound record `FOR SHARE`; ordinary record writes
 *   must never contend on a table-wide version). NOT `meta_view_permissions` / `meta_views` (not
 *   inputs of the four checks: the host passes `hiddenFieldIds: []`).
 *
 * Layer 2 — per-subject authorization version (`subject_authorization_versions`, key = user id):
 *   - `user_roles`, `platform_member_group_members`, `user_permissions`, `user_orgs`,
 *     `user_namespace_admissions`: every INSERT / UPDATE / DELETE, keyed by the row's `user_id`;
 *   - `users`: INSERT / DELETE, and UPDATE (whole-row trigger; the function bumps ONLY when `role`,
 *     `is_active`, `activation_status`, `permissions` or `is_admin` actually changes — the recovery
 *     precedent omitted `activation_status`, which live authority reads; a `last_login_at` touch
 *     enters the function and returns without writing).
 *   NOT `role_permissions`: positive rows are `FOR SHARE`-locked by the live-authority order and deny
 *   rows are sheet-scoped, so a role-scoped version (fan-out to every member) is not needed.
 *   NOT `users.access_generation`: that is the session-revocation generation, a different meaning.
 *
 * Coexistence. The recovery-authority triggers (`zzzz20260721121000`, installed DISABLED) live on the
 * same tables. Same-event BEFORE ROW triggers fire in name order, and every name here sorts AFTER its
 * `trg_<table>_recovery_authority_lock` sibling, so a `40001 METASHEET_RECOVERY_AUTHORITY_BUSY`
 * refusal fails fast without first waiting on a held version row. The recovery posture check
 * (`src/multitable/recovery-authorization-stability.ts`) and the L1 battery match triggers by NAME
 * and function, so these additional triggers do not disturb them.
 *
 * Hardening follows `zzzz20260821120000`: fixed `SET search_path = pg_catalog, public` on both
 * functions and schema-qualified table references, so a role-named schema cannot shadow the version
 * tables. The triggers are installed ENABLED (ordinary `O` posture, not `ALWAYS`): a restore under
 * `session_replication_role = replica` must stay trigger-free, and that window is registered as a
 * bypass class in the protocol module's hard-condition registry.
 *
 * NO `UPDATE OF <column>` LIST AND NO `WHEN` CLAUSE on the column-sensitive triggers, deliberately:
 * both record a pg_depend dependency on the named columns, and `ALTER TABLE … DROP COLUMN` then
 * fails with "other objects depend on it" — which is exactly what the `down()` of the earlier
 * migrations that added `system_kind`, `grid_export_closure`, `activation_status`, … does (the Time
 * Machine migration replay in CI downs `zzzz20260715180000` and would be blocked). The column list
 * is passed to the function as TEXT (TG_ARGV[1]) and compared through `to_jsonb(OLD/NEW) -> column`,
 * which holds no dependency: a column that a down() removed compares NULL = NULL and simply stops
 * contributing. The semantics are the same as a WHEN clause (bump only when a watched value changes).
 *
 * Perf statement: ordinary record writes are untouched (no trigger on `meta_records`); a permission
 * or membership write pays one additional single-row upsert on a small table; an UPDATE of `users`,
 * `meta_sheets` or `meta_fields` that touches no authority column pays one in-function jsonb
 * comparison of the watched columns and writes nothing.
 *
 * EVERY STATEMENT IS ONE COMPLETE LITERAL (authorization-input serialization compatibility, owner
 * ruling 2026-11-16 「按建议，A」). No table, trigger, function or column name is substituted, built
 * or looped over, and nothing runs through `EXECUTE`: the AIS migration judge
 * (`tests/helpers/authorization-input-migration-judge.ts`) sees each statement as written and names
 * exactly the five that touch an authorization-input table — the CREATE TRIGGER and the tolerant
 * DROP TRIGGER of `trg_user_roles_zz_authz_subject_version`, `trg_user_permissions_zz_authz_subject_version`,
 * `trg_user_namespace_admissions_zz_authz_subject_version`, `trg_users_zz_authz_subject_version_update`
 * and `trg_users_zz_authz_subject_version_lifecycle`. The posture metadata (the trigger list, the
 * watched-column lists, the version-table names) is production data of the protocol module
 * (`src/multitable/authz-version-protocol.ts`); this migration does not read it, and the protocol
 * unit test pins it equal to the literal statements below.
 *
 * up() is idempotent (CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS
 * before CREATE TRIGGER). down() removes the triggers, the functions and the two tables.
 */

/**
 * Every column a trigger function reads must exist before the triggers rely on it (the function
 * compares `to_jsonb(OLD/NEW) -> column`, where an absent column would silently compare NULL = NULL).
 * One read of the catalog in the current schema — the schema the helper `checkColumnExists` reads —
 * reporting every missing `table.column` in declaration order.
 */
async function assertWatchedColumns(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ missing: string }>`
    SELECT w.table_name || '.' || w.column_name AS missing
      FROM (VALUES
        (1, 'users', 'role'),
        (2, 'users', 'is_active'),
        (3, 'users', 'activation_status'),
        (4, 'users', 'permissions'),
        (5, 'users', 'is_admin'),
        (6, 'meta_sheets', 'row_level_read_permissions_enabled'),
        (7, 'meta_sheets', 'conditional_read_rules'),
        (8, 'meta_sheets', 'grid_export_closure'),
        (9, 'meta_sheets', 'deleted_at'),
        (10, 'meta_sheets', 'system_kind'),
        (11, 'meta_fields', 'property')
      ) AS w(ord, table_name, column_name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM information_schema.columns c
        WHERE c.table_schema = current_schema()
          AND c.table_name = w.table_name
          AND c.column_name = w.column_name
     )
     ORDER BY w.ord
  `.execute(db)
  if (rows.length > 0) {
    throw new Error(
      `authorization version protocol requires ${rows.map((row) => row.missing).join(', ')}; apply the migration that adds it before zzzz20261106110500`,
    )
  }
}

async function createVersionTables(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.sheet_permission_versions (
      sheet_id text PRIMARY KEY,
      version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`
    CREATE TABLE IF NOT EXISTS public.subject_authorization_versions (
      subject_id text PRIMARY KEY,
      version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
}

/*
 * One bump function per layer, written out in full (the two bodies differ only in the version table
 * and its key column). TG_ARGV[0] names the row's key column; the key is read through
 * `to_jsonb(row) ->> column` so the same function serves text and varchar keys. Both the NEW and the
 * OLD key are bumped (a key rewrite revokes on the old side and grants on the new side), in sorted
 * order. A NULL / blank key cannot occur on the covered tables (NOT NULL keys) and is skipped rather
 * than raised, mirroring the recovery-authority trigger. Neither function writes or locks anything
 * but its own version table.
 *
 * Optional TG_ARGV[1] narrows an UPDATE trigger (see the docblock on why this is not a WHEN clause):
 *   - `'field-visibility'`: bump only when the `property.hidden === true` / `property.visible === false`
 *     derivation changes (`permission-derivation.ts isFieldPermissionHidden`);
 *   - otherwise a comma-separated list of watched columns: bump only when one of them changes
 *     (`to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col`; a column absent from the row
 *     compares NULL = NULL).
 */
async function createSheetBumpFunction(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_authz_bump_sheet_permission_version()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      key_value text;
      old_row jsonb;
      new_row jsonb;
      watched text;
      watched_column text;
      changed boolean;
    BEGIN
      IF TG_OP = 'UPDATE' AND TG_NARGS >= 2 THEN
        old_row := to_jsonb(OLD);
        new_row := to_jsonb(NEW);
        watched := TG_ARGV[1];
        changed := FALSE;
        IF watched = 'field-visibility' THEN
          changed := COALESCE((old_row -> 'property' -> 'hidden') = 'true'::jsonb, FALSE)
              IS DISTINCT FROM COALESCE((new_row -> 'property' -> 'hidden') = 'true'::jsonb, FALSE)
            OR COALESCE((old_row -> 'property' -> 'visible') = 'false'::jsonb, FALSE)
              IS DISTINCT FROM COALESCE((new_row -> 'property' -> 'visible') = 'false'::jsonb, FALSE);
        ELSE
          FOREACH watched_column IN ARRAY string_to_array(watched, ',') LOOP
            IF (old_row -> btrim(watched_column)) IS DISTINCT FROM (new_row -> btrim(watched_column)) THEN
              changed := TRUE;
              EXIT;
            END IF;
          END LOOP;
        END IF;
        IF NOT changed THEN
          RETURN NEW;
        END IF;
      END IF;
      FOR key_value IN
        SELECT DISTINCT btrim(candidate)
          FROM unnest(ARRAY[
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ->> TG_ARGV[0] END,
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ->> TG_ARGV[0] END
          ]) AS candidates(candidate)
         WHERE candidate IS NOT NULL AND btrim(candidate) <> ''
         ORDER BY 1
      LOOP
        INSERT INTO public.sheet_permission_versions AS v (sheet_id, version, updated_at)
        VALUES (key_value, 1, now())
        ON CONFLICT (sheet_id) DO UPDATE
          SET version = v.version + 1,
              updated_at = now();
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)
}

async function createSubjectBumpFunction(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_authz_bump_subject_authorization_version()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      key_value text;
      old_row jsonb;
      new_row jsonb;
      watched text;
      watched_column text;
      changed boolean;
    BEGIN
      IF TG_OP = 'UPDATE' AND TG_NARGS >= 2 THEN
        old_row := to_jsonb(OLD);
        new_row := to_jsonb(NEW);
        watched := TG_ARGV[1];
        changed := FALSE;
        IF watched = 'field-visibility' THEN
          changed := COALESCE((old_row -> 'property' -> 'hidden') = 'true'::jsonb, FALSE)
              IS DISTINCT FROM COALESCE((new_row -> 'property' -> 'hidden') = 'true'::jsonb, FALSE)
            OR COALESCE((old_row -> 'property' -> 'visible') = 'false'::jsonb, FALSE)
              IS DISTINCT FROM COALESCE((new_row -> 'property' -> 'visible') = 'false'::jsonb, FALSE);
        ELSE
          FOREACH watched_column IN ARRAY string_to_array(watched, ',') LOOP
            IF (old_row -> btrim(watched_column)) IS DISTINCT FROM (new_row -> btrim(watched_column)) THEN
              changed := TRUE;
              EXIT;
            END IF;
          END LOOP;
        END IF;
        IF NOT changed THEN
          RETURN NEW;
        END IF;
      END IF;
      FOR key_value IN
        SELECT DISTINCT btrim(candidate)
          FROM unnest(ARRAY[
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ->> TG_ARGV[0] END,
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ->> TG_ARGV[0] END
          ]) AS candidates(candidate)
         WHERE candidate IS NOT NULL AND btrim(candidate) <> ''
         ORDER BY 1
      LOOP
        INSERT INTO public.subject_authorization_versions AS v (subject_id, version, updated_at)
        VALUES (key_value, 1, now())
        ON CONFLICT (subject_id) DO UPDATE
          SET version = v.version + 1,
              updated_at = now();
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)
}

/**
 * Drops the thirteen triggers, each in its own block that tolerates a table an earlier migration's
 * down() already removed (`DROP TRIGGER … ON <missing table>` errors even with IF EXISTS). Every
 * DROP TRIGGER is a static statement of the block — no `EXECUTE` — so the judge reads it as written.
 */
export async function dropAuthorizationVersionTriggers(db: Kysely<unknown>): Promise<void> {
  // Layer 1 — sheet permission versions.
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.spreadsheet_permissions') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_spreadsheet_permissions_zz_authz_sheet_version ON public.spreadsheet_permissions;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.field_permissions') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_field_permissions_zz_authz_sheet_version ON public.field_permissions;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.record_permissions') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_record_permissions_zz_authz_sheet_version ON public.record_permissions;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.meta_sheets') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_sheets_zz_authz_sheet_version_update ON public.meta_sheets;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.meta_sheets') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_sheets_zz_authz_sheet_version_delete ON public.meta_sheets;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.meta_fields') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_fields_zz_authz_sheet_version_visibility ON public.meta_fields;
      END IF;
    END $$
  `.execute(db)
  // Layer 2 — subject authorization versions. Three of these tables and `users` are
  // authorization-input tables: their DROP TRIGGER statements are the ones the AIS judge names.
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.user_roles') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_user_roles_zz_authz_subject_version ON public.user_roles;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.platform_member_group_members') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_platform_member_group_members_zz_authz_subject_version ON public.platform_member_group_members;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.user_permissions') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_user_permissions_zz_authz_subject_version ON public.user_permissions;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.user_orgs') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_user_orgs_zz_authz_subject_version ON public.user_orgs;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.user_namespace_admissions') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_user_namespace_admissions_zz_authz_subject_version ON public.user_namespace_admissions;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.users') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_users_zz_authz_subject_version_update ON public.users;
      END IF;
    END $$
  `.execute(db)
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.users') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_users_zz_authz_subject_version_lifecycle ON public.users;
      END IF;
    END $$
  `.execute(db)
}

/** The thirteen triggers, in protocol order (the same order as the drops above). */
async function createAuthorizationVersionTriggers(db: Kysely<unknown>): Promise<void> {
  // Layer 1 — sheet permission versions.
  await sql`
    CREATE TRIGGER trg_spreadsheet_permissions_zz_authz_sheet_version
      BEFORE INSERT OR UPDATE OR DELETE ON public.spreadsheet_permissions
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_sheet_permission_version('sheet_id')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_field_permissions_zz_authz_sheet_version
      BEFORE INSERT OR UPDATE OR DELETE ON public.field_permissions
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_sheet_permission_version('sheet_id')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_record_permissions_zz_authz_sheet_version
      BEFORE INSERT OR UPDATE OR DELETE ON public.record_permissions
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_sheet_permission_version('sheet_id')
  `.execute(db)
  // Watched columns travel as TEXT (no pg_depend edge on the columns — see the docblock).
  await sql`
    CREATE TRIGGER trg_meta_sheets_zz_authz_sheet_version_update
      BEFORE UPDATE ON public.meta_sheets
      FOR EACH ROW
      EXECUTE FUNCTION public.metasheet_authz_bump_sheet_permission_version('id', 'row_level_read_permissions_enabled,conditional_read_rules,grid_export_closure,deleted_at,system_kind')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_sheets_zz_authz_sheet_version_delete
      BEFORE DELETE ON public.meta_sheets
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_sheet_permission_version('id')
  `.execute(db)
  // Exactly the derivation of permission-derivation.ts isFieldPermissionHidden: hidden === true or
  // visible === false (computed inside the function). Adding `hidden: false` or editing options /
  // formats / names does not bump.
  await sql`
    CREATE TRIGGER trg_meta_fields_zz_authz_sheet_version_visibility
      BEFORE UPDATE ON public.meta_fields
      FOR EACH ROW
      EXECUTE FUNCTION public.metasheet_authz_bump_sheet_permission_version('sheet_id', 'field-visibility')
  `.execute(db)
  // Layer 2 — subject authorization versions. The statements on `user_roles`,
  // `user_permissions`, `user_namespace_admissions` and `users` (twice) are the five triggers on
  // authorization-input tables; their function writes only `subject_authorization_versions`.
  await sql`
    CREATE TRIGGER trg_user_roles_zz_authz_subject_version
      BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('user_id')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_platform_member_group_members_zz_authz_subject_version
      BEFORE INSERT OR UPDATE OR DELETE ON public.platform_member_group_members
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('user_id')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_user_permissions_zz_authz_subject_version
      BEFORE INSERT OR UPDATE OR DELETE ON public.user_permissions
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('user_id')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_user_orgs_zz_authz_subject_version
      BEFORE INSERT OR UPDATE OR DELETE ON public.user_orgs
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('user_id')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_user_namespace_admissions_zz_authz_subject_version
      BEFORE INSERT OR UPDATE OR DELETE ON public.user_namespace_admissions
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('user_id')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_users_zz_authz_subject_version_update
      BEFORE UPDATE ON public.users
      FOR EACH ROW
      EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('id', 'role,is_active,activation_status,permissions,is_admin')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_users_zz_authz_subject_version_lifecycle
      BEFORE INSERT OR DELETE ON public.users
      FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('id')
  `.execute(db)
}

export async function installAuthorizationVersionProtocol(db: Kysely<unknown>): Promise<void> {
  await assertWatchedColumns(db)

  await createVersionTables(db)
  await createSheetBumpFunction(db)
  await createSubjectBumpFunction(db)

  await dropAuthorizationVersionTriggers(db)
  await createAuthorizationVersionTriggers(db)
}

export async function dropAuthorizationVersionProtocol(db: Kysely<unknown>): Promise<void> {
  await dropAuthorizationVersionTriggers(db)
  await sql`DROP FUNCTION IF EXISTS public.metasheet_authz_bump_sheet_permission_version()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.metasheet_authz_bump_subject_authorization_version()`.execute(db)
  await sql`DROP TABLE IF EXISTS public.sheet_permission_versions`.execute(db)
  await sql`DROP TABLE IF EXISTS public.subject_authorization_versions`.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await installAuthorizationVersionProtocol(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropAuthorizationVersionProtocol(db)
}
