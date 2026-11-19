/**
 * Actor inputs for admin login grant: nullable users.local_credential_version,
 * append-only user_local_credential_establishments, and immutable
 * security_action_browser_bindings.
 *
 * up() and down() both require the caller's already-open read-committed
 * transaction before they change or lock anything. down() refuses retained
 * browser rows, establishment rows, and non-null credential versions, then
 * drops only the objects this file created, including functions and the
 * version trigger left behind when the column and both tables are absent.
 * No extension, backfill, or cascade.
 */
import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export const ADMIN_GRANT_ACTOR_INPUTS_TRANSACTION_CODE = 'ADMIN_GRANT_ACTOR_INPUTS_TRANSACTION_REQUIRED'
export const ADMIN_GRANT_ACTOR_INPUTS_ISOLATION_CODE = 'ADMIN_GRANT_ACTOR_INPUTS_READ_COMMITTED_REQUIRED'
export const ADMIN_GRANT_ACTOR_INPUTS_SCHEMA_CODE = 'ADMIN_GRANT_ACTOR_INPUTS_SCHEMA_BLOCKED'
export const ADMIN_GRANT_ACTOR_INPUTS_DOWN_BLOCKED_CODE = 'ADMIN_GRANT_ACTOR_INPUTS_DOWN_BLOCKED'

const IDENT = /^[a-z_][a-z0-9_]*$/
const VERSION_FUNCTION = 'admin_grant_local_credential_version'
const ESTABLISHMENT_FUNCTION = 'admin_grant_local_credential_establishment_guard'
const BROWSER_FUNCTION = 'admin_grant_browser_binding_guard'
const ESTABLISHMENTS = 'user_local_credential_establishments'
const BINDINGS = 'security_action_browser_bindings'
const VERSION_TRIGGER = 'admin_grant_local_credential_version'
const ESTABLISHMENT_ROW_TRIGGER = 'admin_grant_local_credential_establishment_guard'
const ESTABLISHMENT_TRUNCATE_TRIGGER = 'admin_grant_local_credential_establishment_truncate'
const BROWSER_ROW_TRIGGER = 'admin_grant_browser_binding_guard'
const BROWSER_TRUNCATE_TRIGGER = 'admin_grant_browser_binding_truncate'

function withCode(code: string): Error {
  const error = new Error(`${code}: admin grant actor inputs migration refused. Nothing was changed.`)
  ;(error as Error & { code?: string }).code = code
  return error
}

export function quoteAdminGrantActorInputIdent(identifier: string): string {
  if (!IDENT.test(identifier)) throw withCode(ADMIN_GRANT_ACTOR_INPUTS_SCHEMA_CODE)
  return `"${identifier}"`
}

function qualified(schemaName: string, identifier: string): string {
  return `${quoteAdminGrantActorInputIdent(schemaName)}.${quoteAdminGrantActorInputIdent(identifier)}`
}

