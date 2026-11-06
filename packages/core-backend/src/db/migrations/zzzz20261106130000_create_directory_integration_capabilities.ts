/**
 * directory_integration_capabilities: one row per directory integration that has had a capability
 * (directory, login, notification) turned on; no row means all three are off. Each capability carries
 * its own scope anchor, present exactly while that capability is on.
 * directory_integration_capability_history: append-only record of who changed what.
 *
 * Both tables are new and empty; no existing table is altered. The lock and statement bounds apply to
 * this migration only and are restored afterwards. down() refuses while either table holds a row.
 *
 * Ordering: Kysely runs migrations in full-filename order; this file sorts after every migration on
 * main at the time it was written. It depends on directory_integrations and its two unique
 * constraints (id, provider) and (id, org_id); a missing prerequisite aborts the whole batch.
 */
import { sql, type Kysely } from 'kysely'

const MIGRATION_LOCK_TIMEOUT = '5s'
const MIGRATION_STATEMENT_TIMEOUT = '5min'

export const DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED_CODE = 'DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED'
export const DIRECTORY_INTEGRATION_CAPABILITIES_PREREQUISITE_CODE = 'DIRECTORY_INTEGRATION_CAPABILITIES_PREREQUISITE_MISSING'

type MigrationTimeouts = { lock_timeout: string; statement_timeout: string }

async function readMigrationTimeouts(db: Kysely<unknown>): Promise<MigrationTimeouts> {
  const result = await sql<MigrationTimeouts>`
    SELECT
      current_setting('lock_timeout') AS lock_timeout,
      current_setting('statement_timeout') AS statement_timeout
  `.execute(db)
  return result.rows[0] ?? { lock_timeout: '0', statement_timeout: '0' }
}

async function applyMigrationTimeouts(db: Kysely<unknown>): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${MIGRATION_LOCK_TIMEOUT}, true),
      set_config('statement_timeout', ${MIGRATION_STATEMENT_TIMEOUT}, true)
  `.execute(db)
}

async function restoreMigrationTimeouts(db: Kysely<unknown>, previous: MigrationTimeouts): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${previous.lock_timeout}, true),
      set_config('statement_timeout', ${previous.statement_timeout}, true)
  `.execute(db)
}

async function requirePrerequisites(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ present: boolean; by_provider: boolean; by_org: boolean }>`
    SELECT
      to_regclass('directory_integrations') IS NOT NULL AS present,
      EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_directory_integrations_id_provider'
           AND conrelid = to_regclass('directory_integrations')
           AND contype = 'u'
      ) AS by_provider,
      EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_directory_integrations_id_org'
           AND conrelid = to_regclass('directory_integrations')
           AND contype = 'u'
      ) AS by_org
  `.execute(db)
  const row = result.rows[0]
  if (row?.present !== true || row.by_provider !== true || row.by_org !== true) {
    const error = new Error(
      `${DIRECTORY_INTEGRATION_CAPABILITIES_PREREQUISITE_CODE}: directory_integrations and its unique constraints on (id, provider) and (id, org_id) must exist before this migration runs. Nothing was changed.`,
    )
    ;(error as Error & { code?: string }).code = DIRECTORY_INTEGRATION_CAPABILITIES_PREREQUISITE_CODE
    throw error
  }
}

