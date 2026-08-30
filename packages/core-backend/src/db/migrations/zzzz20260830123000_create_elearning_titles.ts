import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { ensureCanonicalUserOrgsTable } from './_ensure-user-orgs'

const TABLES = [
  'elearning_title_heads',
  'elearning_title_revisions',
  'elearning_title_revision_rows',
  'elearning_title_publish_requests',
  'elearning_title_awards',
] as const

const IMMUTABLE_FUNCTION = 'elearning_credit_reject_immutable_write'
const AWARD_FUNCTION = 'elearning_title_award_balance_milestones'
const BALANCE_TRIGGER = 'elearning_credit_balances_title_awards'
const IMMUTABLE_TABLES = TABLES.slice(1)

type ExpectedColumn = {
  name: string
  type: string
  nullable: boolean
  default: string | null
}

const EXPECTED_COLUMNS: Record<(typeof TABLES)[number], ExpectedColumn[]> = {
  elearning_title_heads: [
    { name: 'org_id', type: 'text', nullable: false, default: null },
    { name: 'id', type: 'uuid', nullable: false, default: null },
    { name: 'active_revision_id', type: 'uuid', nullable: true, default: null },
    { name: 'latest_version', type: 'int4', nullable: false, default: '0' },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
    { name: 'updated_at', type: 'timestamptz', nullable: false, default: 'now()' },
  ],
  elearning_title_revisions: [
    { name: 'id', type: 'uuid', nullable: false, default: null },
    { name: 'org_id', type: 'text', nullable: false, default: null },
    { name: 'head_id', type: 'uuid', nullable: false, default: null },
    { name: 'version', type: 'int4', nullable: false, default: null },
    { name: 'actor_id', type: 'text', nullable: false, default: null },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
  ],
  elearning_title_revision_rows: [
    { name: 'id', type: 'uuid', nullable: false, default: null },
    { name: 'org_id', type: 'text', nullable: false, default: null },
    { name: 'revision_id', type: 'uuid', nullable: false, default: null },
    { name: 'title_key', type: 'text', nullable: false, default: null },
    { name: 'name', type: 'text', nullable: false, default: null },
    { name: 'threshold', type: 'int4', nullable: false, default: null },
    { name: 'position', type: 'int4', nullable: false, default: null },
  ],
  elearning_title_publish_requests: [
    { name: 'org_id', type: 'text', nullable: false, default: null },
    { name: 'source_key', type: 'text', nullable: false, default: null },
    { name: 'request_hash', type: 'text', nullable: false, default: null },
    { name: 'request_hash_version', type: 'int2', nullable: false, default: null },
    { name: 'actor_id', type: 'text', nullable: false, default: null },
    { name: 'revision_id', type: 'uuid', nullable: false, default: null },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
  ],
  elearning_title_awards: [
    { name: 'id', type: 'uuid', nullable: false, default: null },
    { name: 'org_id', type: 'text', nullable: false, default: null },
    { name: 'user_id', type: 'text', nullable: false, default: null },
    { name: 'title_key', type: 'text', nullable: false, default: null },
    { name: 'title_revision_id', type: 'uuid', nullable: false, default: null },
    { name: 'title_row_id', type: 'uuid', nullable: false, default: null },
    { name: 'threshold', type: 'int4', nullable: false, default: null },
    { name: 'balance_points', type: 'int4', nullable: false, default: null },
    { name: 'awarded_at', type: 'timestamptz', nullable: false, default: 'now()' },
  ],
}

type ExpectedConstraint = {
  table: string
  name: string
  type: 'p' | 'u' | 'f'
  columns: string[]
  referencedTable?: string
  referencedColumns?: string[]
  deferrable?: boolean
  deferred?: boolean
}

