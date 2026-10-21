import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const TABLES = [
  'elearning_credit_rules',
  'elearning_credit_decisions',
  'elearning_credit_effect_claims',
  'elearning_credit_daily_buckets',
  'elearning_credit_balances',
] as const

const IMMUTABLE_FUNCTION = 'elearning_credit_reject_immutable_write'
const ACTIVE_RULE_INDEX = 'elearning_credit_rules_one_active_behavior'
const EFFECT_IDENTITY_CONSTRAINT = 'elearning_credit_effect_claims_effect_identity_key'
const CLAIM_DECISION_FK = 'elearning_credit_effect_claims_decision_fk'
const DECISION_RULE_FK = 'elearning_credit_decisions_rule_fk'
const DECISION_CLAIM_MATCH_KEY = 'elearning_credit_decisions_claim_match_key'

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

type ExpectedColumn = {
  name: string
  type: string
  nullable: boolean
}

const EXPECTED_COLUMNS: Record<(typeof TABLES)[number], ExpectedColumn[]> = {
  elearning_credit_rules: [
    { name: 'org_id', type: 'text', nullable: false },
    { name: 'id', type: 'text', nullable: false },
    { name: 'version', type: 'int4', nullable: false },
    { name: 'behavior', type: 'text', nullable: false },
    { name: 'points', type: 'int4', nullable: false },
    { name: 'daily_cap', type: 'int4', nullable: true },
    { name: 'time_zone', type: 'text', nullable: false },
    { name: 'status', type: 'text', nullable: false },
    { name: 'created_at', type: 'timestamptz', nullable: false },
  ],
  elearning_credit_decisions: [
    { name: 'id', type: 'uuid', nullable: false },
    { name: 'org_id', type: 'text', nullable: false },
    { name: 'user_id', type: 'text', nullable: false },
    { name: 'behavior', type: 'text', nullable: false },
    { name: 'effect_key', type: 'text', nullable: false },
    { name: 'request_hash', type: 'text', nullable: false },
    { name: 'request_hash_version', type: 'int2', nullable: false },
    { name: 'occurred_at', type: 'timestamptz', nullable: false },
    { name: 'local_day', type: 'date', nullable: false },
    { name: 'rule_id', type: 'text', nullable: false },
    { name: 'rule_version', type: 'int4', nullable: false },
    { name: 'rule_points', type: 'int4', nullable: false },
    { name: 'rule_daily_cap', type: 'int4', nullable: true },
    { name: 'rule_time_zone', type: 'text', nullable: false },
    { name: 'requested_points', type: 'int4', nullable: false },
    { name: 'awarded_points', type: 'int4', nullable: false },
    { name: 'remaining_daily_cap', type: 'int4', nullable: true },
    { name: 'status', type: 'text', nullable: false },
    { name: 'created_at', type: 'timestamptz', nullable: false },
  ],
  elearning_credit_effect_claims: [
    { name: 'org_id', type: 'text', nullable: false },
    { name: 'user_id', type: 'text', nullable: false },
    { name: 'behavior', type: 'text', nullable: false },
    { name: 'effect_key', type: 'text', nullable: false },
    { name: 'request_hash', type: 'text', nullable: false },
    { name: 'request_hash_version', type: 'int2', nullable: false },
    { name: 'decision_id', type: 'uuid', nullable: false },
    { name: 'created_at', type: 'timestamptz', nullable: false },
  ],
  elearning_credit_daily_buckets: [
    { name: 'org_id', type: 'text', nullable: false },
    { name: 'user_id', type: 'text', nullable: false },
    { name: 'behavior', type: 'text', nullable: false },
    { name: 'local_day', type: 'date', nullable: false },
    { name: 'created_at', type: 'timestamptz', nullable: false },
  ],
  elearning_credit_balances: [
    { name: 'org_id', type: 'text', nullable: false },
    { name: 'user_id', type: 'text', nullable: false },
    { name: 'balance_points', type: 'int4', nullable: false },
    { name: 'updated_at', type: 'timestamptz', nullable: false },
  ],
}

