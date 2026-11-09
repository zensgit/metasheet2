import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Deprovision effect provider witness.
 *
 * Adds a nullable `provider` column to `directory_deprovision_effects`. The column is written at
 * insert time for `grant_changed` effects only and is immutable afterwards. Rows written before
 * this migration keep `provider IS NULL`, which readers and the INSERT trigger below both read as
 * `'dingtalk'`; no backfill is performed.
 *
 * Invariants pinned here:
 * - `ddef_provider_scope_check`: a non-NULL provider appears only on a `grant_changed` effect and
 *   is never blank;
 * - `trg_deprovision_effects_provider_validate` (BEFORE INSERT): on a `grant_changed` effect,
 *   `COALESCE(NEW.provider, 'dingtalk')` equals the parent event integration's provider;
 * - `trg_deprovision_effects_provider_immutable` (BEFORE UPDATE): `provider` never changes.
 *
 * The protection lives in DEDICATED functions and triggers, distinct from the shared
 * `directory_deprovision_reject_identity_update()` / `directory_deprovision_validate_effect()`
 * objects that earlier migrations replace wholesale, so an out-of-order replay of those migrations
 * cannot remove it. `down()` touches only the objects created here and refuses while a
 * non-default provider value exists, because dropping the column would lose that witness.
 *
 * File naming: `zzzz` prefix keeps this after the migrations that create the ledger tables on a
 * fresh database.
 */

const EFFECTS = 'directory_deprovision_effects'
const EVENTS = 'directory_deprovision_events'
const INTEGRATIONS = 'directory_integrations'
const COLUMN = 'provider'
const CHECK_NAME = 'ddef_provider_scope_check'
const VALIDATE_FN = 'directory_deprovision_effect_provider_validate'
const VALIDATE_TRIGGER = 'trg_deprovision_effects_provider_validate'
const IMMUTABLE_FN = 'directory_deprovision_effect_provider_immutable'
const IMMUTABLE_TRIGGER = 'trg_deprovision_effects_provider_immutable'
const DEFAULT_PROVIDER = 'dingtalk'
const MIGRATION_LOCK_TIMEOUT = '5s'
const MIGRATION_STATEMENT_TIMEOUT = '5min'

// pg_trigger.tgtype bits (PostgreSQL): ROW = 1, BEFORE = 2, INSERT = 4, UPDATE = 16.
const TGTYPE_ROW = 1
const TGTYPE_BEFORE = 2
const TGTYPE_INSERT = 4
const TGTYPE_UPDATE = 16

export const __deprovisionEffectProviderObjects = Object.freeze({
  column: COLUMN,
  check: CHECK_NAME,
  validateFunction: VALIDATE_FN,
  validateTrigger: VALIDATE_TRIGGER,
  immutableFunction: IMMUTABLE_FN,
  immutableTrigger: IMMUTABLE_TRIGGER,
  defaultProvider: DEFAULT_PROVIDER,
})

type Timeouts = { lock_timeout: string; statement_timeout: string }

async function readMigrationTimeouts(db: Kysely<unknown>): Promise<Timeouts> {
  const result = await sql<Timeouts>`
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

async function restoreMigrationTimeouts(db: Kysely<unknown>, previous: Timeouts): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${previous.lock_timeout}, true),
      set_config('statement_timeout', ${previous.statement_timeout}, true)
  `.execute(db)
}

async function tableExists(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ${tableName}
    ) AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

type ColumnShape = { data_type: string; is_nullable: string; column_default: string | null }

async function columnShape(db: Kysely<unknown>): Promise<ColumnShape | null> {
  const result = await sql<ColumnShape>`
    SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ${EFFECTS}
       AND column_name = ${COLUMN}
  `.execute(db)
  return result.rows[0] ?? null
}

async function assertPreflight(db: Kysely<unknown>): Promise<void> {
  for (const table of [EVENTS, EFFECTS, INTEGRATIONS]) {
    if (!(await tableExists(db, table))) {
      throw new Error('deprovision effect provider migration requires the directory deprovision ledger and integration tables')
    }
  }
}

async function ensureProviderColumn(db: Kysely<unknown>): Promise<void> {
  const shape = await columnShape(db)
  if (shape) {
    if (shape.data_type !== 'text' || shape.is_nullable !== 'YES' || shape.column_default !== null) {
      throw new Error('deprovision effect provider column drift: expected a nullable text column with no default')
    }
    return
  }
  await sql`ALTER TABLE directory_deprovision_effects ADD COLUMN provider text`.execute(db)
}