const EXPECTED_CONSTRAINTS: ExpectedConstraint[] = [
  {
    table: 'elearning_title_heads',
    name: 'elearning_title_heads_pk',
    type: 'p',
    columns: ['org_id'],
  },
  {
    table: 'elearning_title_heads',
    name: 'elearning_title_heads_org_id_key',
    type: 'u',
    columns: ['org_id', 'id'],
  },
  {
    table: 'elearning_title_heads',
    name: 'elearning_title_heads_active_revision_fk',
    type: 'f',
    columns: ['org_id', 'id', 'active_revision_id'],
    referencedTable: 'elearning_title_revisions',
    referencedColumns: ['org_id', 'head_id', 'id'],
    deferrable: true,
    deferred: true,
  },
  {
    table: 'elearning_title_revisions',
    name: 'elearning_title_revisions_pk',
    type: 'p',
    columns: ['org_id', 'id'],
  },
  {
    table: 'elearning_title_revisions',
    name: 'elearning_title_revisions_head_version_key',
    type: 'u',
    columns: ['org_id', 'head_id', 'version'],
  },
  {
    table: 'elearning_title_revisions',
    name: 'elearning_title_revisions_head_identity_key',
    type: 'u',
    columns: ['org_id', 'head_id', 'id'],
  },
  {
    table: 'elearning_title_revisions',
    name: 'elearning_title_revisions_head_fk',
    type: 'f',
    columns: ['org_id', 'head_id'],
    referencedTable: 'elearning_title_heads',
    referencedColumns: ['org_id', 'id'],
  },
  {
    table: 'elearning_title_revisions',
    name: 'elearning_title_revisions_actor_fk',
    type: 'f',
    columns: ['actor_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
  },
  {
    table: 'elearning_title_revision_rows',
    name: 'elearning_title_revision_rows_pk',
    type: 'p',
    columns: ['org_id', 'id'],
  },
  {
    table: 'elearning_title_revision_rows',
    name: 'elearning_title_revision_rows_title_key',
    type: 'u',
    columns: ['org_id', 'revision_id', 'title_key'],
  },
  {
    table: 'elearning_title_revision_rows',
    name: 'elearning_title_revision_rows_threshold_key',
    type: 'u',
    columns: ['org_id', 'revision_id', 'threshold'],
  },
  {
    table: 'elearning_title_revision_rows',
    name: 'elearning_title_revision_rows_position_key',
    type: 'u',
    columns: ['org_id', 'revision_id', 'position'],
  },
  {
    table: 'elearning_title_revision_rows',
    name: 'elearning_title_revision_rows_award_key',
    type: 'u',
    columns: ['org_id', 'revision_id', 'id', 'title_key'],
  },
  {
    table: 'elearning_title_revision_rows',
    name: 'elearning_title_revision_rows_revision_fk',
    type: 'f',
    columns: ['org_id', 'revision_id'],
    referencedTable: 'elearning_title_revisions',
    referencedColumns: ['org_id', 'id'],
  },
  {
    table: 'elearning_title_publish_requests',
    name: 'elearning_title_publish_requests_pk',
    type: 'p',
    columns: ['org_id', 'source_key'],
  },
  {
    table: 'elearning_title_publish_requests',
    name: 'elearning_title_publish_requests_actor_fk',
    type: 'f',
    columns: ['actor_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
  },
  {
    table: 'elearning_title_publish_requests',
    name: 'elearning_title_publish_requests_revision_fk',
    type: 'f',
    columns: ['org_id', 'revision_id'],
    referencedTable: 'elearning_title_revisions',
    referencedColumns: ['org_id', 'id'],
  },
  {
    table: 'elearning_title_awards',
    name: 'elearning_title_awards_pk',
    type: 'p',
    columns: ['org_id', 'id'],
  },
  {
    table: 'elearning_title_awards',
    name: 'elearning_title_awards_milestone_key',
    type: 'u',
    columns: ['org_id', 'user_id', 'title_key'],
  },
  {
    table: 'elearning_title_awards',
    name: 'elearning_title_awards_user_fk',
    type: 'f',
    columns: ['user_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
  },
  {
    table: 'elearning_title_awards',
    name: 'elearning_title_awards_row_fk',
    type: 'f',
    columns: ['org_id', 'title_revision_id', 'title_row_id', 'title_key'],
    referencedTable: 'elearning_title_revision_rows',
    referencedColumns: ['org_id', 'revision_id', 'id', 'title_key'],
  },
]

const EXPECTED_CHECKS = [
  {
    table: 'elearning_title_heads',
    name: 'elearning_title_heads_identity_check',
    definition: `CHECK ((org_id <> ''::text))`,
  },
  {
    table: 'elearning_title_heads',
    name: 'elearning_title_heads_version_check',
    definition: 'CHECK ((latest_version >= 0))',
  },
  {
    table: 'elearning_title_revisions',
    name: 'elearning_title_revisions_identity_check',
    definition: `CHECK (((version > 0) AND (actor_id <> ''::text)))`,
  },
  {
    table: 'elearning_title_revision_rows',
    name: 'elearning_title_revision_rows_identity_check',
    definition: `CHECK (((title_key <> ''::text) AND (name <> ''::text)))`,
  },
  {
    table: 'elearning_title_revision_rows',
    name: 'elearning_title_revision_rows_threshold_check',
    definition: 'CHECK ((threshold >= 0))',
  },
  {
    table: 'elearning_title_revision_rows',
    name: 'elearning_title_revision_rows_position_check',
    definition: 'CHECK ((position > 0))',
  },
  {
    table: 'elearning_title_publish_requests',
    name: 'elearning_title_publish_requests_identity_check',
    definition: `CHECK (((source_key <> ''::text) AND (actor_id <> ''::text)))`,
  },
  {
    table: 'elearning_title_publish_requests',
    name: 'elearning_title_publish_requests_hash_check',
    definition: `CHECK (((request_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash_version > 0)))`,
  },
  {
    table: 'elearning_title_awards',
    name: 'elearning_title_awards_identity_check',
    definition: `CHECK ((title_key <> ''::text))`,
  },
  {
    table: 'elearning_title_awards',
    name: 'elearning_title_awards_points_check',
    definition: 'CHECK (((threshold >= 0) AND (balance_points >= threshold)))',
  },
] as const

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

function drift(detail: string): never {
  throw new Error(`elearning title migration drift: ${detail}`)
}

function normalizeDefinition(value: string): string {
  return value.toLowerCase().replaceAll('"', '').replace(/\s+/g, '')
}

function normalizeFunctionBody(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

const AWARD_FUNCTION_BODY = `
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('elearning-title-balance-org'),
    hashtext(NEW.org_id)
  );
  INSERT INTO elearning_title_awards (
    id, org_id, user_id, title_key, title_revision_id,
    title_row_id, threshold, balance_points
  )
  SELECT
    gen_random_uuid(), NEW.org_id, NEW.user_id, row.title_key,
    row.revision_id, row.id, row.threshold, NEW.balance_points
  FROM elearning_title_heads head
  JOIN elearning_title_revision_rows row
    ON row.org_id = head.org_id
   AND row.revision_id = head.active_revision_id
  WHERE head.org_id = NEW.org_id
    AND row.threshold <= NEW.balance_points
  ON CONFLICT (org_id, user_id, title_key) DO NOTHING;
  RETURN NEW;
END;
`

async function presentTables(db: Kysely<unknown>): Promise<Set<string>> {
  const result = await sql<{ name: string }>`
    SELECT table_name AS name
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ANY(${sql.val([...TABLES])}::text[])
  `.execute(db)
  return new Set(result.rows.map((row) => row.name))
}

async function assertColumns(
  db: Kysely<unknown>,
  table: (typeof TABLES)[number],
): Promise<void> {
  const result = await sql<ExpectedColumn>`
    SELECT
      attribute.attname AS name,
      type.typname AS type,
      NOT attribute.attnotnull AS nullable,
      pg_get_expr(default_row.adbin, default_row.adrelid) AS default
      FROM pg_attribute attribute
      JOIN pg_class table_row ON table_row.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      JOIN pg_type type ON type.oid = attribute.atttypid
      LEFT JOIN pg_attrdef default_row
        ON default_row.adrelid = attribute.attrelid
       AND default_row.adnum = attribute.attnum
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

async function assertConstraints(db: Kysely<unknown>): Promise<void> {
  for (const expected of EXPECTED_CONSTRAINTS) {
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
      || !actual.validated
      || (expected.type === 'f' && (
        actual.delete_action !== 'r'
        || actual.update_action !== 'r'
        || actual.match_type !== 's'
      ))
    ) drift(expected.name)
  }
}

async function assertChecks(db: Kysely<unknown>): Promise<void> {
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
    table: row.table,
    name: row.name,
    definition: normalizeDefinition(row.definition),
    validated: row.validated,
  }))
  const expected = EXPECTED_CHECKS.map((row) => ({
    table: row.table,
    name: row.name,
    definition: normalizeDefinition(row.definition),
    validated: true,
  })).sort((left, right) => (
    `${left.table}:\0${left.name}`.localeCompare(`${right.table}:\0${right.name}`)
  ))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) drift('check constraint set')
}

async function assertTrigger(
  db: Kysely<unknown>,
  table: string,
  trigger: string,
  expectedType: number,
  functionName: string,
  expectedAttributeNames: string[] = [],
): Promise<void> {
  const result = await sql<{
    type: number
    enabled: string
    qualifier: string | null
    function_name: string
    attributes: string[]
  }>`
    SELECT
      trigger_row.tgtype::int AS type,
      trigger_row.tgenabled::text AS enabled,
      pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid) AS qualifier,
      function_row.proname AS function_name,
      ARRAY(
        SELECT attribute.attname
          FROM unnest(trigger_row.tgattr::int2[]) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = trigger_row.tgrelid
           AND attribute.attnum = key.attnum
         ORDER BY key.position
      )::text[] AS attributes
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${table}
       AND trigger_row.tgname = ${trigger}
       AND NOT trigger_row.tgisinternal
  `.execute(db)
  const actual = result.rows[0]
  if (
    result.rows.length !== 1
    || !actual
    || actual.type !== expectedType
    || actual.enabled !== 'O'
    || actual.qualifier !== null
    || actual.function_name !== functionName
    || actual.attributes.join('\0') !== expectedAttributeNames.join('\0')
  ) drift(trigger)
}

async function assertFunction(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    source: string
    language: string
    return_type: string
    security_definer: boolean
    kind: string
  }>`
    SELECT
      function_row.prosrc AS source,
      language_row.lanname AS language,
      function_row.prorettype::regtype::text AS return_type,
      function_row.prosecdef AS security_definer,
      function_row.prokind::text AS kind
      FROM pg_proc function_row
      JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
      JOIN pg_language language_row ON language_row.oid = function_row.prolang
     WHERE namespace.nspname = current_schema()
       AND function_row.proname = ${AWARD_FUNCTION}
       AND function_row.pronargs = 0
  `.execute(db)
  const actual = result.rows[0]
  if (
    result.rows.length !== 1
    || !actual
    || normalizeFunctionBody(actual.source) !== normalizeFunctionBody(AWARD_FUNCTION_BODY)
    || actual.language !== 'plpgsql'
    || actual.return_type !== 'trigger'
    || actual.security_definer
    || actual.kind !== 'f'
  ) drift(AWARD_FUNCTION)
}

async function assertAuthority(db: Kysely<unknown>): Promise<void> {
  const tables = await presentTables(db)
  if (tables.size !== TABLES.length) drift('table set')
  for (const table of TABLES) await assertColumns(db, table)
  await assertConstraints(db)
  await assertChecks(db)
  for (const table of IMMUTABLE_TABLES) {
    await assertTrigger(db, table, `${table}_immutable_row`, 27, IMMUTABLE_FUNCTION)
    await assertTrigger(db, table, `${table}_immutable_truncate`, 34, IMMUTABLE_FUNCTION)
  }
  await assertFunction(db)
  await assertTrigger(
    db,
    'elearning_credit_balances',
    BALANCE_TRIGGER,
    21,
    AWARD_FUNCTION,
    ['balance_points'],
  )
}

async function createAuthority(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE elearning_title_heads (
      org_id text NOT NULL,
      id uuid NOT NULL,
      active_revision_id uuid,
      latest_version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_title_heads_pk PRIMARY KEY (org_id),
      CONSTRAINT elearning_title_heads_org_id_key UNIQUE (org_id, id),
      CONSTRAINT elearning_title_heads_identity_check CHECK (org_id <> ''),
      CONSTRAINT elearning_title_heads_version_check CHECK (latest_version >= 0)
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_title_revisions (
      id uuid NOT NULL,
      org_id text NOT NULL,
      head_id uuid NOT NULL,
      version integer NOT NULL,
      actor_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_title_revisions_pk PRIMARY KEY (org_id, id),
      CONSTRAINT elearning_title_revisions_head_version_key
        UNIQUE (org_id, head_id, version),
      CONSTRAINT elearning_title_revisions_head_identity_key
        UNIQUE (org_id, head_id, id),
      CONSTRAINT elearning_title_revisions_identity_check
        CHECK (version > 0 AND actor_id <> ''),
      CONSTRAINT elearning_title_revisions_head_fk
        FOREIGN KEY (org_id, head_id)
        REFERENCES elearning_title_heads (org_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT elearning_title_revisions_actor_fk
        FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    ALTER TABLE elearning_title_heads
      ADD CONSTRAINT elearning_title_heads_active_revision_fk
      FOREIGN KEY (org_id, id, active_revision_id)
      REFERENCES elearning_title_revisions (org_id, head_id, id)
      MATCH SIMPLE
      ON UPDATE RESTRICT ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED
  `.execute(db)
  await sql`
    CREATE TABLE elearning_title_revision_rows (
      id uuid NOT NULL,
      org_id text NOT NULL,
      revision_id uuid NOT NULL,
      title_key text NOT NULL,
      name text NOT NULL,
      threshold integer NOT NULL,
      position integer NOT NULL,
      CONSTRAINT elearning_title_revision_rows_pk PRIMARY KEY (org_id, id),
      CONSTRAINT elearning_title_revision_rows_title_key
        UNIQUE (org_id, revision_id, title_key),
      CONSTRAINT elearning_title_revision_rows_threshold_key
        UNIQUE (org_id, revision_id, threshold),
      CONSTRAINT elearning_title_revision_rows_position_key
        UNIQUE (org_id, revision_id, position),
      CONSTRAINT elearning_title_revision_rows_award_key
        UNIQUE (org_id, revision_id, id, title_key),
      CONSTRAINT elearning_title_revision_rows_identity_check
        CHECK (title_key <> '' AND name <> ''),
      CONSTRAINT elearning_title_revision_rows_threshold_check CHECK (threshold >= 0),
      CONSTRAINT elearning_title_revision_rows_position_check CHECK (position > 0),
      CONSTRAINT elearning_title_revision_rows_revision_fk
        FOREIGN KEY (org_id, revision_id)
        REFERENCES elearning_title_revisions (org_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_title_publish_requests (
      org_id text NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      actor_id text NOT NULL,
      revision_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_title_publish_requests_pk PRIMARY KEY (org_id, source_key),
      CONSTRAINT elearning_title_publish_requests_identity_check
        CHECK (source_key <> '' AND actor_id <> ''),
      CONSTRAINT elearning_title_publish_requests_hash_check
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_title_publish_requests_actor_fk
        FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT elearning_title_publish_requests_revision_fk
        FOREIGN KEY (org_id, revision_id)
        REFERENCES elearning_title_revisions (org_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_title_awards (
      id uuid NOT NULL,
      org_id text NOT NULL,
      user_id text NOT NULL,
      title_key text NOT NULL,
      title_revision_id uuid NOT NULL,
      title_row_id uuid NOT NULL,
      threshold integer NOT NULL,
      balance_points integer NOT NULL,
      awarded_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_title_awards_pk PRIMARY KEY (org_id, id),
      CONSTRAINT elearning_title_awards_milestone_key
        UNIQUE (org_id, user_id, title_key),
      CONSTRAINT elearning_title_awards_identity_check CHECK (title_key <> ''),
      CONSTRAINT elearning_title_awards_points_check
        CHECK (threshold >= 0 AND balance_points >= threshold),
      CONSTRAINT elearning_title_awards_user_fk
        FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT elearning_title_awards_row_fk
        FOREIGN KEY (org_id, title_revision_id, title_row_id, title_key)
        REFERENCES elearning_title_revision_rows (org_id, revision_id, id, title_key)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `.execute(db)

  for (const table of IMMUTABLE_TABLES) {
    await sql.raw(`
      CREATE TRIGGER ${table}_immutable_row
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${IMMUTABLE_FUNCTION}()
    `).execute(db)
    await sql.raw(`
      CREATE TRIGGER ${table}_immutable_truncate
      BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION ${IMMUTABLE_FUNCTION}()
    `).execute(db)
  }
  await sql.raw(`
    CREATE FUNCTION ${AWARD_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    AS $elearning_title_award$
    ${AWARD_FUNCTION_BODY}
    $elearning_title_award$
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${BALANCE_TRIGGER}
    AFTER INSERT OR UPDATE OF balance_points ON elearning_credit_balances
    FOR EACH ROW EXECUTE FUNCTION ${AWARD_FUNCTION}()
  `).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureCanonicalUserOrgsTable(db)
  const immutable = await sql<{ present: boolean }>`
    SELECT to_regprocedure(${`${IMMUTABLE_FUNCTION}()`}) IS NOT NULL AS present
  `.execute(db)
  const balances = await sql<{ present: boolean }>`
    SELECT to_regclass('elearning_credit_balances') IS NOT NULL AS present
  `.execute(db)
  if (!immutable.rows[0]?.present || !balances.rows[0]?.present) {
    drift('credit authority prerequisite')
  }
  const tables = await presentTables(db)
  if (tables.size === 0) await createAuthority(db)
  else if (tables.size !== TABLES.length) drift('partial table set')
  await assertAuthority(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tables = await presentTables(db)
  if (tables.size === 0) return
  if (tables.size !== TABLES.length) drift('partial table set')
  await assertAuthority(db)
  const rows = await sql<{ has_rows: boolean }>`
    SELECT
      EXISTS (SELECT 1 FROM elearning_title_heads LIMIT 1)
      OR EXISTS (SELECT 1 FROM elearning_title_revisions LIMIT 1)
      OR EXISTS (SELECT 1 FROM elearning_title_revision_rows LIMIT 1)
      OR EXISTS (SELECT 1 FROM elearning_title_publish_requests LIMIT 1)
      OR EXISTS (SELECT 1 FROM elearning_title_awards LIMIT 1)
      AS has_rows
  `.execute(db)
  if (rows.rows[0]?.has_rows) {
    throw new Error('elearning title migration down refused: authoritative rows exist')
  }
  await sql.raw(`DROP TRIGGER ${BALANCE_TRIGGER} ON elearning_credit_balances`).execute(db)
  await sql.raw(`DROP FUNCTION ${AWARD_FUNCTION}()`).execute(db)
  await sql`ALTER TABLE elearning_title_heads DROP CONSTRAINT elearning_title_heads_active_revision_fk`
    .execute(db)
  await sql`DROP TABLE elearning_title_awards`.execute(db)
  await sql`DROP TABLE elearning_title_publish_requests`.execute(db)
  await sql`DROP TABLE elearning_title_revision_rows`.execute(db)
  await sql`DROP TABLE elearning_title_revisions`.execute(db)
  await sql`DROP TABLE elearning_title_heads`.execute(db)
}
