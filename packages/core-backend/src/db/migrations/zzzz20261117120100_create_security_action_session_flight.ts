/**
 * security_action_session_flight: one active row per authenticated session that is inside a
 * local-password security-action attempt. The row has no expiry and no foreign key. down() runs
 * only in the caller's already-open read-committed transaction: it locks the actual relation,
 * refuses while any row exists, and drops only this migration's objects.
 *
 * Ordering: Kysely runs migrations in full-filename order. This file sorts after the published
 * challenges migration and does not modify that migration.
 */
import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export const SECURITY_ACTION_SESSION_FLIGHT_DOWN_BLOCKED_CODE = 'SECURITY_ACTION_SESSION_FLIGHT_DOWN_BLOCKED'
export const SECURITY_ACTION_SESSION_FLIGHT_SCHEMA_BLOCKED_CODE = 'SECURITY_ACTION_SESSION_FLIGHT_SCHEMA_BLOCKED'

const IDENT = /^[a-z_][a-z0-9_]*$/
const OID = /^[1-9][0-9]*$/
const RELATION = 'security_action_session_flight'
const GUARD = 'security_action_session_flight_guard'
const ACQUIRE = 'security_action_session_flight_acquire'
const RELEASE = 'security_action_session_flight_release'

function withCode(code: string): Error {
  const error = new Error(`${code}: security_action_session_flight migration refused. Nothing was changed.`)
  ;(error as Error & { code?: string }).code = code
  return error
}

function quoteIdent(ident: string): string {
  if (!IDENT.test(ident)) throw withCode(SECURITY_ACTION_SESSION_FLIGHT_SCHEMA_BLOCKED_CODE)
  return `"${ident}"`
}

function isApplicationSchema(name: unknown): name is string {
  return typeof name === 'string' && IDENT.test(name) && !name.startsWith('pg_') && name !== 'information_schema'
}

async function currentSchema(db: Kysely<unknown>): Promise<string> {
  const found = await sql<{ schema_name: string | null }>`
    SELECT candidate.nspname AS schema_name
      FROM unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
     ORDER BY candidate.ord
  `.execute(db)
  for (const row of found.rows) {
    const name = row?.schema_name
    if (name === 'information_schema' || (typeof name === 'string' && name.startsWith('pg_'))) continue
    if (!isApplicationSchema(name)) throw withCode(SECURITY_ACTION_SESSION_FLIGHT_SCHEMA_BLOCKED_CODE)
    return name
  }
  throw withCode(SECURITY_ACTION_SESSION_FLIGHT_SCHEMA_BLOCKED_CODE)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const schema = quoteIdent(await currentSchema(db))
  const table = `${schema}.${RELATION}`
  await sql.raw(`
    CREATE TABLE ${table} (
      session_id text NOT NULL,
      owner_token text NOT NULL,
      state text NOT NULL,
      bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT ${RELATION}_pkey PRIMARY KEY (session_id),
      CONSTRAINT ${RELATION}_owner_token_chk CHECK (owner_token ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ${RELATION}_state_chk CHECK (state = 'active')
    )
  `).execute(db)
  await sql.raw(`
    CREATE FUNCTION ${schema}.${ACQUIRE}(p_session_id text, p_owner_token text)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    BEGIN
      PERFORM pg_catalog.set_config('security_action.session_flight_token', p_owner_token, true);
      INSERT INTO ${table} (session_id, owner_token, state)
      VALUES (p_session_id, p_owner_token, 'active');
      RETURN true;
    EXCEPTION
      WHEN unique_violation THEN
        RETURN false;
    END;
    $fn$
  `).execute(db)
  await sql.raw(`
    CREATE FUNCTION ${schema}.${RELEASE}(p_session_id text, p_owner_token text)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      removed integer;
    BEGIN
      PERFORM pg_catalog.set_config('security_action.session_flight_token', p_owner_token, true);
      DELETE FROM ${table}
       WHERE session_id = p_session_id
         AND owner_token = p_owner_token;
      GET DIAGNOSTICS removed = ROW_COUNT;
      RETURN removed = 1;
    END;
    $fn$
  `).execute(db)
  await sql.raw(`
    CREATE FUNCTION ${schema}.${GUARD}()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      token text;
    BEGIN
      token := pg_catalog.current_setting('security_action.session_flight_token', true);
      IF TG_OP = 'INSERT' THEN
        IF token IS NULL OR token <> NEW.owner_token THEN
          RAISE EXCEPTION 'SECURITY_ACTION_SESSION_FLIGHT_WRITE_BLOCKED' USING ERRCODE = '42501';
        END IF;
        IF NEW.state IS DISTINCT FROM 'active' THEN
          RAISE EXCEPTION 'SECURITY_ACTION_SESSION_FLIGHT_WRITE_BLOCKED' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      ELSIF TG_OP = 'DELETE' THEN
        IF token IS NULL OR token <> OLD.owner_token THEN
          RAISE EXCEPTION 'SECURITY_ACTION_SESSION_FLIGHT_WRITE_BLOCKED' USING ERRCODE = '42501';
        END IF;
        RETURN OLD;
      ELSE
        RAISE EXCEPTION 'SECURITY_ACTION_SESSION_FLIGHT_WRITE_BLOCKED' USING ERRCODE = '42501';
      END IF;
    END;
    $fn$
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${GUARD}
    BEFORE INSERT OR UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${schema}.${GUARD}()
  `).execute(db)
  await restoreMigrationTimeouts(db, previous)
}

