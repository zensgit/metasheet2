/**
 * Challenge history for the current-application target ceremony.
 * up() and down() both require one caller-owned read committed transaction.
 * Function bodies use a dollar-quote tag generated from the body.
 * S1, S2, and S3 objects stay. This file grants nothing and mounts nothing.
 */
import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export const ADMIN_GRANT_TARGET_CEREMONY_UP_REQUIRES_TRANSACTION_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_UP_REQUIRES_TRANSACTION'
export const ADMIN_GRANT_TARGET_CEREMONY_DOWN_REQUIRES_TRANSACTION_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_DOWN_REQUIRES_TRANSACTION'
export const ADMIN_GRANT_TARGET_CEREMONY_UP_REPEATABLE_READ_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_UP_REPEATABLE_READ'
export const ADMIN_GRANT_TARGET_CEREMONY_DOWN_REPEATABLE_READ_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_DOWN_REPEATABLE_READ'
export const ADMIN_GRANT_TARGET_CEREMONY_UP_SERIALIZABLE_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_UP_SERIALIZABLE'
export const ADMIN_GRANT_TARGET_CEREMONY_DOWN_SERIALIZABLE_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_DOWN_SERIALIZABLE'
export const ADMIN_GRANT_TARGET_CEREMONY_UP_ISOLATION_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_UP_ISOLATION'
export const ADMIN_GRANT_TARGET_CEREMONY_DOWN_ISOLATION_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_DOWN_ISOLATION'
export const ADMIN_GRANT_TARGET_CEREMONY_UP_BLOCKED_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_UP_BLOCKED'
export const ADMIN_GRANT_TARGET_CEREMONY_DOWN_BLOCKED_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_DOWN_BLOCKED'
export const ADMIN_GRANT_TARGET_CEREMONY_UP_PREREQUISITE_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_UP_PREREQUISITE_MISSING'
export const ADMIN_GRANT_TARGET_CEREMONY_DOWN_PREREQUISITE_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_DOWN_PREREQUISITE_MISSING'
export const ADMIN_GRANT_TARGET_CEREMONY_UP_SCHEMA_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_UP_SCHEMA'
export const ADMIN_GRANT_TARGET_CEREMONY_DOWN_SCHEMA_CODE = 'ADMIN_GRANT_TARGET_CEREMONY_DOWN_SCHEMA'

const CHALLENGE = 'admin_grant_target_ceremony_challenges'
const GUARD = 'admin_grant_target_ceremony_challenge_guard'
const ROW_TRIGGER = 'admin_grant_target_ceremony_challenge_row'
const TRUNCATE_TRIGGER = 'admin_grant_target_ceremony_challenge_truncate'
const LINEAGE = 'admin_grant_evidence_ceremony_lineage'
const PRODUCER_ID = 'current_app_target_ceremony'
const SUCCESSOR = 'admin_grant_application_successor'
const ADMIT = 'admin_grant_receiving_admit'

const RECEIVING_TABLES = [
  'directory_connection_application_pins',
  'user_external_identity_binding_pins',
  'user_external_identity_evidence',
] as const

const ADMIT_TRIGGERS = [
  { trigger: 'admin_grant_application_pin_admit', table: 'directory_connection_application_pins' },
  { trigger: 'admin_grant_binding_pin_admit', table: 'user_external_identity_binding_pins' },
  { trigger: 'admin_grant_evidence_admit', table: 'user_external_identity_evidence' },
] as const

const IMMUTABLE_COLUMNS = [
  'state_hash',
  'browser_hash',
  'target_user_id',
  'session_id',
  'org_id',
  'connection_id',
  'identity_id',
  'provider',
  'corp_id',
  'app_scope',
  'subject_key',
  'application_revision',
  'binding_revision',
  'material_fingerprint',
  'capability_revision_seen',
  'access_generation',
  'privilege_witness',
  'privilege_class',
  'privilege_reasons',
  'slot_snapshot',
  'token_issued_at',
  'watermark_us',
  'created_at',
  'expires_at',
] as const

