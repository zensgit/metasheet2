import { sql, type Kysely } from 'kysely'

const MIGRATION_LOCK_TIMEOUT = '5s'
const MIGRATION_STATEMENT_TIMEOUT = '5min'
const PARENT_BUMP_REFUSED = 'admin grant first birth parent bump refused'

export const ADMIN_GRANT_FIRST_BIRTH_UP_BLOCKED_CODE = 'ADMIN_GRANT_FIRST_BIRTH_UP_BLOCKED'
export const ADMIN_GRANT_FIRST_BIRTH_DOWN_BLOCKED_CODE = 'ADMIN_GRANT_FIRST_BIRTH_DOWN_BLOCKED'
export const ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_TRANSACTION_CODE = 'ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_TRANSACTION'
export const ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_TRANSACTION_CODE = 'ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_TRANSACTION'
export const ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_READ_COMMITTED_CODE = 'ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_READ_COMMITTED'
export const ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_READ_COMMITTED_CODE = 'ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_READ_COMMITTED'
export const ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE = 'ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_MISSING'
export const ADMIN_GRANT_FIRST_BIRTH_DOWN_PREREQUISITE_CODE = 'ADMIN_GRANT_FIRST_BIRTH_DOWN_PREREQUISITE_MISSING'

const RECEIVING_RELATIONS = [
  'directory_connection_application_pins',
  'user_external_identity_binding_pins',
  'user_external_identity_evidence',
] as const

type MigrationTimeouts = { lock_timeout: string; statement_timeout: string }
type Direction = 'up' | 'down'
type DirectionCodes = {
  transaction: string
  isolation: string
  blocked: string
  prerequisite: string
  verb: 'up()' | 'down()'
}
type ForeignKeyShape = {
  constraint: string
  table: string
  fromColumn: string
  target: string
  deleteAction: string
}
type WritableColumn = { table: string; column: string }
type UpdateTriggerShape = { table: string; trigger: string; functionName: string }

const FOREIGN_KEYS: readonly ForeignKeyShape[] = [
  {
    constraint: 'directory_connection_application_pins_connection_fk',
    table: 'directory_connection_application_pins',
    fromColumn: 'connection_id',
    target: 'directory_integrations',
    deleteAction: 'r',
  },
  {
    constraint: 'user_external_identity_binding_pins_identity_fk',
    table: 'user_external_identity_binding_pins',
    fromColumn: 'identity_id',
    target: 'user_external_identities',
    deleteAction: 'c',
  },
  {
    constraint: 'user_external_identity_evidence_live_identity_fk',
    table: 'user_external_identity_evidence',
    fromColumn: 'live_identity_id',
    target: 'user_external_identities',
    deleteAction: 'r',
  },
  {
    constraint: 'user_external_identity_evidence_connection_fk',
    table: 'user_external_identity_evidence',
    fromColumn: 'connection_id',
    target: 'directory_integrations',
    deleteAction: 'r',
  },
]

const WRITABLE_COLUMNS: readonly WritableColumn[] = [
  { table: 'directory_integrations', column: 'schedule_cron' },
  { table: 'user_external_identities', column: 'profile' },
]

const S2_UPDATE_TRIGGERS: readonly UpdateTriggerShape[] = [
  {
    table: 'directory_integrations',
    trigger: 'admin_grant_integration_invalidate',
    functionName: 'admin_grant_integration_invalidate',
  },
  {
    table: 'user_external_identities',
    trigger: 'admin_grant_identity_invalidate',
    functionName: 'admin_grant_identity_invalidate',
  },
]

const ADMIT_TRIGGERS: ReadonlyArray<{ trigger: string; table: string }> = [
  { trigger: 'admin_grant_application_pin_admit', table: 'directory_connection_application_pins' },
  { trigger: 'admin_grant_binding_pin_admit', table: 'user_external_identity_binding_pins' },
  { trigger: 'admin_grant_evidence_admit', table: 'user_external_identity_evidence' },
]