export function adminGrantActorInputUpStatements(schemaName: string): readonly string[] {
  const schema = quoteAdminGrantActorInputIdent(schemaName)
  const users = qualified(schemaName, 'users')
  const establishments = qualified(schemaName, ESTABLISHMENTS)
  const bindings = qualified(schemaName, BINDINGS)
  const versionFunction = `${schema}.${quoteAdminGrantActorInputIdent(VERSION_FUNCTION)}()`
  const establishmentFunction = `${schema}.${quoteAdminGrantActorInputIdent(ESTABLISHMENT_FUNCTION)}()`
  const browserFunction = `${schema}.${quoteAdminGrantActorInputIdent(BROWSER_FUNCTION)}()`
  return [
    `ALTER TABLE ${users} ADD COLUMN local_credential_version uuid`,
    `CREATE FUNCTION ${versionFunction}
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.local_credential_version := pg_catalog.gen_random_uuid();
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
           OR NEW.local_password_set IS DISTINCT FROM OLD.local_password_set
           OR NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN
          NEW.local_credential_version := pg_catalog.gen_random_uuid();
        ELSE
          NEW.local_credential_version := OLD.local_credential_version;
        END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'ADMIN_GRANT_CREDENTIAL_VERSION_BLOCKED' USING ERRCODE = '42501';
    END;
    $fn$`,
    `CREATE TRIGGER ${quoteAdminGrantActorInputIdent(VERSION_TRIGGER)}
    BEFORE INSERT OR UPDATE ON ${users}
    FOR EACH ROW EXECUTE FUNCTION ${versionFunction}`,
    `CREATE TABLE ${establishments} (
      id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
      user_id text NOT NULL,
      credential_version uuid NOT NULL,
      kind text NOT NULL,
      source_session_id text NOT NULL,
      established_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${ESTABLISHMENTS}_pkey`)} PRIMARY KEY (id),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${ESTABLISHMENTS}_user_version_uq`)} UNIQUE (user_id, credential_version),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${ESTABLISHMENTS}_kind_chk`)} CHECK (kind = 'self_password_change'),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${ESTABLISHMENTS}_user_chk`)} CHECK (pg_catalog.char_length(user_id) > 0),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${ESTABLISHMENTS}_session_chk`)} CHECK (pg_catalog.char_length(source_session_id) > 0)
    )`,
    `CREATE FUNCTION ${establishmentFunction}
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      current_version uuid;
      ready boolean;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.kind IS DISTINCT FROM 'self_password_change'
           OR NEW.credential_version IS NULL
           OR NEW.user_id IS NULL
           OR NEW.source_session_id IS NULL
           OR pg_catalog.char_length(NEW.user_id) < 1
           OR pg_catalog.char_length(NEW.source_session_id) < 1 THEN
          RAISE EXCEPTION 'ADMIN_GRANT_CREDENTIAL_ESTABLISHMENT_BLOCKED' USING ERRCODE = '42501';
        END IF;
        SELECT u.local_credential_version,
               (u.local_password_set IS TRUE
                AND u.must_change_password IS FALSE
                AND u.password_hash IS NOT NULL
                AND u.local_credential_version IS NOT NULL
                AND u.local_credential_version = NEW.credential_version)
          INTO current_version, ready
          FROM ${users} u
         WHERE u.id = NEW.user_id
         FOR SHARE;
        IF NOT FOUND OR ready IS NOT TRUE OR current_version IS DISTINCT FROM NEW.credential_version THEN
          RAISE EXCEPTION 'ADMIN_GRANT_CREDENTIAL_ESTABLISHMENT_BLOCKED' USING ERRCODE = '42501';
        END IF;
        NEW.established_at := pg_catalog.clock_timestamp();
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'ADMIN_GRANT_CREDENTIAL_ESTABLISHMENT_BLOCKED' USING ERRCODE = '42501';
    END;
    $fn$`,
    `CREATE TRIGGER ${quoteAdminGrantActorInputIdent(ESTABLISHMENT_ROW_TRIGGER)}
    BEFORE INSERT OR UPDATE OR DELETE ON ${establishments}
    FOR EACH ROW EXECUTE FUNCTION ${establishmentFunction}`,
    `CREATE TRIGGER ${quoteAdminGrantActorInputIdent(ESTABLISHMENT_TRUNCATE_TRIGGER)}
    BEFORE TRUNCATE ON ${establishments}
    FOR EACH STATEMENT EXECUTE FUNCTION ${establishmentFunction}`,
    `CREATE TABLE ${bindings} (
      id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
      session_id text NOT NULL,
      user_id text NOT NULL,
      org_id text NOT NULL,
      origin text NOT NULL,
      nonce_digest text NOT NULL,
      established_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz NULL,
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${BINDINGS}_pkey`)} PRIMARY KEY (id),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${BINDINGS}_session_uq`)} UNIQUE (session_id),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${BINDINGS}_digest_chk`)} CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${BINDINGS}_origin_chk`)} CHECK (origin ~ '^https://[^[:space:]]+$'),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${BINDINGS}_user_chk`)} CHECK (pg_catalog.char_length(user_id) > 0),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${BINDINGS}_org_chk`)} CHECK (pg_catalog.char_length(org_id) > 0),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${BINDINGS}_session_chk`)} CHECK (pg_catalog.char_length(session_id) > 0),
      CONSTRAINT ${quoteAdminGrantActorInputIdent(`${BINDINGS}_expiry_chk`)} CHECK (expires_at > established_at)
    )`,
    `CREATE FUNCTION ${browserFunction}
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.established_at := pg_catalog.clock_timestamp();
        IF NEW.revoked_at IS NOT NULL
           OR NEW.expires_at IS NULL
           OR NEW.expires_at <= NEW.established_at THEN
          RAISE EXCEPTION 'ADMIN_GRANT_BROWSER_BINDING_BLOCKED' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.revoked_at IS NOT NULL
           OR NEW.revoked_at IS NULL
           OR NEW.id IS DISTINCT FROM OLD.id
           OR NEW.session_id IS DISTINCT FROM OLD.session_id
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.origin IS DISTINCT FROM OLD.origin
           OR NEW.nonce_digest IS DISTINCT FROM OLD.nonce_digest
           OR NEW.established_at IS DISTINCT FROM OLD.established_at
           OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
          RAISE EXCEPTION 'ADMIN_GRANT_BROWSER_BINDING_BLOCKED' USING ERRCODE = '42501';
        END IF;
        NEW.revoked_at := pg_catalog.clock_timestamp();
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'ADMIN_GRANT_BROWSER_BINDING_BLOCKED' USING ERRCODE = '42501';
    END;
    $fn$`,
    `CREATE TRIGGER ${quoteAdminGrantActorInputIdent(BROWSER_ROW_TRIGGER)}
    BEFORE INSERT OR UPDATE OR DELETE ON ${bindings}
    FOR EACH ROW EXECUTE FUNCTION ${browserFunction}`,
    `CREATE TRIGGER ${quoteAdminGrantActorInputIdent(BROWSER_TRUNCATE_TRIGGER)}
    BEFORE TRUNCATE ON ${bindings}
    FOR EACH STATEMENT EXECUTE FUNCTION ${browserFunction}`,
  ]
}