type Direction = 'up' | 'down'

type DirectionCodes = {
  transaction: string
  repeatableRead: string
  serializable: string
  isolation: string
  blocked: string
  prerequisite: string
  schema: string
  verb: 'up()' | 'down()'
}

function directionCodes(direction: Direction): DirectionCodes {
  if (direction === 'up') {
    return {
      transaction: ADMIN_GRANT_TARGET_CEREMONY_UP_REQUIRES_TRANSACTION_CODE,
      repeatableRead: ADMIN_GRANT_TARGET_CEREMONY_UP_REPEATABLE_READ_CODE,
      serializable: ADMIN_GRANT_TARGET_CEREMONY_UP_SERIALIZABLE_CODE,
      isolation: ADMIN_GRANT_TARGET_CEREMONY_UP_ISOLATION_CODE,
      blocked: ADMIN_GRANT_TARGET_CEREMONY_UP_BLOCKED_CODE,
      prerequisite: ADMIN_GRANT_TARGET_CEREMONY_UP_PREREQUISITE_CODE,
      schema: ADMIN_GRANT_TARGET_CEREMONY_UP_SCHEMA_CODE,
      verb: 'up()',
    }
  }
  return {
    transaction: ADMIN_GRANT_TARGET_CEREMONY_DOWN_REQUIRES_TRANSACTION_CODE,
    repeatableRead: ADMIN_GRANT_TARGET_CEREMONY_DOWN_REPEATABLE_READ_CODE,
    serializable: ADMIN_GRANT_TARGET_CEREMONY_DOWN_SERIALIZABLE_CODE,
    isolation: ADMIN_GRANT_TARGET_CEREMONY_DOWN_ISOLATION_CODE,
    blocked: ADMIN_GRANT_TARGET_CEREMONY_DOWN_BLOCKED_CODE,
    prerequisite: ADMIN_GRANT_TARGET_CEREMONY_DOWN_PREREQUISITE_CODE,
    schema: ADMIN_GRANT_TARGET_CEREMONY_DOWN_SCHEMA_CODE,
    verb: 'down()',
  }
}

function fail(code: string, message: string): never {
  const error = new Error(`${code}: ${message}`)
  ;(error as Error & { code?: string }).code = code
  throw error
}

function isRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === ADMIN_GRANT_TARGET_CEREMONY_UP_REQUIRES_TRANSACTION_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_DOWN_REQUIRES_TRANSACTION_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_UP_REPEATABLE_READ_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_DOWN_REPEATABLE_READ_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_UP_SERIALIZABLE_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_DOWN_SERIALIZABLE_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_UP_ISOLATION_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_DOWN_ISOLATION_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_UP_BLOCKED_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_DOWN_BLOCKED_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_UP_PREREQUISITE_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_DOWN_PREREQUISITE_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_UP_SCHEMA_CODE
    || code === ADMIN_GRANT_TARGET_CEREMONY_DOWN_SCHEMA_CODE
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function qualified(schemaName: string, identifier: string): string {
  return `${quoteIdent(schemaName)}.${quoteIdent(identifier)}`
}

function dollarTag(value: string, seed: string): string {
  let tag = seed
  let counter = 0
  while (value.includes(`$${tag}$`)) {
    counter += 1
    tag = `${seed}_${counter}`
  }
  return tag
}

function dollarLiteral(value: string, seed: string): string {
  const tag = dollarTag(value, seed)
  return `$${tag}$${value}$${tag}$`
}

async function exec(db: Kysely<unknown>, statement: string): Promise<void> {
  await sql.raw(statement).execute(db)
}