function directionCodes(direction: Direction): DirectionCodes {
  if (direction === 'up') {
    return {
      transaction: ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_TRANSACTION_CODE,
      isolation: ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_READ_COMMITTED_CODE,
      blocked: ADMIN_GRANT_FIRST_BIRTH_UP_BLOCKED_CODE,
      prerequisite: ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE,
      verb: 'up()',
    }
  }
  return {
    transaction: ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_TRANSACTION_CODE,
    isolation: ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_READ_COMMITTED_CODE,
    blocked: ADMIN_GRANT_FIRST_BIRTH_DOWN_BLOCKED_CODE,
    prerequisite: ADMIN_GRANT_FIRST_BIRTH_DOWN_PREREQUISITE_CODE,
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
  return code === ADMIN_GRANT_FIRST_BIRTH_UP_BLOCKED_CODE
    || code === ADMIN_GRANT_FIRST_BIRTH_DOWN_BLOCKED_CODE
    || code === ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_TRANSACTION_CODE
    || code === ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_TRANSACTION_CODE
    || code === ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_READ_COMMITTED_CODE
    || code === ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_READ_COMMITTED_CODE
    || code === ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE
    || code === ADMIN_GRANT_FIRST_BIRTH_DOWN_PREREQUISITE_CODE
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

async function requireCallerTransaction(db: Kysely<unknown>, direction: Direction): Promise<void> {
  const selected = directionCodes(direction)
  const first = await sql<{ xid: string }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const second = await sql<{ xid: string }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const firstXid = first.rows[0]?.xid
  const secondXid = second.rows[0]?.xid
  if (typeof firstXid !== 'string' || firstXid.length === 0 || firstXid !== secondXid) {
    fail(
      selected.transaction,
      `${selected.verb} requires an open caller transaction so its ACCESS EXCLUSIVE locks stay held through the empty check. A plain autocommit invocation changes nothing.`,
    )
  }
  const isolation = await sql<{ isolation: string }>`
    SELECT current_setting('transaction_isolation') AS isolation
  `.execute(db)
  if (isolation.rows[0]?.isolation !== 'read committed') {
    fail(
      selected.isolation,
      `${selected.verb} requires read committed before it locks, checks, or changes objects. Repeatable read, serializable, and every other isolation are refused and change nothing.`,
    )
  }
}

async function resolveInstallSchema(db: Kysely<unknown>, prerequisite: string): Promise<string> {
  const path = await sql<{ schema_name: string | null }>`
    SELECT path.nspname AS schema_name
      FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS path(nspname, ordinality)
     ORDER BY path.ordinality
     LIMIT 1
  `.execute(db)
  const schemaName = path.rows[0]?.schema_name
  if (typeof schemaName !== 'string' || schemaName.length === 0) {
    fail(prerequisite, 'admin grant first birth prerequisites refused. Nothing was changed.')
  }
  return schemaName
}

async function receivingTablesPresent(db: Kysely<unknown>, schemaName: string): Promise<boolean> {
  const result = await sql<{
    application_pins: string | null
    binding_pins: string | null
    evidence: string | null
  }>`
    SELECT
      to_regclass(${qualified(schemaName, 'directory_connection_application_pins')})::text AS application_pins,
      to_regclass(${qualified(schemaName, 'user_external_identity_binding_pins')})::text AS binding_pins,
      to_regclass(${qualified(schemaName, 'user_external_identity_evidence')})::text AS evidence
  `.execute(db)
  const row = result.rows[0]
  return Boolean(row?.application_pins && row.binding_pins && row.evidence)
}

async function lockReceiving(db: Kysely<unknown>, schemaName: string): Promise<void> {
  for (const relation of RECEIVING_RELATIONS) {
    await exec(db, `LOCK TABLE ${qualified(schemaName, relation)} IN ACCESS EXCLUSIVE MODE`)
  }
}

async function foreignKeyMatches(
  db: Kysely<unknown>,
  schemaName: string,
  foreignKey: ForeignKeyShape,
): Promise<boolean> {
  const sourceName = qualified(schemaName, foreignKey.table)
  const targetName = qualified(schemaName, foreignKey.target)
  const result = await sql<{ matched: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class source ON source.oid = con.conrelid
        JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
        JOIN pg_catalog.pg_class target ON target.oid = con.confrelid
        JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
       WHERE con.contype = 'f'
         AND con.conname = ${foreignKey.constraint}
         AND source.oid = pg_catalog.to_regclass(${sourceName})
         AND target.oid = pg_catalog.to_regclass(${targetName})
         AND source.relname = ${foreignKey.table}
         AND source_ns.nspname = ${schemaName}
         AND target.relname = ${foreignKey.target}
         AND target_ns.nspname = source_ns.nspname
         AND con.confdeltype = ${foreignKey.deleteAction}
         AND con.convalidated
         AND NOT con.condeferrable
         AND NOT con.condeferred
         AND pg_catalog.cardinality(con.conkey) = 1
         AND pg_catalog.cardinality(con.confkey) = 1
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute att
            WHERE att.attrelid = con.conrelid
              AND att.attnum = con.conkey[1]
              AND att.attname = ${foreignKey.fromColumn}
         )
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute att
            WHERE att.attrelid = con.confrelid
              AND att.attnum = con.confkey[1]
              AND att.attname = 'id'
         )
    ) AS matched
  `.execute(db)
  return result.rows[0]?.matched === true
}

async function writableNonKeyMatches(
  db: Kysely<unknown>,
  schemaName: string,
  column: WritableColumn,
): Promise<boolean> {
  const relationName = qualified(schemaName, column.table)
  const result = await sql<{ matched: boolean }>`
    SELECT (
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute att
          JOIN pg_catalog.pg_class rel ON rel.oid = att.attrelid
          JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = ${schemaName}
           AND rel.relname = ${column.table}
           AND rel.oid = pg_catalog.to_regclass(${relationName})
           AND att.attname = ${column.column}
           AND att.attnum > 0
           AND NOT att.attisdropped
           AND att.attgenerated = ''
           AND att.attidentity = ''
      )
      AND NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_index idx
          JOIN pg_catalog.pg_class rel ON rel.oid = idx.indrelid
          JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
          JOIN pg_catalog.pg_attribute att
            ON att.attrelid = rel.oid
           AND att.attname = ${column.column}
           AND att.attnum > 0
           AND NOT att.attisdropped
         WHERE ns.nspname = ${schemaName}
           AND rel.relname = ${column.table}
           AND rel.oid = pg_catalog.to_regclass(${relationName})
           AND att.attnum = ANY (idx.indkey)
           AND (idx.indisunique OR idx.indisprimary OR idx.indisreplident)
      )
    ) AS matched
  `.execute(db)
  return result.rows[0]?.matched === true
}

async function updateTriggerMatches(
  db: Kysely<unknown>,
  schemaName: string,
  expected: UpdateTriggerShape,
): Promise<boolean> {
  const relationName = qualified(schemaName, expected.table)
  const result = await sql<{ matched: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_trigger tg
        JOIN pg_catalog.pg_class rel ON rel.oid = tg.tgrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
        JOIN pg_catalog.pg_proc proc ON proc.oid = tg.tgfoid
        JOIN pg_catalog.pg_namespace proc_ns ON proc_ns.oid = proc.pronamespace
       WHERE ns.nspname = ${schemaName}
         AND rel.relname = ${expected.table}
         AND rel.oid = pg_catalog.to_regclass(${relationName})
         AND tg.tgname = ${expected.trigger}
         AND NOT tg.tgisinternal
         AND tg.tgenabled = 'O'
         AND tg.tgtype = 17
         AND tg.tgqual IS NULL
         AND proc.proname = ${expected.functionName}
         AND proc_ns.nspname = ns.nspname
    ) AS matched
  `.execute(db)
  return result.rows[0]?.matched === true
}

