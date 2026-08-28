/**
 * L4 B-RULES/B-WALLET command ledger + wallet keyset index.
 *
 * New uniquely named migration on purpose: zzzz20260828150000 is already
 * applied in local/CI catalogs and its apply path is create-or-assert with
 * no ALTER. Extending that file would fail drift on already-applied DBs.
 * This file adds only the publish-request table and the wallet listing
 * index; apply/down/replay/drift fail loud on any partial or mutated catalog.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const TABLE = 'elearning_credit_rule_requests'
const RULES_TABLE = 'elearning_credit_rules'
const DECISIONS_TABLE = 'elearning_credit_decisions'
const WALLET_INDEX = 'elearning_credit_decisions_wallet_keyset_idx'
const RULE_FK = 'elearning_credit_rule_requests_rule_fk'
const IMMUTABLE_FUNCTION = 'elearning_credit_reject_immutable_write'
const ROW_TRIGGER = 'elearning_credit_rule_requests_immutable_row'
const TRUNCATE_TRIGGER = 'elearning_credit_rule_requests_immutable_truncate'

const AUTOMATIC_BEHAVIORS = [
  'login',
  'complete_course',
  'complete_plan',
  'pass_exam',
  'submit_survey',
  'complete_map',
  'complete_offline',
] as const
const AUTOMATIC_BEHAVIOR_SQL = sql.raw(
  AUTOMATIC_BEHAVIORS.map((value) => `'${value}'`).join(', '),
)

const BEHAVIOR_CHECK_DEFINITION = `CHECK ((behavior = ANY (ARRAY[
  'login'::text,
  'complete_course'::text,
  'complete_plan'::text,
  'pass_exam'::text,
  'submit_survey'::text,
  'complete_map'::text,
  'complete_offline'::text
])))`

const EXPECTED_COLUMNS = [
  { name: 'org_id', type: 'text', nullable: false },
  { name: 'source_key', type: 'text', nullable: false },
  { name: 'request_hash', type: 'text', nullable: false },
  { name: 'request_hash_version', type: 'int2', nullable: false },
  { name: 'actor_id', type: 'text', nullable: false },
  { name: 'rule_id', type: 'text', nullable: false },
  { name: 'rule_version', type: 'int4', nullable: false },
  { name: 'behavior', type: 'text', nullable: false },
  { name: 'points', type: 'int4', nullable: false },
  { name: 'daily_cap', type: 'int4', nullable: true },
  { name: 'time_zone', type: 'text', nullable: false },
  { name: 'created_at', type: 'timestamptz', nullable: false },
] as const

const EXPECTED_CHECKS = [
  {
    table: TABLE,
    name: 'elearning_credit_rule_requests_behavior_check',
    definition: BEHAVIOR_CHECK_DEFINITION,
  },
  {
    table: TABLE,
    name: 'elearning_credit_rule_requests_hash_check',
    definition: `CHECK (((request_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash_version > 0)))`,
  },
  {
    table: TABLE,
    name: 'elearning_credit_rule_requests_identity_check',
    definition: `CHECK (((org_id <> ''::text) AND (source_key <> ''::text) AND (actor_id <> ''::text) AND (rule_id <> ''::text) AND (time_zone <> ''::text)))`,
  },
  {
    table: TABLE,
    name: 'elearning_credit_rule_requests_points_check',
    definition: `CHECK (((points > 0) AND (rule_version > 0) AND ((daily_cap IS NULL) OR (daily_cap > 0))))`,
  },
] as const

type CatalogColumn = {
  name: string
  type: string
  nullable: boolean
}

type CatalogConstraint = {
  type: string
  columns: string[]
  referenced_table: string | null
  referenced_columns: string[] | null
  deferrable: boolean
  deferred: boolean
  validated: boolean
  delete_action: string
  update_action: string
  match_type: string
}

function normalizeDefinition(value: string): string {
  return value.toLowerCase().replaceAll('"', '').replace(/\s+/g, '')
}

function drift(detail: string): never {
  throw new Error(`elearning credit rule request migration drift: ${detail}`)
}

async function tablePresent(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass(${sql.val(name)}) IS NOT NULL AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

async function indexPresent(db: Kysely<unknown>): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass(${sql.val(WALLET_INDEX)}) IS NOT NULL AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

async function immutableFunctionPresent(db: Kysely<unknown>): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regprocedure(${`${IMMUTABLE_FUNCTION}()`}) IS NOT NULL AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

async function readObjectState(db: Kysely<unknown>): Promise<{
  table: boolean
  walletIndex: boolean
}> {
  return {
    table: await tablePresent(db, TABLE),
    walletIndex: await indexPresent(db),
  }
}

async function assertColumns(db: Kysely<unknown>): Promise<void> {
  const result = await sql<CatalogColumn>`
    SELECT
      attribute.attname AS name,
      type.typname AS type,
      NOT attribute.attnotnull AS nullable
      FROM pg_attribute attribute
      JOIN pg_class table_row ON table_row.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      JOIN pg_type type ON type.oid = attribute.atttypid
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${TABLE}
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  `.execute(db)
  if (JSON.stringify(result.rows) !== JSON.stringify(EXPECTED_COLUMNS)) {
    drift(`${TABLE} columns`)
  }
}

async function readConstraint(
  db: Kysely<unknown>,
  table: string,
  name: string,
): Promise<CatalogConstraint | null> {
  const result = await sql<CatalogConstraint>`
    SELECT
      constraint_row.contype::text AS type,
      ARRAY(
        SELECT attribute.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key.attnum
         ORDER BY key.position
      )::text[] AS columns,
      referenced_table.relname AS referenced_table,
      CASE WHEN constraint_row.confkey IS NULL THEN NULL ELSE ARRAY(
        SELECT attribute.attname
          FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = key.attnum
         ORDER BY key.position
      )::text[] END AS referenced_columns,
      constraint_row.condeferrable AS deferrable,
      constraint_row.condeferred AS deferred,
      constraint_row.convalidated AS validated,
      constraint_row.confdeltype::text AS delete_action,
      constraint_row.confupdtype::text AS update_action,
      constraint_row.confmatchtype::text AS match_type
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      LEFT JOIN pg_class referenced_table ON referenced_table.oid = constraint_row.confrelid
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${table}
       AND constraint_row.conname = ${name}
  `.execute(db)
  return result.rows[0] ?? null
}

async function assertConstraint(
  db: Kysely<unknown>,
  expected: {
    table: string
    name: string
    type: 'f' | 'p' | 'u'
    columns: string[]
    referencedTable?: string
    referencedColumns?: string[]
    deleteAction?: string
    updateAction?: string
    matchType?: string
  },
): Promise<void> {
  const actual = await readConstraint(db, expected.table, expected.name)
  if (
    !actual
    || actual.type !== expected.type
    || actual.columns.join('\0') !== expected.columns.join('\0')
    || actual.referenced_table !== (expected.referencedTable ?? null)
    || (actual.referenced_columns ?? []).join('\0')
      !== (expected.referencedColumns ?? []).join('\0')
    || actual.deferrable
    || actual.deferred
    || !actual.validated
    || (expected.deleteAction !== undefined && actual.delete_action !== expected.deleteAction)
    || (expected.updateAction !== undefined && actual.update_action !== expected.updateAction)
    || (expected.matchType !== undefined && actual.match_type !== expected.matchType)
  ) {
    drift(expected.name)
  }
}

async function assertCheckConstraints(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    table: string
    name: string
    definition: string
    validated: boolean
  }>`
    SELECT
      table_row.relname AS table,
      constraint_row.conname AS name,
      pg_get_constraintdef(constraint_row.oid) AS definition,
      constraint_row.convalidated AS validated
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${TABLE}
       AND constraint_row.contype = 'c'
     ORDER BY table_row.relname, constraint_row.conname
  `.execute(db)
  const actual = result.rows.map((row) => ({
    definition: normalizeDefinition(row.definition),
    name: row.name,
    table: row.table,
    validated: row.validated,
  }))
  const expected = EXPECTED_CHECKS.map((row) => ({
    definition: normalizeDefinition(row.definition),
    name: row.name,
    table: row.table,
    validated: true,
  }))
  if (actual.length !== expected.length) drift('check constraint set')
  for (let index = 0; index < expected.length; index += 1) {
    if (JSON.stringify(actual[index]) !== JSON.stringify(expected[index])) {
      drift(`check constraint ${expected[index]?.name ?? 'unknown'}`)
    }
  }
}

async function assertWalletIndex(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    unique: boolean
    valid: boolean
    columns: string[]
    descending: boolean[]
    predicate: string | null
  }>`
    SELECT
      index_row.indisunique AS unique,
      index_row.indisvalid AS valid,
      ARRAY(
        SELECT attribute.attname
          FROM unnest(index_row.indkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = index_row.indrelid
           AND attribute.attnum = key.attnum
         WHERE key.position <= index_row.indnkeyatts
         ORDER BY key.position
      )::text[] AS columns,
      ARRAY(
        SELECT (index_row.indoption[key.position - 1] & 1) = 1
          FROM unnest(index_row.indkey) WITH ORDINALITY AS key(attnum, position)
         WHERE key.position <= index_row.indnkeyatts
         ORDER BY key.position
      )::boolean[] AS descending,
      pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
      FROM pg_class index_rel
      JOIN pg_index index_row ON index_row.indexrelid = index_rel.oid
      JOIN pg_class table_row ON table_row.oid = index_row.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${DECISIONS_TABLE}
       AND index_rel.relname = ${WALLET_INDEX}
  `.execute(db)
  const row = result.rows[0]
  if (
    !row
    || row.unique
    || !row.valid
    || row.predicate !== null
    || row.columns.join('\0') !== 'org_id\0user_id\0created_at\0id'
    || row.descending.join('\0') !== 'false\0false\0true\0true'
  ) {
    drift(WALLET_INDEX)
  }
}

async function assertImmutableTriggers(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ name: string; definition: string; enabled: string }>`
    SELECT
      trigger_row.tgname AS name,
      pg_get_triggerdef(trigger_row.oid) AS definition,
      trigger_row.tgenabled::text AS enabled
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${TABLE}
       AND NOT trigger_row.tgisinternal
     ORDER BY trigger_row.tgname
  `.execute(db)
  const expected = [
    {
      name: ROW_TRIGGER,
      events: ['DELETE', 'UPDATE'],
      level: 'ROW',
    },
    {
      name: TRUNCATE_TRIGGER,
      events: ['TRUNCATE'],
      level: 'STATEMENT',
    },
  ]
  if (result.rows.length !== expected.length) drift('immutable trigger set')
  for (let index = 0; index < expected.length; index += 1) {
    const actual = result.rows[index]
    const wanted = expected[index]
    if (!actual || !wanted || actual.name !== wanted.name || actual.enabled !== 'O') {
      drift(`immutable trigger ${wanted?.name ?? 'unknown'}`)
    }
    const definition = normalizeDefinition(actual.definition)
    if (
      !definition.includes(`trigger${wanted.name}`)
      || !wanted.events.every((event) => definition.includes(event.toLowerCase()))
      || !definition.includes(`foreach${wanted.level.toLowerCase()}`)
      || !definition.includes(`executefunction${IMMUTABLE_FUNCTION}()`)
    ) {
      drift(`immutable trigger ${wanted.name}`)
    }
  }
}

async function assertPrerequisiteTables(db: Kysely<unknown>): Promise<void> {
  if (!(await tablePresent(db, RULES_TABLE))) drift(`${RULES_TABLE} missing`)
  if (!(await tablePresent(db, DECISIONS_TABLE))) drift(`${DECISIONS_TABLE} missing`)
  if (!(await immutableFunctionPresent(db))) drift(`${IMMUTABLE_FUNCTION} missing`)
}

async function assertSchema(db: Kysely<unknown>): Promise<void> {
  const state = await readObjectState(db)
  if (!state.table || !state.walletIndex) drift('object set')
  await assertColumns(db)
  await assertConstraint(db, {
    table: TABLE,
    name: 'elearning_credit_rule_requests_pk',
    type: 'p',
    columns: ['org_id', 'source_key'],
  })
  await assertConstraint(db, {
    table: TABLE,
    name: RULE_FK,
    type: 'f',
    columns: ['org_id', 'rule_id', 'rule_version'],
    referencedTable: RULES_TABLE,
    referencedColumns: ['org_id', 'id', 'version'],
    deleteAction: 'r',
    updateAction: 'a',
    matchType: 's',
  })
  await assertCheckConstraints(db)
  await assertWalletIndex(db)
  await assertImmutableTriggers(db)
}

async function createSchema(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE elearning_credit_rule_requests (
      org_id text NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      actor_id text NOT NULL,
      rule_id text NOT NULL,
      rule_version integer NOT NULL,
      behavior text NOT NULL,
      points integer NOT NULL,
      daily_cap integer,
      time_zone text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_credit_rule_requests_pk PRIMARY KEY (org_id, source_key),
      CONSTRAINT ${sql.id(RULE_FK)}
        FOREIGN KEY (org_id, rule_id, rule_version)
        REFERENCES elearning_credit_rules(org_id, id, version) ON DELETE RESTRICT,
      CONSTRAINT elearning_credit_rule_requests_behavior_check
        CHECK (behavior = ANY (ARRAY[${AUTOMATIC_BEHAVIOR_SQL}]::text[])),
      CONSTRAINT elearning_credit_rule_requests_points_check
        CHECK (points > 0 AND rule_version > 0 AND (daily_cap IS NULL OR daily_cap > 0)),
      CONSTRAINT elearning_credit_rule_requests_hash_check
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_credit_rule_requests_identity_check
        CHECK (
          org_id <> '' AND source_key <> '' AND actor_id <> ''
          AND rule_id <> '' AND time_zone <> ''
        )
    )
  `.execute(db)
  await sql`
    CREATE INDEX ${sql.id(WALLET_INDEX)}
      ON elearning_credit_decisions (org_id, user_id, created_at DESC, id DESC)
  `.execute(db)
  await sql.raw(`CREATE TRIGGER ${ROW_TRIGGER}
    BEFORE UPDATE OR DELETE ON ${TABLE}
    FOR EACH ROW EXECUTE FUNCTION ${IMMUTABLE_FUNCTION}()`)
    .execute(db)
  await sql.raw(`CREATE TRIGGER ${TRUNCATE_TRIGGER}
    BEFORE TRUNCATE ON ${TABLE}
    FOR EACH STATEMENT EXECUTE FUNCTION ${IMMUTABLE_FUNCTION}()`)
    .execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db)
  await sql`SET LOCAL statement_timeout = '5min'`.execute(db)
  await assertPrerequisiteTables(db)
  const state = await readObjectState(db)
  if (!state.table && !state.walletIndex) {
    await createSchema(db)
  } else if (!state.table || !state.walletIndex) {
    drift('partial object set')
  }
  await assertSchema(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db)
  await sql`SET LOCAL statement_timeout = '5min'`.execute(db)
  const state = await readObjectState(db)
  if (!state.table && !state.walletIndex) return
  if (!state.table || !state.walletIndex) drift('partial object set on down')
  await assertSchema(db)
  await sql`DROP TABLE elearning_credit_rule_requests`.execute(db)
  await sql`DROP INDEX ${sql.id(WALLET_INDEX)}`.execute(db)
  const finalState = await readObjectState(db)
  if (finalState.table || finalState.walletIndex) drift('objects remain after down')
}