async function applyUp(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE directory_integration_capabilities (
      integration_id uuid NOT NULL,
      bound_provider text NOT NULL,
      bound_org_id text NOT NULL,
      directory_enabled boolean NOT NULL DEFAULT false,
      directory_bound_tenant text,
      directory_bound_app_scope text,
      login_enabled boolean NOT NULL DEFAULT false,
      login_bound_tenant text,
      login_bound_app_scope text,
      notification_enabled boolean NOT NULL DEFAULT false,
      notification_bound_tenant text,
      notification_bound_app_scope text,
      revision bigint NOT NULL,
      created_by text NOT NULL,
      updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT dic_pkey PRIMARY KEY (integration_id),
      CONSTRAINT dic_integration_provider_fk FOREIGN KEY (integration_id, bound_provider)
        REFERENCES directory_integrations (id, provider) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT dic_integration_org_fk FOREIGN KEY (integration_id, bound_org_id)
        REFERENCES directory_integrations (id, org_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT dic_row_shape_chk CHECK (
        bound_provider ~ '^[a-z][a-z0-9_]{0,31}$'
        AND btrim(created_by) <> ''
        AND btrim(updated_by) <> ''
      ),
      CONSTRAINT dic_revision_chk CHECK (revision >= 1),
      CONSTRAINT dic_directory_anchor_chk CHECK (CASE WHEN directory_enabled THEN
        (directory_bound_tenant IS NOT NULL AND directory_bound_tenant ~ '^[!-~]+$'
         AND directory_bound_app_scope IS NOT NULL AND directory_bound_app_scope ~ '^[!-~]+$'
         AND char_length(directory_bound_app_scope) <= 256)
        ELSE (directory_bound_tenant IS NULL AND directory_bound_app_scope IS NULL) END),
      CONSTRAINT dic_login_anchor_chk CHECK (CASE WHEN login_enabled THEN
        (login_bound_tenant IS NOT NULL AND login_bound_tenant ~ '^[!-~]+$'
         AND login_bound_app_scope IS NOT NULL AND login_bound_app_scope ~ '^[!-~]+$'
         AND char_length(login_bound_app_scope) <= 256)
        ELSE (login_bound_tenant IS NULL AND login_bound_app_scope IS NULL) END),
      CONSTRAINT dic_notification_anchor_chk CHECK (CASE WHEN notification_enabled THEN
        (notification_bound_tenant IS NOT NULL AND notification_bound_tenant ~ '^[!-~]+$'
         AND notification_bound_app_scope IS NOT NULL AND notification_bound_app_scope ~ '^[!-~]+$'
         AND char_length(notification_bound_app_scope) <= 256)
        ELSE (notification_bound_tenant IS NULL AND notification_bound_app_scope IS NULL) END)
    )
  `.execute(db)
  // At most one integration per provider holds a given (tenant, application) for login. The comparison
  // folds case, which refuses more than an exact comparison would.
  await sql`
    CREATE UNIQUE INDEX dic_login_scope_uniq
      ON directory_integration_capabilities (bound_provider, lower(login_bound_tenant), lower(login_bound_app_scope))
      WHERE login_enabled
  `.execute(db)
  await sql`
    CREATE FUNCTION dic_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    BEGIN
      IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
        RAISE EXCEPTION 'directory integration capability revision refused' USING ERRCODE = '55000';
      END IF;
      IF NEW.integration_id IS DISTINCT FROM OLD.integration_id
         OR NEW.bound_provider IS DISTINCT FROM OLD.bound_provider
         OR NEW.bound_org_id IS DISTINCT FROM OLD.bound_org_id
         OR NEW.created_by IS DISTINCT FROM OLD.created_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'directory integration capability immutable column refused' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER dic_guard_update_trg
      BEFORE UPDATE ON directory_integration_capabilities
      FOR EACH ROW EXECUTE FUNCTION dic_guard_update()
  `.execute(db)
  await sql`
    CREATE TABLE directory_integration_capability_history (
      id bigint GENERATED ALWAYS AS IDENTITY,
      integration_id uuid NOT NULL,
      bound_provider text NOT NULL,
      revision bigint NOT NULL,
      actor_id text NOT NULL,
      changed text[] NOT NULL,
      anchor_rebound text[] NOT NULL DEFAULT '{}',
      directory_enabled boolean NOT NULL,
      login_enabled boolean NOT NULL,
      notification_enabled boolean NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT dich_pkey PRIMARY KEY (id),
      CONSTRAINT dich_revision_chk CHECK (revision >= 1),
      CONSTRAINT dich_actor_chk CHECK (btrim(actor_id) <> ''),
      CONSTRAINT dich_changed_chk CHECK (
        cardinality(changed) >= 1 AND changed <@ ARRAY['directory', 'login', 'notification']::text[]
      ),
      CONSTRAINT dich_anchor_rebound_chk CHECK (anchor_rebound <@ ARRAY['directory', 'login', 'notification']::text[])
    )
  `.execute(db)
  await sql`
    CREATE INDEX dich_integration_idx ON directory_integration_capability_history (integration_id, id)
  `.execute(db)
  await sql`
    CREATE FUNCTION dich_guard_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    BEGIN
      RAISE EXCEPTION 'directory integration capability history is append-only' USING ERRCODE = '55000';
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER dich_append_only_trg
      BEFORE UPDATE OR DELETE ON directory_integration_capability_history
      FOR EACH ROW EXECUTE FUNCTION dich_guard_append_only()
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely runs every pending migration in one transaction. Scope the lock and statement bounds to
  // this migration and restore them on success so later migrations do not inherit the settings.
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await requirePrerequisites(db)
  await applyUp(db)
  await restoreMigrationTimeouts(db, previous)
}

// The tables are retained administrator history. Each existence check and its row check are two
// statements because Postgres resolves every relation named in a statement before evaluating it.
async function refuseDownWhileRowsExist(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ capabilities: boolean; history: boolean }>`
    SELECT
      to_regclass('directory_integration_capabilities') IS NOT NULL AS capabilities,
      to_regclass('directory_integration_capability_history') IS NOT NULL AS history
  `.execute(db)
  const present = exists.rows[0]
  let held = false
  if (present?.capabilities === true) {
    const rows = await sql<{ present: boolean }>`
      SELECT EXISTS (SELECT 1 FROM directory_integration_capabilities) AS present
    `.execute(db)
    held = held || rows.rows[0]?.present === true
  }
  if (present?.history === true) {
    const rows = await sql<{ present: boolean }>`
      SELECT EXISTS (SELECT 1 FROM directory_integration_capability_history) AS present
    `.execute(db)
    held = held || rows.rows[0]?.present === true
  }
  if (held) {
    const error = new Error(
      `${DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED_CODE}: down() refused while the directory integration capability tables hold rows; they are retained administrator history. Nothing was changed. Roll back the application build and leave the tables in place.`,
    )
    ;(error as Error & { code?: string }).code = DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED_CODE
    throw error
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await refuseDownWhileRowsExist(db)
  await sql`DROP TABLE IF EXISTS directory_integration_capability_history`.execute(db)
  await sql`DROP TABLE IF EXISTS directory_integration_capabilities`.execute(db)
  await sql`DROP FUNCTION IF EXISTS dich_guard_append_only()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS dic_guard_update()`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}