async function definitiveInstallMatches(db: Kysely<unknown>, schemaName: string): Promise<boolean> {
  for (const foreignKey of FOREIGN_KEYS) {
    if (!(await foreignKeyMatches(db, schemaName, foreignKey))) return false
  }
  for (const column of WRITABLE_COLUMNS) {
    if (!(await writableNonKeyMatches(db, schemaName, column))) return false
  }
  for (const expected of S2_UPDATE_TRIGGERS) {
    if (!(await updateTriggerMatches(db, schemaName, expected))) return false
  }
  return true
}

async function receivingHoldsRow(db: Kysely<unknown>, schemaName: string): Promise<boolean> {
  const applicationPins = qualified(schemaName, 'directory_connection_application_pins')
  const bindingPins = qualified(schemaName, 'user_external_identity_binding_pins')
  const evidence = qualified(schemaName, 'user_external_identity_evidence')
  const result = await sql<{ held: boolean }>`
    SELECT (
      EXISTS (SELECT 1 FROM ${sql.raw(applicationPins)})
      OR EXISTS (SELECT 1 FROM ${sql.raw(bindingPins)})
      OR EXISTS (SELECT 1 FROM ${sql.raw(evidence)})
    ) AS held
  `.execute(db)
  return result.rows[0]?.held === true
}