async function requireCallerTransaction(db: Kysely<unknown>, direction: Direction): Promise<void> {
  const selected = directionCodes(direction)
  const first = await sql<{ xid: string | null }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const second = await sql<{ xid: string | null }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const firstXid = first.rows[0]?.xid
  const secondXid = second.rows[0]?.xid
  if (typeof firstXid !== 'string' || firstXid.length === 0 || firstXid !== secondXid) {
    fail(selected.transaction, `${selected.verb} requires an open caller transaction. An autocommit invocation changes nothing.`)
  }
  const isolation = await sql<{ isolation: string | null }>`
    SELECT current_setting('transaction_isolation') AS isolation
  `.execute(db)
  const level = isolation.rows[0]?.isolation
  if (level === 'read committed') return
  if (level === 'repeatable read') {
    fail(selected.repeatableRead, `${selected.verb} refuses repeatable read and changes nothing.`)
  }
  if (level === 'serializable') {
    fail(selected.serializable, `${selected.verb} refuses serializable and changes nothing.`)
  }
  fail(selected.isolation, `${selected.verb} requires read committed and changes nothing.`)
}

async function resolveInstallSchema(db: Kysely<unknown>, schemaCode: string): Promise<string> {
  const path = await sql<{ schema_name: string | null }>`
    SELECT path.nspname AS schema_name
      FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS path(nspname, ordinality)
     ORDER BY path.ordinality
     LIMIT 1
  `.execute(db)
  const schemaName = path.rows[0]?.schema_name
  if (typeof schemaName !== 'string' || schemaName.length === 0 || schemaName.startsWith('pg_') || schemaName === 'information_schema') {
    fail(schemaCode, 'admin grant target ceremony schema refused. Nothing was changed.')
  }
  return schemaName
}