async function assertCallerTransaction(db: Kysely<unknown>): Promise<void> {
  await sql`SELECT pg_catalog.set_config('security_action.session_flight_down_marker', 'open', true)`.execute(db)
  const marker = await sql<{ marker: string | null }>`
    SELECT pg_catalog.current_setting('security_action.session_flight_down_marker', true) AS marker
  `.execute(db)
  if (marker.rows[0]?.marker !== 'open') throw withCode(SECURITY_ACTION_SESSION_FLIGHT_DOWN_BLOCKED_CODE)
  const isolation = await sql<{ isolation: string }>`
    SELECT pg_catalog.current_setting('transaction_isolation') AS isolation
  `.execute(db)
  if (String(isolation.rows[0]?.isolation ?? '').toLowerCase() !== 'read committed') {
    throw withCode(SECURITY_ACTION_SESSION_FLIGHT_DOWN_BLOCKED_CODE)
  }
}

async function locateRelation(db: Kysely<unknown>): Promise<string | null> {
  const schema = await currentSchema(db)
  const found = await sql<{ rel_oid: string; relkind: string; relpersistence: string }>`
    SELECT c.oid::text AS rel_oid, c.relkind, c.relpersistence
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema}
       AND c.relname = ${RELATION}
  `.execute(db)
  if (found.rows.length === 0) return null
  const relation = found.rows[0]
  if (found.rows.length !== 1 || !relation || relation.relkind !== 'r' || relation.relpersistence !== 'p' || !OID.test(relation.rel_oid)) {
    throw withCode(SECURITY_ACTION_SESSION_FLIGHT_DOWN_BLOCKED_CODE)
  }
  return schema
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await assertCallerTransaction(db)
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  let schemaName: string | null
  try {
    schemaName = await locateRelation(db)
  } catch (error) {
    await restoreMigrationTimeouts(db, previous)
    throw error
  }
  if (schemaName === null) {
    await restoreMigrationTimeouts(db, previous)
    return
  }
  const schema = quoteIdent(schemaName)
  const table = `${schema}.${RELATION}`
  await sql.raw(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`).execute(db)
  const present = await sql<{ present: boolean }>`
    SELECT EXISTS (SELECT 1 FROM ${sql.raw(table)}) AS present
  `.execute(db)
  if (present.rows[0]?.present === true) {
    await restoreMigrationTimeouts(db, previous)
    throw withCode(SECURITY_ACTION_SESSION_FLIGHT_DOWN_BLOCKED_CODE)
  }
  await sql.raw(`DROP TRIGGER ${GUARD} ON ${table}`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.${GUARD}()`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.${ACQUIRE}(text, text)`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.${RELEASE}(text, text)`).execute(db)
  await sql.raw(`DROP TABLE ${table}`).execute(db)
  await restoreMigrationTimeouts(db, previous)
}