function admitBody(schemaName: string): string {
  const schemaLiteral = dollarLiteral(schemaName, 'agr_s3_schema')
  return `DECLARE
  install_schema text := ${schemaLiteral};
  affected integer;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM install_schema THEN
    RAISE EXCEPTION '${PARENT_BUMP_REFUSED}' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'directory_connection_application_pins' THEN
    EXECUTE format(
      'UPDATE %I.%I SET schedule_cron = schedule_cron WHERE id = $1',
      install_schema,
      'directory_integrations'
    ) USING NEW.connection_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION '${PARENT_BUMP_REFUSED}' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'user_external_identity_binding_pins' THEN
    EXECUTE format(
      'UPDATE %I.%I SET profile = profile WHERE id = $1',
      install_schema,
      'user_external_identities'
    ) USING NEW.identity_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION '${PARENT_BUMP_REFUSED}' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'user_external_identity_evidence' THEN
    EXECUTE format(
      'UPDATE %I.%I SET schedule_cron = schedule_cron WHERE id = $1',
      install_schema,
      'directory_integrations'
    ) USING NEW.connection_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION '${PARENT_BUMP_REFUSED}' USING ERRCODE = '55000';
    END IF;
    EXECUTE format(
      'UPDATE %I.%I SET profile = profile WHERE id = $1',
      install_schema,
      'user_external_identities'
    ) USING NEW.live_identity_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION '${PARENT_BUMP_REFUSED}' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION '${PARENT_BUMP_REFUSED}' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END`
}

async function createFirstBirth(db: Kysely<unknown>, schemaName: string): Promise<void> {
  const body = admitBody(schemaName)
  const bodyTag = dollarTag(body, 'agr_s3_body')
  await exec(
    db,
    `CREATE FUNCTION ${qualified(schemaName, 'admin_grant_receiving_admit')}() RETURNS trigger
     LANGUAGE plpgsql
     SET search_path = pg_catalog, ${quoteIdent(schemaName)}, pg_temp
     AS $${bodyTag}$
${body}
     $${bodyTag}$`,
  )
  for (const item of ADMIT_TRIGGERS) {
    await exec(
      db,
      `CREATE TRIGGER ${quoteIdent(item.trigger)}
         AFTER INSERT ON ${qualified(schemaName, item.table)}
         FOR EACH ROW EXECUTE FUNCTION ${qualified(schemaName, 'admin_grant_receiving_admit')}()`,
    )
  }
}

async function dropFirstBirth(db: Kysely<unknown>, schemaName: string): Promise<void> {
  for (const item of ADMIT_TRIGGERS) {
    await exec(db, `DROP TRIGGER ${quoteIdent(item.trigger)} ON ${qualified(schemaName, item.table)}`)
  }
  await exec(db, `DROP FUNCTION ${qualified(schemaName, 'admin_grant_receiving_admit')}()`)
}

async function prepareEmptyInstall(db: Kysely<unknown>, direction: Direction): Promise<string> {
  const selected = directionCodes(direction)
  const schemaName = await resolveInstallSchema(db, selected.prerequisite)
  if (!(await receivingTablesPresent(db, schemaName))) {
    fail(selected.prerequisite, 'admin grant first birth prerequisites refused. Nothing was changed.')
  }
  await lockReceiving(db, schemaName)
  if (!(await definitiveInstallMatches(db, schemaName))) {
    fail(selected.prerequisite, 'admin grant first birth prerequisites refused. Nothing was changed.')
  }
  if (await receivingHoldsRow(db, schemaName)) {
    fail(
      selected.blocked,
      `${selected.verb} refused while an admin grant receiving table holds a row. Nothing was changed.`,
    )
  }
  return schemaName
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
    const schemaName = await prepareEmptyInstall(db, 'up')
    await createFirstBirth(db, schemaName)
  })
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await requireCallerTransaction(db, 'down')
  await withTimeouts(db, async () => {
    const schemaName = await prepareEmptyInstall(db, 'down')
    await dropFirstBirth(db, schemaName)
  })
}