export function adminGrantActorInputDropStatements(schemaName: string): readonly string[] {
  const schema = quoteAdminGrantActorInputIdent(schemaName)
  const users = qualified(schemaName, 'users')
  const establishments = qualified(schemaName, ESTABLISHMENTS)
  const bindings = qualified(schemaName, BINDINGS)
  return [
    `DROP TRIGGER IF EXISTS ${quoteAdminGrantActorInputIdent(BROWSER_TRUNCATE_TRIGGER)} ON ${bindings}`,
    `DROP TRIGGER IF EXISTS ${quoteAdminGrantActorInputIdent(BROWSER_ROW_TRIGGER)} ON ${bindings}`,
    `DROP FUNCTION IF EXISTS ${schema}.${quoteAdminGrantActorInputIdent(BROWSER_FUNCTION)}()`,
    `DROP TABLE IF EXISTS ${bindings}`,
    `DROP TRIGGER IF EXISTS ${quoteAdminGrantActorInputIdent(ESTABLISHMENT_TRUNCATE_TRIGGER)} ON ${establishments}`,
    `DROP TRIGGER IF EXISTS ${quoteAdminGrantActorInputIdent(ESTABLISHMENT_ROW_TRIGGER)} ON ${establishments}`,
    `DROP FUNCTION IF EXISTS ${schema}.${quoteAdminGrantActorInputIdent(ESTABLISHMENT_FUNCTION)}()`,
    `DROP TABLE IF EXISTS ${establishments}`,
    `DROP TRIGGER IF EXISTS ${quoteAdminGrantActorInputIdent(VERSION_TRIGGER)} ON ${users}`,
    `DROP FUNCTION IF EXISTS ${schema}.${quoteAdminGrantActorInputIdent(VERSION_FUNCTION)}()`,
    `ALTER TABLE ${users} DROP COLUMN IF EXISTS local_credential_version`,
  ]
}