async function ensureScopeCheck(db: Kysely<unknown>): Promise<void> {
  const conflict = await sql`
    SELECT 1 AS present
      FROM directory_deprovision_effects
     WHERE provider IS NOT NULL
       AND (effect_type <> 'grant_changed' OR btrim(provider) = '')
     LIMIT 1
  `.execute(db)
  if (conflict.rows.length > 0) {
    throw new Error('deprovision effect provider scope check cannot be added: a non-grant effect carries a provider')
  }
  await sql`ALTER TABLE directory_deprovision_effects DROP CONSTRAINT IF EXISTS ddef_provider_scope_check`.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      ADD CONSTRAINT ddef_provider_scope_check
      CHECK (provider IS NULL OR (effect_type = 'grant_changed' AND btrim(provider) <> ''))
      NOT VALID
  `.execute(db)
  await sql`ALTER TABLE directory_deprovision_effects VALIDATE CONSTRAINT ddef_provider_scope_check`.execute(db)
}

async function ensureTriggers(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION directory_deprovision_effect_provider_validate()
    RETURNS trigger AS $$
    DECLARE
      parent_provider text;
    BEGIN
      IF NEW.effect_type IS DISTINCT FROM 'grant_changed' THEN
        RETURN NEW;
      END IF;

      SELECT integration.provider
        INTO parent_provider
        FROM directory_deprovision_events event
        JOIN directory_integrations integration
          ON integration.id = event.integration_id
       WHERE event.id = NEW.event_id;

      IF NOT FOUND THEN
        RETURN NEW;
      END IF;

      IF COALESCE(NEW.provider, 'dingtalk') IS DISTINCT FROM parent_provider THEN
        RAISE EXCEPTION 'deprovision effect provider does not match the event integration';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_provider_validate ON directory_deprovision_effects`.execute(db)
  await sql`
    CREATE TRIGGER trg_deprovision_effects_provider_validate
    BEFORE INSERT ON directory_deprovision_effects
    FOR EACH ROW EXECUTE FUNCTION directory_deprovision_effect_provider_validate()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION directory_deprovision_effect_provider_immutable()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.provider IS DISTINCT FROM OLD.provider THEN
        RAISE EXCEPTION 'deprovision effect provider is immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_provider_immutable ON directory_deprovision_effects`.execute(db)
  await sql`
    CREATE TRIGGER trg_deprovision_effects_provider_immutable
    BEFORE UPDATE ON directory_deprovision_effects
    FOR EACH ROW EXECUTE FUNCTION directory_deprovision_effect_provider_immutable()
  `.execute(db)
}

type TriggerRow = { tgtype: number; tgenabled: string; proname: string }

async function readTrigger(db: Kysely<unknown>, triggerName: string): Promise<TriggerRow | null> {
  const result = await sql<TriggerRow>`
    SELECT trigger_row.tgtype::int AS tgtype,
           trigger_row.tgenabled::text AS tgenabled,
           function_row.proname::text AS proname
      FROM pg_trigger trigger_row
      JOIN pg_class table_rel ON table_rel.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
      JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
     WHERE namespace.nspname = current_schema()
       AND table_rel.relname = ${EFFECTS}
       AND trigger_row.tgname = ${triggerName}
       AND NOT trigger_row.tgisinternal
  `.execute(db)
  return result.rows[0] ?? null
}

async function assertTrigger(
  db: Kysely<unknown>,
  triggerName: string,
  functionName: string,
  eventBit: number,
): Promise<void> {
  const row = await readTrigger(db, triggerName)
  const bits = row ? Number(row.tgtype) : 0
  const ok =
    row !== null
    && row.proname === functionName
    && row.tgenabled === 'O'
    && (bits & TGTYPE_ROW) === TGTYPE_ROW
    && (bits & TGTYPE_BEFORE) === TGTYPE_BEFORE
    && (bits & eventBit) === eventBit
  if (!ok) {
    throw new Error('deprovision effect provider migration self-check failed: trigger structure')
  }
}

async function assertCheckValidated(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ convalidated: boolean }>`
    SELECT constraint_row.convalidated
      FROM pg_constraint constraint_row
      JOIN pg_class table_rel ON table_rel.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_rel.relname = ${EFFECTS}
       AND constraint_row.conname = ${CHECK_NAME}
       AND constraint_row.contype = 'c'
  `.execute(db)
  if (result.rows[0]?.convalidated !== true) {
    throw new Error('deprovision effect provider migration self-check failed: scope check')
  }
}

async function applyUp(db: Kysely<unknown>): Promise<void> {
  await assertPreflight(db)
  await ensureProviderColumn(db)
  await ensureScopeCheck(db)
  await ensureTriggers(db)
  await assertTrigger(db, VALIDATE_TRIGGER, VALIDATE_FN, TGTYPE_INSERT)
  await assertTrigger(db, IMMUTABLE_TRIGGER, IMMUTABLE_FN, TGTYPE_UPDATE)
  await assertCheckValidated(db)
}

async function applyDown(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExists(db, EFFECTS))) return
  if ((await columnShape(db)) === null) return

  const witness = await sql`
    SELECT 1 AS present
      FROM directory_deprovision_effects
     WHERE provider IS NOT NULL
       AND provider <> 'dingtalk'
     LIMIT 1
  `.execute(db)
  if (witness.rows.length > 0) {
    throw new Error('refusing to drop the deprovision effect provider column: a non-default provider witness exists')
  }

  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_provider_immutable ON directory_deprovision_effects`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_provider_validate ON directory_deprovision_effects`.execute(db)
  await sql`DROP FUNCTION IF EXISTS directory_deprovision_effect_provider_immutable()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS directory_deprovision_effect_provider_validate()`.execute(db)
  await sql`ALTER TABLE directory_deprovision_effects DROP CONSTRAINT IF EXISTS ddef_provider_scope_check`.execute(db)
  await sql`ALTER TABLE directory_deprovision_effects DROP COLUMN IF EXISTS provider`.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // All pending PostgreSQL migrations run in one transaction. The lock and statement bounds are
  // scoped to this migration and restored on success so later migrations do not inherit them; on
  // failure the enclosing transaction rolls the settings back as well.
  const previousTimeouts = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await applyUp(db)
  await restoreMigrationTimeouts(db, previousTimeouts)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const previousTimeouts = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await applyDown(db)
  await restoreMigrationTimeouts(db, previousTimeouts)
}