async function relationPresent(db: Kysely<unknown>, schemaName: string, relation: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass(${qualified(schemaName, relation)}) IS NOT NULL AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

async function functionPresent(db: Kysely<unknown>, schemaName: string, name: string, identityArguments: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc proc
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
       WHERE namespace.nspname = ${schemaName}
         AND proc.proname = ${name}
         AND pg_catalog.pg_get_function_identity_arguments(proc.oid) = ${identityArguments}
    ) AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

async function triggerPresent(db: Kysely<unknown>, schemaName: string, table: string, trigger: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_trigger trigger
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = ${schemaName}
         AND relation.relname = ${table}
         AND trigger.tgname = ${trigger}
         AND NOT trigger.tgisinternal
    ) AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

async function requireUpPrerequisites(db: Kysely<unknown>, schemaName: string): Promise<void> {
  const selected = directionCodes('up')
  for (const relation of RECEIVING_TABLES) {
    if (!(await relationPresent(db, schemaName, relation))) {
      fail(selected.prerequisite, 'admin grant target ceremony prerequisites refused. Nothing was changed.')
    }
  }
  if (!(await relationPresent(db, schemaName, 'directory_integrations'))) {
    fail(selected.prerequisite, 'admin grant target ceremony prerequisites refused. Nothing was changed.')
  }
  if (!(await functionPresent(db, schemaName, SUCCESSOR, 'revision text'))) {
    fail(selected.prerequisite, 'admin grant target ceremony prerequisites refused. Nothing was changed.')
  }
  for (const item of ADMIT_TRIGGERS) {
    if (!(await triggerPresent(db, schemaName, item.table, item.trigger))) {
      fail(selected.prerequisite, 'admin grant target ceremony prerequisites refused. Nothing was changed.')
    }
    const owner = await sql<{ present: boolean }>`
      SELECT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger trigger
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_proc proc ON proc.oid = trigger.tgfoid
          JOIN pg_catalog.pg_namespace proc_namespace ON proc_namespace.oid = proc.pronamespace
         WHERE namespace.nspname = ${schemaName}
           AND proc_namespace.nspname = ${schemaName}
           AND relation.relname = ${item.table}
           AND trigger.tgname = ${item.trigger}
           AND proc.proname = ${ADMIT}
      ) AS present
    `.execute(db)
    if (owner.rows[0]?.present !== true) {
      fail(selected.prerequisite, 'admin grant target ceremony prerequisites refused. Nothing was changed.')
    }
  }
}

function insertGuardSql(): string {
  const required = IMMUTABLE_COLUMNS.map((column) => `NEW.${column} IS NULL`).join('\n       OR ')
  return `IF NEW.exchange_claimed_at IS NOT NULL
     OR NEW.consumed_evidence_id IS NOT NULL
     OR NEW.consumed_at IS NOT NULL
     OR ${required}
     OR NEW.created_at > pg_catalog.clock_timestamp()
     OR NEW.created_at <= pg_catalog.clock_timestamp() - interval '5 seconds'
     OR NEW.expires_at IS DISTINCT FROM NEW.created_at + interval '5 minutes'
     OR NEW.provider IS DISTINCT FROM 'dingtalk'
     OR NEW.privilege_class IS DISTINCT FROM 'standard'
     OR NEW.privilege_reasons IS DISTINCT FROM '[]'::jsonb
     OR NEW.state_hash !~ '^[0-9a-f]{64}$'
     OR NEW.browser_hash !~ '^[0-9a-f]{64}$'
     OR NEW.material_fingerprint !~ '^[0-9a-f]{64}$'
     OR NEW.privilege_witness !~ '^[0-9a-f]{64}$'
     OR NEW.application_revision !~ '^(0|[1-9][0-9]*)$'
     OR NEW.binding_revision !~ '^(0|[1-9][0-9]*)$'
     OR NEW.capability_revision_seen !~ '^(0|[1-9][0-9]*)$'
     OR NEW.access_generation !~ '^(0|[1-9][0-9]*)$'
     OR NEW.token_issued_at !~ '^[1-9][0-9]*$'
     OR NEW.watermark_us !~ '^(0|[1-9][0-9]*)$'
     OR NEW.corp_id = ''
     OR NEW.app_scope = ''
     OR NEW.subject_key = ''
     OR NEW.identity_id = ''
     OR NEW.target_user_id = ''
     OR NEW.session_id = ''
     OR NEW.org_id = ''
     OR pg_catalog.jsonb_typeof(NEW.slot_snapshot) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(NEW.slot_snapshot)) IS DISTINCT FROM 6
     OR NOT (
       NEW.slot_snapshot ? 'corpId'
       AND NEW.slot_snapshot ? 'externalKey'
       AND NEW.slot_snapshot ? 'localUserId'
       AND NEW.slot_snapshot ? 'provider'
       AND NEW.slot_snapshot ? 'providerOpenId'
       AND NEW.slot_snapshot ? 'providerUnionId'
     )
     OR pg_catalog.jsonb_typeof(NEW.slot_snapshot -> 'corpId') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(NEW.slot_snapshot -> 'externalKey') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(NEW.slot_snapshot -> 'localUserId') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(NEW.slot_snapshot -> 'provider') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(NEW.slot_snapshot -> 'providerOpenId') IS DISTINCT FROM 'string'
     OR (
       pg_catalog.jsonb_typeof(NEW.slot_snapshot -> 'providerUnionId') IS DISTINCT FROM 'string'
       AND pg_catalog.jsonb_typeof(NEW.slot_snapshot -> 'providerUnionId') IS DISTINCT FROM 'null'
     ) THEN
    RAISE EXCEPTION 'admin grant target ceremony insert refused' USING ERRCODE = '55000';
  END IF;`
}

function challengeGuardBody(): string {
  const immutable = IMMUTABLE_COLUMNS.map((column) => `NEW.${column} IS DISTINCT FROM OLD.${column}`).join('\n         OR ')
  return `BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'admin grant target ceremony truncate refused' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin grant target ceremony delete refused' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    ${insertGuardSql()}
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ${immutable} THEN
      RAISE EXCEPTION 'admin grant target ceremony mutation refused' USING ERRCODE = '55000';
    END IF;
    IF OLD.exchange_claimed_at IS NULL
       AND NEW.exchange_claimed_at IS NOT NULL
       AND OLD.consumed_evidence_id IS NULL
       AND NEW.consumed_evidence_id IS NULL
       AND OLD.consumed_at IS NULL
       AND NEW.consumed_at IS NULL
       AND NEW.exchange_claimed_at <= pg_catalog.clock_timestamp()
       AND NEW.exchange_claimed_at > pg_catalog.clock_timestamp() - interval '5 seconds' THEN
      RETURN NEW;
    END IF;
    IF OLD.exchange_claimed_at IS NOT NULL
       AND NEW.exchange_claimed_at IS NOT DISTINCT FROM OLD.exchange_claimed_at
       AND OLD.consumed_evidence_id IS NULL
       AND NEW.consumed_evidence_id IS NOT NULL
       AND OLD.consumed_at IS NULL
       AND NEW.consumed_at IS NOT NULL
       AND NEW.consumed_at <= pg_catalog.clock_timestamp()
       AND NEW.consumed_at > pg_catalog.clock_timestamp() - interval '5 seconds' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'admin grant target ceremony transition refused' USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'admin grant target ceremony mutation refused' USING ERRCODE = '55000';
END`
}

function lineageBody(schemaName: string): string {
  const schemaLiteral = dollarLiteral(schemaName, 'agr_t2_schema')
  return `DECLARE
  install_schema text := ${schemaLiteral};
  challenge_count integer;
BEGIN
  IF NEW.producer_id IS DISTINCT FROM '${PRODUCER_ID}' THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT count(*) FROM %I.%I AS ceremony
      WHERE ceremony.consumed_evidence_id = $1
        AND ceremony.exchange_claimed_at IS NOT NULL
        AND ceremony.consumed_at IS NOT NULL
        AND ceremony.connection_id IS NOT DISTINCT FROM $2
        AND ceremony.org_id IS NOT DISTINCT FROM $3
        AND ceremony.identity_id IS NOT DISTINCT FROM $4
        AND ceremony.subject_key IS NOT DISTINCT FROM $5
        AND ceremony.app_scope IS NOT DISTINCT FROM $6
        AND ceremony.application_revision IS NOT DISTINCT FROM $7
        AND ceremony.binding_revision IS NOT DISTINCT FROM $8::text
        AND ceremony.material_fingerprint IS NOT DISTINCT FROM $9
        AND ceremony.capability_revision_seen IS NOT DISTINCT FROM $10::text
        AND ceremony.slot_snapshot IS NOT DISTINCT FROM $11
        AND ceremony.target_user_id IS NOT DISTINCT FROM $12
        AND $13 = ''self_authenticated''',
    install_schema,
    '${CHALLENGE}'
  )
  INTO challenge_count
  USING NEW.id, NEW.connection_id, NEW.org_id, NEW.identity_id, NEW.subject_key,
        NEW.app_scope, NEW.application_revision, NEW.binding_revision,
        NEW.material_fingerprint, NEW.capability_revision_seen, NEW.slot_snapshot,
        NEW.created_by, NEW.assurance;
  IF challenge_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'admin grant target ceremony lineage refused' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END`
}

async function createCeremony(db: Kysely<unknown>, schemaName: string): Promise<void> {
  const table = qualified(schemaName, CHALLENGE)
  const integrations = qualified(schemaName, 'directory_integrations')
  const evidence = qualified(schemaName, 'user_external_identity_evidence')
  await exec(db, `CREATE TABLE ${table} (
      state_hash text NOT NULL,
      browser_hash text NOT NULL,
      target_user_id text NOT NULL,
      session_id text NOT NULL,
      org_id text NOT NULL,
      connection_id uuid NOT NULL,
      identity_id text NOT NULL,
      provider text NOT NULL,
      corp_id text NOT NULL,
      app_scope text NOT NULL,
      subject_key text NOT NULL,
      application_revision text NOT NULL,
      binding_revision text NOT NULL,
      material_fingerprint text NOT NULL,
      capability_revision_seen text NOT NULL,
      access_generation text NOT NULL,
      privilege_witness text NOT NULL,
      privilege_class text NOT NULL,
      privilege_reasons jsonb NOT NULL,
      slot_snapshot jsonb NOT NULL,
      token_issued_at text NOT NULL,
      watermark_us text NOT NULL,
      exchange_claimed_at timestamptz,
      consumed_evidence_id text,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_pkey`)} PRIMARY KEY (state_hash),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_connection_fk`)}
        FOREIGN KEY (connection_id) REFERENCES ${integrations} (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_provider_chk`)} CHECK (provider = 'dingtalk'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_class_chk`)} CHECK (privilege_class = 'standard'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_reasons_chk`)} CHECK (privilege_reasons = '[]'::jsonb),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_fingerprint_chk`)} CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_witness_chk`)} CHECK (privilege_witness ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_state_chk`)} CHECK (state_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_browser_chk`)} CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_application_chk`)} CHECK (application_revision ~ '^(0|[1-9][0-9]*)$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_binding_chk`)} CHECK (binding_revision ~ '^(0|[1-9][0-9]*)$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_capability_chk`)} CHECK (capability_revision_seen ~ '^(0|[1-9][0-9]*)$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_generation_chk`)} CHECK (access_generation ~ '^(0|[1-9][0-9]*)$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_issued_chk`)} CHECK (token_issued_at ~ '^[1-9][0-9]*$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_watermark_chk`)} CHECK (watermark_us ~ '^(0|[1-9][0-9]*)$'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_expiry_chk`)} CHECK (expires_at = created_at + interval '5 minutes'),
      CONSTRAINT ${quoteIdent(`${CHALLENGE}_lifecycle_chk`)} CHECK (
        (exchange_claimed_at IS NULL AND consumed_evidence_id IS NULL AND consumed_at IS NULL)
        OR (exchange_claimed_at IS NOT NULL AND consumed_evidence_id IS NULL AND consumed_at IS NULL)
        OR (exchange_claimed_at IS NOT NULL AND consumed_evidence_id IS NOT NULL AND consumed_at IS NOT NULL)
      )
    )`)
  await exec(db, `CREATE UNIQUE INDEX ${quoteIdent(`${CHALLENGE}_consumed_uidx`)}
      ON ${table} (consumed_evidence_id)
      WHERE consumed_evidence_id IS NOT NULL`)
  const guard = challengeGuardBody()
  const guardTag = dollarTag(guard, 'agr_t2_guard')
  await exec(db, `CREATE FUNCTION ${qualified(schemaName, GUARD)}() RETURNS trigger
     LANGUAGE plpgsql
     SET search_path = pg_catalog
     AS $${guardTag}$