async function requireCallerTransaction(db: Kysely<unknown>): Promise<void> {
  const first = await sql<{ xid: string }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const second = await sql<{ xid: string }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const firstXid = first.rows[0]?.xid
  const secondXid = second.rows[0]?.xid
  if (typeof firstXid !== 'string' || firstXid.length === 0 || firstXid !== secondXid) {
    throw withCode(ADMIN_GRANT_ACTOR_INPUTS_TRANSACTION_CODE)
  }
  const isolation = await sql<{ isolation: string }>`
    SELECT pg_catalog.current_setting('transaction_isolation') AS isolation
  `.execute(db)
  if (isolation.rows[0]?.isolation !== 'read committed') {
    throw withCode(ADMIN_GRANT_ACTOR_INPUTS_ISOLATION_CODE)
  }
}

async function resolveInstallSchema(db: Kysely<unknown>): Promise<string> {
  const found = await sql<{ schema_name: string | null }>`
    SELECT candidate.nspname AS schema_name
      FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
     ORDER BY candidate.ord
  `.execute(db)
  for (const row of found.rows) {
    const name = row?.schema_name
    if (name === 'information_schema' || (typeof name === 'string' && name.startsWith('pg_'))) continue
    if (typeof name !== 'string' || !IDENT.test(name)) throw withCode(ADMIN_GRANT_ACTOR_INPUTS_SCHEMA_CODE)
    return name
  }
  throw withCode(ADMIN_GRANT_ACTOR_INPUTS_SCHEMA_CODE)
}

async function usersReady(db: Kysely<unknown>, schemaName: string): Promise<boolean> {
  const relation = qualified(schemaName, 'users')
  const found = await sql<{ ready: boolean }>`
    SELECT (
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class rel
          JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = ${schemaName}
           AND rel.relname = 'users'
           AND rel.relkind = 'r'
           AND rel.relpersistence = 'p'
           AND rel.oid = pg_catalog.to_regclass(${relation})
      )
      AND EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute att
          JOIN pg_catalog.pg_class rel ON rel.oid = att.attrelid
          JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = ${schemaName}
           AND rel.relname = 'users'
           AND att.attname = 'password_hash'
           AND att.attnum > 0
           AND NOT att.attisdropped
      )
      AND EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute att
          JOIN pg_catalog.pg_class rel ON rel.oid = att.attrelid
          JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = ${schemaName}
           AND rel.relname = 'users'
           AND att.attname = 'local_password_set'
           AND att.attnum > 0
           AND NOT att.attisdropped
      )
      AND EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute att
          JOIN pg_catalog.pg_class rel ON rel.oid = att.attrelid
          JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = ${schemaName}
           AND rel.relname = 'users'
           AND att.attname = 'must_change_password'
           AND att.attnum > 0
           AND NOT att.attisdropped
      )
    ) AS ready
  `.execute(db)
  return found.rows[0]?.ready === true
}

type PresentObjects = {
  column: boolean
  establishments: boolean
  bindings: boolean
  versionFunction: boolean
  establishmentFunction: boolean
  browserFunction: boolean
  versionTrigger: boolean
}

async function presentObjects(db: Kysely<unknown>, schemaName: string): Promise<PresentObjects> {
  const found = await sql<{
    column: boolean
    establishments: boolean
    bindings: boolean
    version_function: boolean
    establishment_function: boolean
    browser_function: boolean
    version_trigger: boolean
  }>`
    SELECT
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute att
          JOIN pg_catalog.pg_class rel ON rel.oid = att.attrelid
          JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = ${schemaName}
           AND rel.relname = 'users'
           AND att.attname = 'local_credential_version'
           AND att.attnum > 0
           AND NOT att.attisdropped
      ) AS column,
      (pg_catalog.to_regclass(${qualified(schemaName, ESTABLISHMENTS)}) IS NOT NULL) AS establishments,
      (pg_catalog.to_regclass(${qualified(schemaName, BINDINGS)}) IS NOT NULL) AS bindings,
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc proc
          JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
         WHERE ns.nspname = ${schemaName}
           AND proc.proname = ${VERSION_FUNCTION}
      ) AS version_function,
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc proc
          JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
         WHERE ns.nspname = ${schemaName}
           AND proc.proname = ${ESTABLISHMENT_FUNCTION}
      ) AS establishment_function,
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc proc
          JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
         WHERE ns.nspname = ${schemaName}
           AND proc.proname = ${BROWSER_FUNCTION}
      ) AS browser_function,
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger tg
          JOIN pg_catalog.pg_class rel ON rel.oid = tg.tgrelid
          JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = ${schemaName}
           AND rel.relname = 'users'
           AND tg.tgname = ${VERSION_TRIGGER}
           AND NOT tg.tgisinternal
      ) AS version_trigger
  `.execute(db)
  const row = found.rows[0]
  return {
    column: row?.column === true,
    establishments: row?.establishments === true,
    bindings: row?.bindings === true,
    versionFunction: row?.version_function === true,
    establishmentFunction: row?.establishment_function === true,
    browserFunction: row?.browser_function === true,
    versionTrigger: row?.version_trigger === true,
  }
}

