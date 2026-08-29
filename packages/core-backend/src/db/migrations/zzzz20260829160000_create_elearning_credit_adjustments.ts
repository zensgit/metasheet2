import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { ensureCanonicalUserOrgsTable } from './_ensure-user-orgs'

const TABLE = 'elearning_credit_adjustments'
const BALANCES_TABLE = 'elearning_credit_balances'
const IMMUTABLE_FUNCTION = 'elearning_credit_reject_immutable_write'
const WALLET_INDEX = 'elearning_credit_adjustments_wallet_keyset_idx'
const REQUEST_KEY = 'elearning_credit_adjustments_org_source_key'
const ACTOR_FK = 'elearning_credit_adjustments_actor_org_fk'
const USER_FK = 'elearning_credit_adjustments_user_org_fk'
const ROW_TRIGGER = 'elearning_credit_adjustments_immutable_row'
const TRUNCATE_TRIGGER = 'elearning_credit_adjustments_immutable_truncate'
const IMMUTABLE_FUNCTION_SOURCE = `BEGIN
      RAISE EXCEPTION 'ELEARNING_CREDIT_IMMUTABLE';
    END;`

const EXPECTED_COLUMNS = [
  { name: 'id', type: 'uuid', nullable: false },
  { name: 'org_id', type: 'text', nullable: false },
  { name: 'actor_id', type: 'text', nullable: false },
  { name: 'source_key', type: 'text', nullable: false },
  { name: 'request_hash', type: 'text', nullable: false },
  { name: 'request_hash_version', type: 'int2', nullable: false },
  { name: 'user_id', type: 'text', nullable: false },
  { name: 'points', type: 'int4', nullable: false },
  { name: 'reason', type: 'text', nullable: false },
  { name: 'balance_after', type: 'int4', nullable: false },
  { name: 'created_at', type: 'timestamptz', nullable: false },
] as const

