import { sql, type Kysely } from 'kysely'
import { checkColumnExists } from './_patterns'

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
 * up() is idempotent (CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS
 * before CREATE TRIGGER). down() removes the triggers, the functions and the two tables.
 */

export const SHEET_PERMISSION_VERSIONS_TABLE = 'sheet_permission_versions'
export const SUBJECT_AUTHORIZATION_VERSIONS_TABLE = 'subject_authorization_versions'
export const AUTHZ_SHEET_VERSION_BUMP_FUNCTION = 'metasheet_authz_bump_sheet_permission_version'
export const AUTHZ_SUBJECT_VERSION_BUMP_FUNCTION = 'metasheet_authz_bump_subject_authorization_version'

/** `users` columns whose change is a subject authority change (live authority reads all of them). */
export const USERS_AUTHORITY_COLUMNS = ['role', 'is_active', 'activation_status', 'permissions', 'is_admin'] as const
/** `meta_sheets` columns that are inputs of check 2 (liveness, People bound, export stamp) and check 4 (row-level deny config). */
export const META_SHEETS_AUTHORITY_COLUMNS = [
  'row_level_read_permissions_enabled',
  'conditional_read_rules',
  'grid_export_closure',
  'deleted_at',
  'system_kind',
] as const

export type AuthorizationVersionLayer = 'sheet' | 'subject'

export type AuthorizationVersionTrigger = {
  readonly table: string
  readonly trigger: string
  readonly fn: string
  readonly layer: AuthorizationVersionLayer
  /** The row column the bump is keyed by (passed as TG_ARGV[0]). */
  readonly keyColumn: string
  readonly events: string
}

const SHEET_ROW_TABLES = ['spreadsheet_permissions', 'field_permissions', 'record_permissions'] as const
const SUBJECT_ROW_TABLES = [
  'user_roles',
  'platform_member_group_members',
  'user_permissions',
  'user_orgs',
  'user_namespace_admissions',
] as const

/**
 * The complete trigger set. The protocol module's posture check verifies every row (table, trigger,
 * function, enabled) before an admission may rely on the protocol; a missing or disabled trigger is a
 * hard-condition failure (fail closed).
 */
export const AUTHORIZATION_VERSION_TRIGGERS: readonly AuthorizationVersionTrigger[] = Object.freeze([
  ...SHEET_ROW_TABLES.map((table) => Object.freeze({
    table,
    trigger: `trg_${table}_zz_authz_sheet_version`,
    fn: AUTHZ_SHEET_VERSION_BUMP_FUNCTION,
    layer: 'sheet' as const,
    keyColumn: 'sheet_id',
    events: 'BEFORE INSERT OR UPDATE OR DELETE',
  })),
  Object.freeze({
    table: 'meta_sheets',
    trigger: 'trg_meta_sheets_zz_authz_sheet_version_update',
    fn: AUTHZ_SHEET_VERSION_BUMP_FUNCTION,
    layer: 'sheet' as const,
    keyColumn: 'id',
    events: `BEFORE UPDATE (bump when any of ${META_SHEETS_AUTHORITY_COLUMNS.join(', ')} changes)`,
  }),
  Object.freeze({
    table: 'meta_sheets',
    trigger: 'trg_meta_sheets_zz_authz_sheet_version_delete',
    fn: AUTHZ_SHEET_VERSION_BUMP_FUNCTION,
    layer: 'sheet' as const,
    keyColumn: 'id',
    events: 'BEFORE DELETE',
  }),
  Object.freeze({
    table: 'meta_fields',
    trigger: 'trg_meta_fields_zz_authz_sheet_version_visibility',
    fn: AUTHZ_SHEET_VERSION_BUMP_FUNCTION,
    layer: 'sheet' as const,
    keyColumn: 'sheet_id',
    events: 'BEFORE UPDATE (bump when the hidden/visible derivation of property changes)',
  }),
  ...SUBJECT_ROW_TABLES.map((table) => Object.freeze({
    table,
    trigger: `trg_${table}_zz_authz_subject_version`,
    fn: AUTHZ_SUBJECT_VERSION_BUMP_FUNCTION,
    layer: 'subject' as const,
    keyColumn: 'user_id',
    events: 'BEFORE INSERT OR UPDATE OR DELETE',
  })),
  Object.freeze({
    table: 'users',
    trigger: 'trg_users_zz_authz_subject_version_update',
    fn: AUTHZ_SUBJECT_VERSION_BUMP_FUNCTION,
    layer: 'subject' as const,
    keyColumn: 'id',
    events: `BEFORE UPDATE (bump when any of ${USERS_AUTHORITY_COLUMNS.join(', ')} changes)`,
  }),
  Object.freeze({
    table: 'users',
    trigger: 'trg_users_zz_authz_subject_version_lifecycle',
    fn: AUTHZ_SUBJECT_VERSION_BUMP_FUNCTION,
    layer: 'subject' as const,
    keyColumn: 'id',
    events: 'BEFORE INSERT OR DELETE',
  }),
])