const BEHAVIOR_CHECK_DEFINITION = `CHECK ((behavior = ANY (ARRAY[
  'login'::text,
  'complete_course'::text,
  'complete_plan'::text,
  'pass_exam'::text,
  'submit_survey'::text,
  'complete_map'::text,
  'complete_offline'::text
])))`

const EXPECTED_CHECKS = [
  {
    table: 'elearning_credit_balances',
    name: 'elearning_credit_balances_identity_check',
    definition: `CHECK (((org_id <> ''::text) AND (user_id <> ''::text)))`,
  },
  {
    table: 'elearning_credit_balances',
    name: 'elearning_credit_balances_nonnegative_check',
    definition: 'CHECK ((balance_points >= 0))',
  },
  {
    table: 'elearning_credit_daily_buckets',
    name: 'elearning_credit_daily_buckets_behavior_check',
    definition: BEHAVIOR_CHECK_DEFINITION,
  },
  {
    table: 'elearning_credit_daily_buckets',
    name: 'elearning_credit_daily_buckets_identity_check',
    definition: `CHECK (((org_id <> ''::text) AND (user_id <> ''::text)))`,
  },
  {
    table: 'elearning_credit_decisions',
    name: 'elearning_credit_decisions_behavior_check',
    definition: BEHAVIOR_CHECK_DEFINITION,
  },
  {
    table: 'elearning_credit_decisions',
    name: 'elearning_credit_decisions_hash_check',
    definition: `CHECK (((request_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash_version > 0)))`,
  },
  {
    table: 'elearning_credit_decisions',
    name: 'elearning_credit_decisions_identity_check',
    definition: `CHECK (((org_id <> ''::text) AND (user_id <> ''::text) AND (effect_key <> ''::text) AND (rule_time_zone <> ''::text)))`,
  },
  {
    table: 'elearning_credit_decisions',
    name: 'elearning_credit_decisions_points_check',
    definition: `CHECK (((requested_points > 0) AND (awarded_points >= 0) AND (awarded_points <= requested_points) AND ((remaining_daily_cap IS NULL) OR (remaining_daily_cap >= 0)) AND (((status = ANY (ARRAY['awarded'::text, 'capped'::text])) AND (awarded_points > 0)) OR ((status = 'exhausted'::text) AND (awarded_points = 0)))))`,
  },
  {
    table: 'elearning_credit_effect_claims',
    name: 'elearning_credit_effect_claims_behavior_check',
    definition: BEHAVIOR_CHECK_DEFINITION,
  },
  {
    table: 'elearning_credit_effect_claims',
    name: 'elearning_credit_effect_claims_hash_check',
    definition: `CHECK (((request_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash_version > 0)))`,
  },
  {
    table: 'elearning_credit_effect_claims',
    name: 'elearning_credit_effect_claims_identity_check',
    definition: `CHECK (((org_id <> ''::text) AND (user_id <> ''::text) AND (effect_key <> ''::text)))`,
  },
  {
    table: 'elearning_credit_rules',
    name: 'elearning_credit_rules_behavior_check',
    definition: BEHAVIOR_CHECK_DEFINITION,
  },
  {
    table: 'elearning_credit_rules',
    name: 'elearning_credit_rules_daily_cap_check',
    definition: 'CHECK (((daily_cap IS NULL) OR (daily_cap > 0)))',
  },
  {
    table: 'elearning_credit_rules',
    name: 'elearning_credit_rules_identity_check',
    definition: `CHECK (((org_id <> ''::text) AND (id <> ''::text) AND (time_zone <> ''::text)))`,
  },
  {
    table: 'elearning_credit_rules',
    name: 'elearning_credit_rules_points_check',
    definition: 'CHECK ((points > 0))',
  },
  {
    table: 'elearning_credit_rules',
    name: 'elearning_credit_rules_status_check',
    definition: `CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text])))`,
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
  throw new Error(`elearning credit ledger migration drift: ${detail}`)
}

async function readObjectState(db: Kysely<unknown>): Promise<{
  tables: Set<string>
  functionPresent: boolean
}> {
  const tables = await sql<{ name: string }>`
    SELECT table_name AS name
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ANY(${sql.val([...TABLES])}::text[])
  `.execute(db)
  const fn = await sql<{ present: boolean }>`
    SELECT to_regprocedure(${`${IMMUTABLE_FUNCTION}()`}) IS NOT NULL AS present
  `.execute(db)
  return {
    functionPresent: fn.rows[0]?.present === true,
    tables: new Set(tables.rows.map((row) => row.name)),
  }
}

async function assertColumns(
  db: Kysely<unknown>,
  table: (typeof TABLES)[number],
): Promise<void> {
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
       AND table_row.relname = ${table}
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  `.execute(db)
  if (JSON.stringify(result.rows) !== JSON.stringify(EXPECTED_COLUMNS[table])) {
    drift(`${table} columns`)
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
    deferrable?: boolean
    deferred?: boolean
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
    || actual.deferrable !== (expected.deferrable ?? false)
    || actual.deferred !== (expected.deferred ?? false)
    || (expected.deleteAction !== undefined && actual.delete_action !== expected.deleteAction)
    || (expected.updateAction !== undefined && actual.update_action !== expected.updateAction)
    || (expected.matchType !== undefined && actual.match_type !== expected.matchType)
    || !actual.validated
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
       AND table_row.relname = ANY(${sql.val([...TABLES])}::text[])
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

async function assertActiveRuleIndex(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    unique: boolean
    valid: boolean
    columns: string[]
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
      pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
      FROM pg_class index_rel
      JOIN pg_index index_row ON index_row.indexrelid = index_rel.oid
      JOIN pg_class table_row ON table_row.oid = index_row.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = 'elearning_credit_rules'
       AND index_rel.relname = ${ACTIVE_RULE_INDEX}
  `.execute(db)
  const row = result.rows[0]
  const predicate = row?.predicate?.toLowerCase().replaceAll('::text', '').replace(/[()\s]/g, '')
  if (
    !row
    || !row.unique
    || !row.valid
    || row.columns.join('\0') !== 'org_id\0behavior'
    || predicate !== "status='active'"
  ) {
    drift(ACTIVE_RULE_INDEX)
  }
}

async function assertDailyAwardsIndex(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    unique: boolean
    valid: boolean
    columns: string[]
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
      pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
      FROM pg_class index_rel
      JOIN pg_index index_row ON index_row.indexrelid = index_rel.oid
      JOIN pg_class table_row ON table_row.oid = index_row.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = 'elearning_credit_decisions'
       AND index_rel.relname = 'elearning_credit_decisions_daily_awards_idx'
  `.execute(db)
  const row = result.rows[0]
  if (
    !row
    || row.unique
    || !row.valid
    || row.predicate !== null
    || row.columns.join('\0') !== 'org_id\0user_id\0behavior\0local_day'
  ) {
    drift('elearning_credit_decisions_daily_awards_idx')
  }
}

async function assertImmutableTriggers(db: Kysely<unknown>): Promise<void> {
  const expected = [
    { table: 'elearning_credit_decisions', name: 'elearning_credit_decisions_immutable_row', type: 27 },
    { table: 'elearning_credit_decisions', name: 'elearning_credit_decisions_immutable_truncate', type: 34 },
    { table: 'elearning_credit_effect_claims', name: 'elearning_credit_effect_claims_immutable_row', type: 27 },
    { table: 'elearning_credit_effect_claims', name: 'elearning_credit_effect_claims_immutable_truncate', type: 34 },
  ]
  const result = await sql<{
    table: string
    name: string
    type: number
    enabled: string
    function_name: string
    function_in_current_schema: boolean
  }>`
    SELECT
      table_row.relname AS table,
      trigger_row.tgname AS name,
      trigger_row.tgtype::int AS type,
      trigger_row.tgenabled AS enabled,
      function_row.proname AS function_name,
      function_row.pronamespace = namespace.oid AS function_in_current_schema
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
     WHERE namespace.nspname = current_schema()
       AND NOT trigger_row.tgisinternal
       AND table_row.relname = ANY(${sql.val([
         'elearning_credit_decisions',
         'elearning_credit_effect_claims',
       ])}::text[])
     ORDER BY table_row.relname, trigger_row.tgname
  `.execute(db)
  const actual = result.rows.map((row) => ({
    enabled: row.enabled,
    functionName: row.function_name,
    functionInCurrentSchema: row.function_in_current_schema,
    name: row.name,
    table: row.table,
    type: row.type,
  }))
  const required = expected.map((row) => ({
    enabled: 'O',
    functionName: IMMUTABLE_FUNCTION,
    functionInCurrentSchema: true,
    name: row.name,
    table: row.table,
    type: row.type,
  }))
  if (JSON.stringify(actual) !== JSON.stringify(required)) drift('immutable triggers')

  const fn = await sql<{
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
  const functionRow = fn.rows[0]
  if (
    fn.rows.length !== 1
    || !functionRow
    || functionRow.language !== 'plpgsql'
    || functionRow.result_type !== 'trigger'
    || functionRow.security_definer
    || normalizeDefinition(functionRow.source)
      !== normalizeDefinition("BEGIN RAISE EXCEPTION 'ELEARNING_CREDIT_IMMUTABLE'; END;")
  ) {
    drift('immutable function')
  }
}

async function assertSchema(db: Kysely<unknown>): Promise<void> {
  const state = await readObjectState(db)
  if (!state.functionPresent || TABLES.some((table) => !state.tables.has(table))) {
    drift('object set')
  }
  for (const table of TABLES) await assertColumns(db, table)
  await assertConstraint(db, {
    table: 'elearning_credit_rules',
    name: 'elearning_credit_rules_pk',
    type: 'p',
    columns: ['org_id', 'id', 'version'],
  })
  await assertConstraint(db, {
    table: 'elearning_credit_decisions',
    name: 'elearning_credit_decisions_pkey',
    type: 'p',
    columns: ['id'],
  })
  await assertConstraint(db, {
    table: 'elearning_credit_decisions',
    name: 'elearning_credit_decisions_org_id_key',
    type: 'u',
    columns: ['org_id', 'id'],
  })
  await assertConstraint(db, {
    table: 'elearning_credit_effect_claims',
    name: EFFECT_IDENTITY_CONSTRAINT,
    type: 'u',
    columns: ['org_id', 'user_id', 'behavior', 'effect_key'],
  })
  await assertConstraint(db, {
    table: 'elearning_credit_decisions',
    name: DECISION_CLAIM_MATCH_KEY,
    type: 'u',
    columns: [
      'org_id',
      'id',
      'user_id',
      'behavior',
      'effect_key',
      'request_hash',
      'request_hash_version',
    ],
  })
  await assertConstraint(db, {
    table: 'elearning_credit_effect_claims',
    name: 'elearning_credit_effect_claims_decision_id_key',
    type: 'u',
    columns: ['org_id', 'decision_id'],
  })
  await assertConstraint(db, {
    table: 'elearning_credit_effect_claims',
    name: CLAIM_DECISION_FK,
    type: 'f',
    columns: [
      'org_id',
      'decision_id',
      'user_id',
      'behavior',
      'effect_key',
      'request_hash',
      'request_hash_version',
    ],
    referencedTable: 'elearning_credit_decisions',
    referencedColumns: [
      'org_id',
      'id',
      'user_id',
      'behavior',
      'effect_key',
      'request_hash',
      'request_hash_version',
    ],
    deferrable: true,
    deferred: true,
    deleteAction: 'r',
    updateAction: 'a',
    matchType: 's',
  })
  await assertConstraint(db, {
    table: 'elearning_credit_decisions',
    name: DECISION_RULE_FK,
    type: 'f',
    columns: ['org_id', 'rule_id', 'rule_version'],
    referencedTable: 'elearning_credit_rules',
    referencedColumns: ['org_id', 'id', 'version'],
    deleteAction: 'r',
    updateAction: 'a',
    matchType: 's',
  })
  await assertConstraint(db, {
    table: 'elearning_credit_daily_buckets',
    name: 'elearning_credit_daily_buckets_pk',
    type: 'p',
    columns: ['org_id', 'user_id', 'behavior', 'local_day'],
  })
  await assertConstraint(db, {
    table: 'elearning_credit_balances',
    name: 'elearning_credit_balances_pk',
    type: 'p',
    columns: ['org_id', 'user_id'],
  })
  await assertCheckConstraints(db)
  await assertActiveRuleIndex(db)
  await assertDailyAwardsIndex(db)
  await assertImmutableTriggers(db)
}

async function createSchema(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE elearning_credit_rules (
      org_id text NOT NULL,
      id text NOT NULL,
      version integer NOT NULL,
      behavior text NOT NULL,
      points integer NOT NULL,
      daily_cap integer,
      time_zone text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_credit_rules_pk PRIMARY KEY (org_id, id, version),
      CONSTRAINT elearning_credit_rules_behavior_check
        CHECK (behavior = ANY (ARRAY[${AUTOMATIC_BEHAVIOR_SQL}]::text[])),
      CONSTRAINT elearning_credit_rules_points_check CHECK (points > 0),
      CONSTRAINT elearning_credit_rules_daily_cap_check CHECK (daily_cap IS NULL OR daily_cap > 0),
      CONSTRAINT elearning_credit_rules_status_check CHECK (status IN ('active', 'retired')),
      CONSTRAINT elearning_credit_rules_identity_check
        CHECK (org_id <> '' AND id <> '' AND time_zone <> '')
    )
  `.execute(db)
  await sql`CREATE UNIQUE INDEX ${sql.id(ACTIVE_RULE_INDEX)}
    ON elearning_credit_rules(org_id, behavior) WHERE status = 'active'`.execute(db)

  await sql`
    CREATE TABLE elearning_credit_decisions (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      behavior text NOT NULL,
      effect_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      occurred_at timestamptz NOT NULL,
      local_day date NOT NULL,
      rule_id text NOT NULL,
      rule_version integer NOT NULL,
      rule_points integer NOT NULL,
      rule_daily_cap integer,
      rule_time_zone text NOT NULL,
      requested_points integer NOT NULL,
      awarded_points integer NOT NULL,
      remaining_daily_cap integer,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_credit_decisions_org_id_key UNIQUE (org_id, id),
      CONSTRAINT ${sql.id(DECISION_CLAIM_MATCH_KEY)}
        UNIQUE (
          org_id, id, user_id, behavior, effect_key,
          request_hash, request_hash_version
        ),
      CONSTRAINT ${sql.id(DECISION_RULE_FK)}
        FOREIGN KEY (org_id, rule_id, rule_version)
        REFERENCES elearning_credit_rules(org_id, id, version) ON DELETE RESTRICT,
      CONSTRAINT elearning_credit_decisions_behavior_check
        CHECK (behavior = ANY (ARRAY[${AUTOMATIC_BEHAVIOR_SQL}]::text[])),
      CONSTRAINT elearning_credit_decisions_hash_check
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_credit_decisions_points_check CHECK (
        requested_points > 0
        AND awarded_points >= 0
        AND awarded_points <= requested_points
        AND (remaining_daily_cap IS NULL OR remaining_daily_cap >= 0)
        AND ((status IN ('awarded', 'capped') AND awarded_points > 0)
          OR (status = 'exhausted' AND awarded_points = 0))
      ),
      CONSTRAINT elearning_credit_decisions_identity_check
        CHECK (org_id <> '' AND user_id <> '' AND effect_key <> '' AND rule_time_zone <> '')
    )
  `.execute(db)
  await sql`CREATE INDEX elearning_credit_decisions_daily_awards_idx
    ON elearning_credit_decisions(org_id, user_id, behavior, local_day)`.execute(db)

  await sql`
    CREATE TABLE elearning_credit_effect_claims (
      org_id text NOT NULL,
      user_id text NOT NULL,
      behavior text NOT NULL,
      effect_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      decision_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ${sql.id(EFFECT_IDENTITY_CONSTRAINT)}
        UNIQUE (org_id, user_id, behavior, effect_key),
      CONSTRAINT elearning_credit_effect_claims_decision_id_key UNIQUE (org_id, decision_id),
      CONSTRAINT ${sql.id(CLAIM_DECISION_FK)}
        FOREIGN KEY (
          org_id, decision_id, user_id, behavior, effect_key,
          request_hash, request_hash_version
        )
        REFERENCES elearning_credit_decisions(
          org_id, id, user_id, behavior, effect_key,
          request_hash, request_hash_version
        )
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT elearning_credit_effect_claims_behavior_check
        CHECK (behavior = ANY (ARRAY[${AUTOMATIC_BEHAVIOR_SQL}]::text[])),
      CONSTRAINT elearning_credit_effect_claims_hash_check
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_credit_effect_claims_identity_check
        CHECK (org_id <> '' AND user_id <> '' AND effect_key <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_credit_daily_buckets (
      org_id text NOT NULL,
      user_id text NOT NULL,
      behavior text NOT NULL,
      local_day date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_credit_daily_buckets_pk
        PRIMARY KEY (org_id, user_id, behavior, local_day),
      CONSTRAINT elearning_credit_daily_buckets_behavior_check
        CHECK (behavior = ANY (ARRAY[${AUTOMATIC_BEHAVIOR_SQL}]::text[])),
      CONSTRAINT elearning_credit_daily_buckets_identity_check
        CHECK (org_id <> '' AND user_id <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_credit_balances (
      org_id text NOT NULL,
      user_id text NOT NULL,
      balance_points integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_credit_balances_pk PRIMARY KEY (org_id, user_id),
      CONSTRAINT elearning_credit_balances_nonnegative_check CHECK (balance_points >= 0),
      CONSTRAINT elearning_credit_balances_identity_check CHECK (org_id <> '' AND user_id <> '')
    )
  `.execute(db)

  await sql.raw(`
    CREATE FUNCTION ${IMMUTABLE_FUNCTION}() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'ELEARNING_CREDIT_IMMUTABLE';
    END;
    $$ LANGUAGE plpgsql
  `).execute(db)
  for (const table of ['elearning_credit_decisions', 'elearning_credit_effect_claims']) {
    await sql.raw(`CREATE TRIGGER ${table}_immutable_row
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${IMMUTABLE_FUNCTION}()`)
      .execute(db)
    await sql.raw(`CREATE TRIGGER ${table}_immutable_truncate
      BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION ${IMMUTABLE_FUNCTION}()`)
      .execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db)
  await sql`SET LOCAL statement_timeout = '5min'`.execute(db)
  const state = await readObjectState(db)
  const presentCount = TABLES.filter((table) => state.tables.has(table)).length
  if (presentCount === 0 && !state.functionPresent) {
    await createSchema(db)
  } else if (presentCount !== TABLES.length || !state.functionPresent) {
    drift('partial object set')
  }
  await assertSchema(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db)
  await sql`SET LOCAL statement_timeout = '5min'`.execute(db)
  const state = await readObjectState(db)
  const presentCount = TABLES.filter((table) => state.tables.has(table)).length
  if (presentCount === 0 && !state.functionPresent) return
  if (presentCount !== TABLES.length || !state.functionPresent) drift('partial object set on down')
  await assertSchema(db)

  await sql`DROP TABLE elearning_credit_effect_claims`.execute(db)
  await sql`DROP TABLE elearning_credit_balances`.execute(db)
  await sql`DROP TABLE elearning_credit_daily_buckets`.execute(db)
  await sql`DROP TABLE elearning_credit_decisions`.execute(db)
  await sql`DROP TABLE elearning_credit_rules`.execute(db)
  await sql.raw(`DROP FUNCTION ${IMMUTABLE_FUNCTION}()`).execute(db)

  const finalState = await readObjectState(db)
  if (finalState.tables.size !== 0 || finalState.functionPresent) drift('objects remain after down')
}