const EXPECTED_CHECKS = [
  {
    name: 'elearning_credit_adjustments_balance_check',
    definition: 'CHECK ((balance_after >= 0))',
  },
  {
    name: 'elearning_credit_adjustments_hash_check',
    definition: `CHECK (((request_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash_version > 0)))`,
  },
  {
    name: 'elearning_credit_adjustments_identity_check',
    definition: `CHECK (((org_id = btrim(org_id)) AND (org_id <> ''::text) AND (char_length(org_id) <= 512) AND (actor_id = btrim(actor_id)) AND (actor_id <> ''::text) AND (char_length(actor_id) <= 512) AND (source_key = btrim(source_key)) AND (source_key <> ''::text) AND (char_length(source_key) <= 512) AND (user_id = btrim(user_id)) AND (user_id <> ''::text) AND (char_length(user_id) <= 512) AND (reason = btrim(reason)) AND (reason <> ''::text) AND (char_length(reason) <= 512)))`,
  },
  {
    name: 'elearning_credit_adjustments_points_check',
    definition: `CHECK (((points <> 0) AND (points >= '-2147483647'::integer)))`,
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
  throw new Error(`elearning credit adjustment migration drift: ${detail}`)
}

async function relationPresent(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass(${sql.val(name)}) IS NOT NULL AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

async function assertImmutableFunction(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    language: string
    result_type: string
    source: string
    security_definer: boolean
  }>`
    SELECT
      language_row.lanname AS language,
      function_row.prorettype::regtype::text AS result_type,
      function_row.prosrc AS source,
      function_row.prosecdef AS security_definer
      FROM pg_proc function_row
      JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
      JOIN pg_language language_row ON language_row.oid = function_row.prolang
     WHERE namespace.nspname = current_schema()
       AND function_row.proname = ${IMMUTABLE_FUNCTION}
       AND function_row.pronargs = 0
  `.execute(db)
  const row = result.rows[0]
  if (
    result.rows.length !== 1
    || !row
    || row.language !== 'plpgsql'
    || row.result_type !== 'trigger'
    || row.security_definer
    || row.source.trim() !== IMMUTABLE_FUNCTION_SOURCE
  ) drift('immutable function')
}

async function readObjectState(db: Kysely<unknown>): Promise<{
  table: boolean
  walletIndex: boolean
}> {
  return {
    table: await relationPresent(db, TABLE),
    walletIndex: await relationPresent(db, WALLET_INDEX),
  }
}

async function assertPrerequisites(db: Kysely<unknown>): Promise<void> {
  await ensureCanonicalUserOrgsTable(db)
  if (!(await relationPresent(db, BALANCES_TABLE))) drift(`${BALANCES_TABLE} missing`)
  await assertImmutableFunction(db)
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
       AND table_row.relname = ${TABLE}
       AND constraint_row.conname = ${name}
  `.execute(db)
  return result.rows[0] ?? null
}

async function assertConstraint(
  db: Kysely<unknown>,
  expected: {
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
  const actual = await readConstraint(db, expected.name)
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

async function assertChecks(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ name: string; definition: string; validated: boolean }>`
    SELECT
      constraint_row.conname AS name,
      pg_get_constraintdef(constraint_row.oid) AS definition,
      constraint_row.convalidated AS validated
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${TABLE}
       AND constraint_row.contype = 'c'
     ORDER BY constraint_row.conname
  `.execute(db)
  const actual = result.rows.map((row) => ({
    definition: normalizeDefinition(row.definition),
    name: row.name,
    validated: row.validated,
  }))
  const expected = EXPECTED_CHECKS.map((row) => ({
    definition: normalizeDefinition(row.definition),
    name: row.name,
    validated: true,
  }))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) drift('check constraint set')
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
       AND table_row.relname = ${TABLE}
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
  ) drift(WALLET_INDEX)
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
    { name: ROW_TRIGGER, events: ['DELETE', 'UPDATE'], level: 'ROW' },
    { name: TRUNCATE_TRIGGER, events: ['TRUNCATE'], level: 'STATEMENT' },
  ]
  if (result.rows.length !== expected.length) drift('immutable trigger set')
  for (const [index, wanted] of expected.entries()) {
    const actual = result.rows[index]
    if (!actual || actual.name !== wanted.name || actual.enabled !== 'O') {
      drift(`immutable trigger ${wanted.name}`)
    }
    const definition = normalizeDefinition(actual.definition)
    if (
      !wanted.events.every((event) => definition.includes(event.toLowerCase()))
      || !definition.includes(`foreach${wanted.level.toLowerCase()}`)
      || !definition.includes(`executefunction${IMMUTABLE_FUNCTION}()`)
    ) drift(`immutable trigger ${wanted.name}`)
  }
}

async function assertSchema(db: Kysely<unknown>): Promise<void> {
  const state = await readObjectState(db)
  if (!state.table || !state.walletIndex) drift('object set')
  await assertColumns(db)
  await assertConstraint(db, {
    name: 'elearning_credit_adjustments_pk',
    type: 'p',
    columns: ['id'],
  })
  await assertConstraint(db, {
    name: REQUEST_KEY,
    type: 'u',
    columns: ['org_id', 'source_key'],
  })
  await assertConstraint(db, {
    name: ACTOR_FK,
    type: 'f',
    columns: ['actor_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
    deleteAction: 'r',
    updateAction: 'a',
    matchType: 's',
  })
  await assertConstraint(db, {
    name: USER_FK,
    type: 'f',
    columns: ['user_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
    deleteAction: 'r',
    updateAction: 'a',
    matchType: 's',
  })
  await assertChecks(db)
  await assertWalletIndex(db)
  await assertImmutableTriggers(db)
}

async function createSchema(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE elearning_credit_adjustments (
      id uuid NOT NULL,
      org_id text NOT NULL,
      actor_id text NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      user_id text NOT NULL,
      points integer NOT NULL,
      reason text NOT NULL,
      balance_after integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_credit_adjustments_pk PRIMARY KEY (id),
      CONSTRAINT elearning_credit_adjustments_org_source_key
        UNIQUE (org_id, source_key),
      CONSTRAINT elearning_credit_adjustments_actor_org_fk
        FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_credit_adjustments_user_org_fk
        FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_credit_adjustments_hash_check
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_credit_adjustments_identity_check
        CHECK (
          org_id = btrim(org_id) AND org_id <> '' AND char_length(org_id) <= 512
          AND actor_id = btrim(actor_id) AND actor_id <> '' AND char_length(actor_id) <= 512
          AND source_key = btrim(source_key) AND source_key <> ''
          AND char_length(source_key) <= 512
          AND user_id = btrim(user_id) AND user_id <> '' AND char_length(user_id) <= 512
          AND reason = btrim(reason) AND reason <> '' AND char_length(reason) <= 512
        ),
      CONSTRAINT elearning_credit_adjustments_points_check
        CHECK (points <> 0 AND points >= -2147483647),
      CONSTRAINT elearning_credit_adjustments_balance_check
        CHECK (balance_after >= 0)
    )
  `.execute(db)
  await sql`
    CREATE INDEX elearning_credit_adjustments_wallet_keyset_idx
      ON elearning_credit_adjustments (org_id, user_id, created_at DESC, id DESC)
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
  await assertPrerequisites(db)
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
  await sql`DROP TABLE elearning_credit_adjustments`.execute(db)
  const finalState = await readObjectState(db)
  if (finalState.table || finalState.walletIndex) drift('objects remain after down')
}