/** Tables that carry a version trigger (deduplicated, in protocol order). */
export const AUTHORIZATION_VERSION_COVERED_TABLES: readonly string[] = Object.freeze(
  Array.from(new Set(AUTHORIZATION_VERSION_TRIGGERS.map((entry) => entry.table))),
)

const SEARCH_PATH = sql.raw('SET search_path = pg_catalog, public')

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe authorization-version identifier: ${value}`)
  return value
}

async function createVersionTables(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.${sql.raw(SHEET_PERMISSION_VERSIONS_TABLE)} (
      sheet_id text PRIMARY KEY,
      version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`
    CREATE TABLE IF NOT EXISTS public.${sql.raw(SUBJECT_AUTHORIZATION_VERSIONS_TABLE)} (
      subject_id text PRIMARY KEY,
      version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
}

/**
 * One generic bump function per layer. TG_ARGV[0] names the key column; the key is read through
 * `to_jsonb(row) ->> column` so the same function serves text and varchar keys. Both the NEW and the
 * OLD key are bumped (a key rewrite revokes on the old side and grants on the new side), in sorted
 * order. A NULL / blank key cannot occur on the covered tables (NOT NULL keys) and is skipped rather
 * than raised, mirroring the recovery-authority trigger.
 *
 * Optional TG_ARGV[1] narrows an UPDATE trigger (see the docblock on why this is not a WHEN clause):
 *   - `'field-visibility'`: bump only when the `property.hidden === true` / `property.visible === false`
 *     derivation changes (`permission-derivation.ts isFieldPermissionHidden`);
 *   - otherwise a comma-separated list of watched columns: bump only when one of them changes
 *     (`to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col`; a column absent from the row
 *     compares NULL = NULL).
 */
async function createBumpFunction(
  db: Kysely<unknown>,
  functionName: string,
  table: string,
  keyColumn: string,
): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION public.${sql.raw(identifier(functionName))}()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    ${SEARCH_PATH}
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
        INSERT INTO public.${sql.raw(identifier(table))} AS v (${sql.raw(identifier(keyColumn))}, version, updated_at)
        VALUES (key_value, 1, now())
        ON CONFLICT (${sql.raw(identifier(keyColumn))}) DO UPDATE
          SET version = v.version + 1,
              updated_at = now();
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)
}

async function assertColumns(db: Kysely<unknown>, table: string, columns: readonly string[]): Promise<void> {
  for (const column of columns) {
    if (!(await checkColumnExists(db, table, column))) {
      throw new Error(
        `authorization version protocol requires ${table}.${column}; apply the migration that adds it before zzzz20261106110500`,
      )
    }
  }
}

export async function dropAuthorizationVersionTriggers(db: Kysely<unknown>): Promise<void> {
  for (const { table, trigger } of AUTHORIZATION_VERSION_TRIGGERS) {
    // Tolerate a table an earlier migration's down() already removed (DROP TRIGGER … ON <missing> errors).
    await sql`
      DO $$ BEGIN
        IF to_regclass(${sql.lit(`public.${identifier(table)}`)}) IS NOT NULL THEN
          EXECUTE ${sql.lit(`DROP TRIGGER IF EXISTS ${identifier(trigger)} ON public.${identifier(table)}`)};
        END IF;
      END $$
    `.execute(db)
  }
}