${guard}
     $${guardTag}$`)
  await exec(db, `CREATE TRIGGER ${quoteIdent(ROW_TRIGGER)}
     BEFORE INSERT OR UPDATE OR DELETE ON ${table}
     FOR EACH ROW EXECUTE FUNCTION ${qualified(schemaName, GUARD)}()`)
  await exec(db, `CREATE TRIGGER ${quoteIdent(TRUNCATE_TRIGGER)}
     BEFORE TRUNCATE ON ${table}
     FOR EACH STATEMENT EXECUTE FUNCTION ${qualified(schemaName, GUARD)}()`)
  const lineage = lineageBody(schemaName)
  const lineageTag = dollarTag(lineage, 'agr_t2_lineage')
  await exec(db, `CREATE FUNCTION ${qualified(schemaName, LINEAGE)}() RETURNS trigger
     LANGUAGE plpgsql
     SET search_path = pg_catalog, ${quoteIdent(schemaName)}, pg_temp
     AS $${lineageTag}$
${lineage}
     $${lineageTag}$`)
  await exec(db, `CREATE TRIGGER ${quoteIdent(LINEAGE)}
     BEFORE INSERT ON ${evidence}
     FOR EACH ROW EXECUTE FUNCTION ${qualified(schemaName, LINEAGE)}()`)
}

async function dropCeremony(db: Kysely<unknown>, schemaName: string): Promise<void> {
  const table = qualified(schemaName, CHALLENGE)
  const evidence = qualified(schemaName, 'user_external_identity_evidence')
  await exec(db, `DROP TRIGGER ${quoteIdent(LINEAGE)} ON ${evidence}`)
  await exec(db, `DROP TRIGGER ${quoteIdent(TRUNCATE_TRIGGER)} ON ${table}`)
  await exec(db, `DROP TRIGGER ${quoteIdent(ROW_TRIGGER)} ON ${table}`)
  await exec(db, `DROP FUNCTION ${qualified(schemaName, LINEAGE)}()`)
  await exec(db, `DROP FUNCTION ${qualified(schemaName, GUARD)}()`)
  await exec(db, `DROP TABLE ${table}`)
}

async function ceremonyObjectsPresent(db: Kysely<unknown>, schemaName: string): Promise<boolean> {
  if (!(await relationPresent(db, schemaName, CHALLENGE))) return false
  if (!(await functionPresent(db, schemaName, GUARD, ''))) return false
  if (!(await functionPresent(db, schemaName, LINEAGE, ''))) return false
  if (!(await triggerPresent(db, schemaName, CHALLENGE, ROW_TRIGGER))) return false
  if (!(await triggerPresent(db, schemaName, CHALLENGE, TRUNCATE_TRIGGER))) return false
  if (!(await triggerPresent(db, schemaName, 'user_external_identity_evidence', LINEAGE))) return false
  return true
}

async function retainedHistory(db: Kysely<unknown>, schemaName: string): Promise<boolean> {
  const table = qualified(schemaName, CHALLENGE)
  const evidence = qualified(schemaName, 'user_external_identity_evidence')
  const result = await sql<{ held: boolean }>`
    SELECT (
      EXISTS (SELECT 1 FROM ${sql.raw(table)})
      OR EXISTS (
        SELECT 1 FROM ${sql.raw(evidence)}
         WHERE producer_id = ${PRODUCER_ID}
      )
    ) AS held
  `.execute(db)
  return result.rows[0]?.held === true
}

async function withTimeouts(db: Kysely<unknown>, body: () => Promise<void>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  try {
    await body()
  } catch (error) {
    if (isRefusal(error)) await restoreMigrationTimeouts(db, previous)
    throw error
  }
  await restoreMigrationTimeouts(db, previous)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await requireCallerTransaction(db, 'up')
  await withTimeouts(db, async () => {
    const selected = directionCodes('up')
    const schemaName = await resolveInstallSchema(db, selected.schema)
    await requireUpPrerequisites(db, schemaName)
    if (await relationPresent(db, schemaName, CHALLENGE)) {
      fail(selected.blocked, 'admin grant target ceremony is already installed. Nothing was changed.')
    }
    await exec(db, `LOCK TABLE ${qualified(schemaName, 'directory_integrations')} IN ACCESS EXCLUSIVE MODE`)
    await exec(db, `LOCK TABLE ${qualified(schemaName, 'user_external_identity_evidence')} IN ACCESS EXCLUSIVE MODE`)
    if (await relationPresent(db, schemaName, CHALLENGE)) {
      fail(selected.blocked, 'admin grant target ceremony is already installed. Nothing was changed.')
    }
    await createCeremony(db, schemaName)
  })
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await requireCallerTransaction(db, 'down')
  await withTimeouts(db, async () => {
    const selected = directionCodes('down')
    const schemaName = await resolveInstallSchema(db, selected.schema)
    if (!(await relationPresent(db, schemaName, 'user_external_identity_evidence')) || !(await ceremonyObjectsPresent(db, schemaName))) {
      fail(selected.prerequisite, 'admin grant target ceremony objects are absent. Nothing was changed.')
    }
    await exec(db, `LOCK TABLE ${qualified(schemaName, CHALLENGE)} IN ACCESS EXCLUSIVE MODE`)
    await exec(db, `LOCK TABLE ${qualified(schemaName, 'user_external_identity_evidence')} IN ACCESS EXCLUSIVE MODE`)
    if (await retainedHistory(db, schemaName)) {
      fail(selected.blocked, 'admin grant target ceremony down refused while challenge or ceremony evidence history remains. Nothing was changed.')
    }
    await dropCeremony(db, schemaName)
  })
}