async function lockPresent(db: Kysely<unknown>, schemaName: string, present: PresentObjects): Promise<void> {
  if (present.column || present.versionTrigger) {
    await sql.raw(`LOCK TABLE ${qualified(schemaName, 'users')} IN ACCESS EXCLUSIVE MODE`).execute(db)
  }
  if (present.bindings) {
    await sql.raw(`LOCK TABLE ${qualified(schemaName, BINDINGS)} IN ACCESS EXCLUSIVE MODE`).execute(db)
  }
  if (present.establishments) {
    await sql.raw(`LOCK TABLE ${qualified(schemaName, ESTABLISHMENTS)} IN ACCESS EXCLUSIVE MODE`).execute(db)
  }
}

async function retainedHistory(db: Kysely<unknown>, schemaName: string, present: PresentObjects): Promise<boolean> {
  const checks: string[] = []
  if (present.column) {
    checks.push(`EXISTS (SELECT 1 FROM ${qualified(schemaName, 'users')} WHERE local_credential_version IS NOT NULL)`)
  }
  if (present.bindings) checks.push(`EXISTS (SELECT 1 FROM ${qualified(schemaName, BINDINGS)})`)
  if (present.establishments) checks.push(`EXISTS (SELECT 1 FROM ${qualified(schemaName, ESTABLISHMENTS)})`)
  if (checks.length === 0) return false
  const found = await sql<{ retained: boolean }>`SELECT (${sql.raw(checks.join(' OR '))}) AS retained`.execute(db)
  return found.rows[0]?.retained === true
}

function selectedDrops(statements: readonly string[], present: PresentObjects): string[] {
  const version: string[] = []
  if (present.column) version.push(...statements.slice(8))
  else {
    if (present.versionTrigger) version.push(statements[8])
    if (present.versionFunction) version.push(statements[9])
  }
  return [
    ...(present.bindings ? statements.slice(0, 4) : present.browserFunction ? [statements[2]] : []),
    ...(present.establishments ? statements.slice(4, 8) : present.establishmentFunction ? [statements[6]] : []),
    ...version,
  ]
}

async function dropInstalled(db: Kysely<unknown>, schemaName: string, present: PresentObjects): Promise<void> {
  const selected = selectedDrops(adminGrantActorInputDropStatements(schemaName), present)
  for (const statement of selected) await sql.raw(statement).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await requireCallerTransaction(db)
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  try {
    const schemaName = await resolveInstallSchema(db)
    if (!(await usersReady(db, schemaName))) throw withCode(ADMIN_GRANT_ACTOR_INPUTS_SCHEMA_CODE)
    for (const statement of adminGrantActorInputUpStatements(schemaName)) {
      await sql.raw(statement).execute(db)
    }
  } finally {
    await restoreMigrationTimeouts(db, previous)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await requireCallerTransaction(db)
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  try {
    const schemaName = await resolveInstallSchema(db)
    const present = await presentObjects(db, schemaName)
    if (!present.column && !present.establishments && !present.bindings
      && !present.versionFunction && !present.establishmentFunction && !present.browserFunction
      && !present.versionTrigger) return
    await lockPresent(db, schemaName, present)
    if (await retainedHistory(db, schemaName, present)) throw withCode(ADMIN_GRANT_ACTOR_INPUTS_DOWN_BLOCKED_CODE)
    await dropInstalled(db, schemaName, present)
  } finally {
    await restoreMigrationTimeouts(db, previous)
  }
}