export async function installAuthorizationVersionProtocol(db: Kysely<unknown>): Promise<void> {
  await assertColumns(db, 'users', USERS_AUTHORITY_COLUMNS)
  await assertColumns(db, 'meta_sheets', META_SHEETS_AUTHORITY_COLUMNS)
  await assertColumns(db, 'meta_fields', ['property'])

  await createVersionTables(db)
  await createBumpFunction(db, AUTHZ_SHEET_VERSION_BUMP_FUNCTION, SHEET_PERMISSION_VERSIONS_TABLE, 'sheet_id')
  await createBumpFunction(db, AUTHZ_SUBJECT_VERSION_BUMP_FUNCTION, SUBJECT_AUTHORIZATION_VERSIONS_TABLE, 'subject_id')

  await dropAuthorizationVersionTriggers(db)

  for (const table of SHEET_ROW_TABLES) {
    await sql`
      CREATE TRIGGER ${sql.raw(`trg_${table}_zz_authz_sheet_version`)}
        BEFORE INSERT OR UPDATE OR DELETE ON public.${sql.raw(table)}
        FOR EACH ROW EXECUTE FUNCTION public.${sql.raw(AUTHZ_SHEET_VERSION_BUMP_FUNCTION)}('sheet_id')
    `.execute(db)
  }

  // Watched columns travel as TEXT (no pg_depend edge on the columns — see the docblock).
  await sql`
    CREATE TRIGGER trg_meta_sheets_zz_authz_sheet_version_update
      BEFORE UPDATE ON public.meta_sheets
      FOR EACH ROW
      EXECUTE FUNCTION public.${sql.raw(AUTHZ_SHEET_VERSION_BUMP_FUNCTION)}('id', ${sql.lit(META_SHEETS_AUTHORITY_COLUMNS.join(','))})
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_sheets_zz_authz_sheet_version_delete
      BEFORE DELETE ON public.meta_sheets
      FOR EACH ROW EXECUTE FUNCTION public.${sql.raw(AUTHZ_SHEET_VERSION_BUMP_FUNCTION)}('id')
  `.execute(db)

  // Exactly the derivation of permission-derivation.ts isFieldPermissionHidden: hidden === true or
  // visible === false (computed inside the function). Adding `hidden: false` or editing options /
  // formats / names does not bump.
  await sql`
    CREATE TRIGGER trg_meta_fields_zz_authz_sheet_version_visibility
      BEFORE UPDATE ON public.meta_fields
      FOR EACH ROW
      EXECUTE FUNCTION public.${sql.raw(AUTHZ_SHEET_VERSION_BUMP_FUNCTION)}('sheet_id', 'field-visibility')
  `.execute(db)

  for (const table of SUBJECT_ROW_TABLES) {
    await sql`
      CREATE TRIGGER ${sql.raw(`trg_${table}_zz_authz_subject_version`)}
        BEFORE INSERT OR UPDATE OR DELETE ON public.${sql.raw(table)}
        FOR EACH ROW EXECUTE FUNCTION public.${sql.raw(AUTHZ_SUBJECT_VERSION_BUMP_FUNCTION)}('user_id')
    `.execute(db)
  }

  await sql`
    CREATE TRIGGER trg_users_zz_authz_subject_version_update
      BEFORE UPDATE ON public.users
      FOR EACH ROW
      EXECUTE FUNCTION public.${sql.raw(AUTHZ_SUBJECT_VERSION_BUMP_FUNCTION)}('id', ${sql.lit(USERS_AUTHORITY_COLUMNS.join(','))})
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_users_zz_authz_subject_version_lifecycle
      BEFORE INSERT OR DELETE ON public.users
      FOR EACH ROW EXECUTE FUNCTION public.${sql.raw(AUTHZ_SUBJECT_VERSION_BUMP_FUNCTION)}('id')
  `.execute(db)
}

export async function dropAuthorizationVersionProtocol(db: Kysely<unknown>): Promise<void> {
  await dropAuthorizationVersionTriggers(db)
  await sql`DROP FUNCTION IF EXISTS public.${sql.raw(AUTHZ_SHEET_VERSION_BUMP_FUNCTION)}()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.${sql.raw(AUTHZ_SUBJECT_VERSION_BUMP_FUNCTION)}()`.execute(db)
  await sql`DROP TABLE IF EXISTS public.${sql.raw(SHEET_PERMISSION_VERSIONS_TABLE)}`.execute(db)
  await sql`DROP TABLE IF EXISTS public.${sql.raw(SUBJECT_AUTHORIZATION_VERSIONS_TABLE)}`.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await installAuthorizationVersionProtocol(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropAuthorizationVersionProtocol(db)
}
