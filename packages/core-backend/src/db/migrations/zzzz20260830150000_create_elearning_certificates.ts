import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { ensureCanonicalUserOrgsTable } from './_ensure-user-orgs'

const TABLES = [
  'elearning_certificate_heads',
  'elearning_certificate_revisions',
  'elearning_certificate_template_requests',
  'elearning_certificate_issues',
] as const
const IMMUTABLE_TABLES = TABLES.slice(1)
const IMMUTABLE_FUNCTION = 'elearning_credit_reject_immutable_write'
const IMMUTABLE_FUNCTION_SOURCE = `BEGIN
      RAISE EXCEPTION 'ELEARNING_CREDIT_IMMUTABLE';
    END;`

type ExpectedColumn = {
  name: string
  type: string
  nullable: boolean
  default: string | null
}

const EXPECTED_COLUMNS: Record<(typeof TABLES)[number], ExpectedColumn[]> = {
  elearning_certificate_heads: [
    { name: 'org_id', type: 'text', nullable: false, default: null },
    { name: 'certificate_key', type: 'text', nullable: false, default: null },
    { name: 'id', type: 'uuid', nullable: false, default: null },
    { name: 'active_revision_id', type: 'uuid', nullable: true, default: null },
    { name: 'latest_version', type: 'int4', nullable: false, default: '0' },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
    { name: 'updated_at', type: 'timestamptz', nullable: false, default: 'now()' },
  ],
  elearning_certificate_revisions: [
    { name: 'id', type: 'uuid', nullable: false, default: null },
    { name: 'org_id', type: 'text', nullable: false, default: null },
    { name: 'head_id', type: 'uuid', nullable: false, default: null },
    { name: 'certificate_key', type: 'text', nullable: false, default: null },
    { name: 'version', type: 'int4', nullable: false, default: null },
    { name: 'actor_id', type: 'text', nullable: false, default: null },
    { name: 'name', type: 'text', nullable: false, default: null },
    { name: 'template_text', type: 'text', nullable: false, default: null },
    { name: 'background_image_url', type: 'text', nullable: true, default: null },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
  ],
  elearning_certificate_template_requests: [
    { name: 'org_id', type: 'text', nullable: false, default: null },
    { name: 'source_key', type: 'text', nullable: false, default: null },
    { name: 'request_hash', type: 'text', nullable: false, default: null },
    { name: 'request_hash_version', type: 'int2', nullable: false, default: null },
    { name: 'actor_id', type: 'text', nullable: false, default: null },
    { name: 'revision_id', type: 'uuid', nullable: false, default: null },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
  ],
  elearning_certificate_issues: [
    { name: 'id', type: 'uuid', nullable: false, default: null },
    { name: 'org_id', type: 'text', nullable: false, default: null },
    { name: 'user_id', type: 'text', nullable: false, default: null },
    { name: 'certificate_key', type: 'text', nullable: false, default: null },
    { name: 'template_revision_id', type: 'uuid', nullable: false, default: null },
    { name: 'actor_id', type: 'text', nullable: false, default: null },
    { name: 'source_key', type: 'text', nullable: false, default: null },
    { name: 'effect_key', type: 'text', nullable: false, default: null },
    { name: 'request_hash', type: 'text', nullable: false, default: null },
    { name: 'request_hash_version', type: 'int2', nullable: false, default: null },
    { name: 'serial_number', type: 'uuid', nullable: false, default: null },
    { name: 'parameter_snapshot', type: 'jsonb', nullable: false, default: null },
    { name: 'issued_at', type: 'timestamptz', nullable: false, default: null },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
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
    table: 'elearning_certificate_heads',
    name: 'elearning_certificate_heads_pk',
    type: 'p',
    columns: ['org_id', 'certificate_key'],
  },
  {
    table: 'elearning_certificate_heads',
    name: 'elearning_certificate_heads_identity_key',
    type: 'u',
    columns: ['org_id', 'id'],
  },
  {
    table: 'elearning_certificate_heads',
    name: 'elearning_certificate_heads_certificate_identity_key',
    type: 'u',
    columns: ['org_id', 'certificate_key', 'id'],
  },
  {
    table: 'elearning_certificate_heads',
    name: 'elearning_certificate_heads_active_revision_fk',
    type: 'f',
    columns: ['org_id', 'id', 'active_revision_id'],
    referencedTable: 'elearning_certificate_revisions',
    referencedColumns: ['org_id', 'head_id', 'id'],
    deferrable: true,
    deferred: true,
  },
  {
    table: 'elearning_certificate_revisions',
    name: 'elearning_certificate_revisions_pk',
    type: 'p',
    columns: ['org_id', 'id'],
  },
  {
    table: 'elearning_certificate_revisions',
    name: 'elearning_certificate_revisions_head_version_key',
    type: 'u',
    columns: ['org_id', 'head_id', 'version'],
  },
  {
    table: 'elearning_certificate_revisions',
    name: 'elearning_certificate_revisions_head_identity_key',
    type: 'u',
    columns: ['org_id', 'head_id', 'id'],
  },
  {
    table: 'elearning_certificate_revisions',
    name: 'elearning_certificate_revisions_certificate_identity_key',
    type: 'u',
    columns: ['org_id', 'certificate_key', 'id'],
  },
  {
    table: 'elearning_certificate_revisions',
    name: 'elearning_certificate_revisions_head_fk',
    type: 'f',
    columns: ['org_id', 'certificate_key', 'head_id'],
    referencedTable: 'elearning_certificate_heads',
    referencedColumns: ['org_id', 'certificate_key', 'id'],
  },
  {
    table: 'elearning_certificate_revisions',
    name: 'elearning_certificate_revisions_actor_fk',
    type: 'f',
    columns: ['actor_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
  },
  {
    table: 'elearning_certificate_template_requests',
    name: 'elearning_certificate_template_requests_pk',
    type: 'p',
    columns: ['org_id', 'source_key'],
  },
  {
    table: 'elearning_certificate_template_requests',
    name: 'elearning_certificate_template_requests_actor_fk',
    type: 'f',
    columns: ['actor_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
  },
  {
    table: 'elearning_certificate_template_requests',
    name: 'elearning_certificate_template_requests_revision_fk',
    type: 'f',
    columns: ['org_id', 'revision_id'],
    referencedTable: 'elearning_certificate_revisions',
    referencedColumns: ['org_id', 'id'],
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_pk',
    type: 'p',
    columns: ['org_id', 'id'],
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_source_key',
    type: 'u',
    columns: ['org_id', 'source_key'],
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_effect_key',
    type: 'u',
    columns: ['org_id', 'user_id', 'certificate_key', 'effect_key'],
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_serial_key',
    type: 'u',
    columns: ['org_id', 'serial_number'],
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_user_fk',
    type: 'f',
    columns: ['user_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_actor_fk',
    type: 'f',
    columns: ['actor_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_revision_fk',
    type: 'f',
    columns: ['org_id', 'certificate_key', 'template_revision_id'],
    referencedTable: 'elearning_certificate_revisions',
    referencedColumns: ['org_id', 'certificate_key', 'id'],
  },
]

const EXPECTED_CHECKS = [
  {
    table: 'elearning_certificate_heads',
    name: 'elearning_certificate_heads_identity_check',
    definition: `CHECK (((org_id <> ''::text) AND (certificate_key <> ''::text)))`,
  },
  {
    table: 'elearning_certificate_heads',
    name: 'elearning_certificate_heads_version_check',
    definition: 'CHECK ((latest_version >= 0))',
  },
  {
    table: 'elearning_certificate_revisions',
    name: 'elearning_certificate_revisions_identity_check',
    definition: `CHECK (((certificate_key <> ''::text) AND (version > 0) AND (actor_id <> ''::text) AND (name <> ''::text)))`,
  },
  {
    table: 'elearning_certificate_revisions',
    name: 'elearning_certificate_revisions_background_check',
    definition: `CHECK (((background_image_url IS NULL) OR (background_image_url ~ '^https://'::text)))`,
  },
  {
    table: 'elearning_certificate_template_requests',
    name: 'elearning_certificate_template_requests_identity_check',
    definition: `CHECK (((source_key <> ''::text) AND (actor_id <> ''::text)))`,
  },
  {
    table: 'elearning_certificate_template_requests',
    name: 'elearning_certificate_template_requests_hash_check',
    definition: `CHECK (((request_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash_version > 0)))`,
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_identity_check',
    definition: `CHECK (((user_id <> ''::text) AND (certificate_key <> ''::text) AND (actor_id <> ''::text) AND (source_key <> ''::text) AND (effect_key <> ''::text)))`,
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_hash_check',
    definition: `CHECK (((request_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash_version > 0)))`,
  },
  {
    table: 'elearning_certificate_issues',
    name: 'elearning_certificate_issues_parameters_check',
    definition: `CHECK ((jsonb_typeof(parameter_snapshot) = 'object'::text))`,
  },
] as const

type CatalogConstraint = {
  table: string
  name: string
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
  throw new Error(`elearning certificate migration drift: ${detail}`)
}

function canonicalizeDefinition(value: string): string {
  let result = ''
  let inLiteral = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "'") {
      result += character
      if (inLiteral && value[index + 1] === "'") {
        result += value[index + 1]
        index += 1
      } else {
        inLiteral = !inLiteral
      }
    } else if (inLiteral) {
      result += character
    } else if (character !== '"' && !/\s/.test(character)) {
      result += character.toLowerCase()
    }
  }
  return result
}

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

async function assertConstraints(db: Kysely<unknown>): Promise<void> {
  const result = await sql<CatalogConstraint>`
    SELECT
      table_row.relname AS table,
      constraint_row.conname AS name,
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
       AND table_row.relname = ANY(${sql.val([...TABLES])}::text[])
       AND constraint_row.contype IN ('p', 'u', 'f')
     ORDER BY table_row.relname, constraint_row.conname
  `.execute(db)
  const actual = result.rows.map((row) => ({
    ...row,
    referenced_columns: row.referenced_columns ?? [],
  }))
  const expected = EXPECTED_CONSTRAINTS.map((row) => ({
    table: row.table,
    name: row.name,
    type: row.type,
    columns: row.columns,
    referenced_table: row.referencedTable ?? null,
    referenced_columns: row.referencedColumns ?? [],
    deferrable: row.deferrable ?? false,
    deferred: row.deferred ?? false,
    validated: true,
    delete_action: row.type === 'f' ? 'r' : ' ',
    update_action: row.type === 'f' ? 'r' : ' ',
    match_type: row.type === 'f' ? 's' : ' ',
  })).sort((left, right) => (
    `${left.table}:\0${left.name}`.localeCompare(`${right.table}:\0${right.name}`)
  ))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) drift('constraint set')
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
    definition: canonicalizeDefinition(row.definition),
    validated: row.validated,
  }))
  const expected = EXPECTED_CHECKS.map((row) => ({
    table: row.table,
    name: row.name,
    definition: canonicalizeDefinition(row.definition),
    validated: true,
  })).sort((left, right) => (
    `${left.table}:\0${left.name}`.localeCompare(`${right.table}:\0${right.name}`)
  ))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) drift('check constraint set')
}

async function assertImmutableTrigger(
  db: Kysely<unknown>,
  table: string,
  trigger: string,
  expectedType: number,
): Promise<void> {
  const result = await sql<{
    type: number
    enabled: string
    qualifier: string | null
    function_name: string
    function_in_schema: boolean
    attributes: string[]
  }>`
    SELECT
      trigger_row.tgtype::int AS type,
      trigger_row.tgenabled::text AS enabled,
      pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid) AS qualifier,
      function_row.proname AS function_name,
      function_row.pronamespace = namespace.oid AS function_in_schema,
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
    || actual.function_name !== IMMUTABLE_FUNCTION
    || !actual.function_in_schema
    || actual.attributes.length !== 0
  ) drift(trigger)
}

async function assertImmutableFunction(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    source: string
    language: string
    return_type: string
    security_definer: boolean
  }>`
    SELECT
      function_row.prosrc AS source,
      language_row.lanname AS language,
      function_row.prorettype::regtype::text AS return_type,
      function_row.prosecdef AS security_definer
      FROM pg_proc function_row
      JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
      JOIN pg_language language_row ON language_row.oid = function_row.prolang
     WHERE namespace.nspname = current_schema()
       AND function_row.proname = ${IMMUTABLE_FUNCTION}
       AND function_row.pronargs = 0
  `.execute(db)
  const actual = result.rows[0]
  if (
    result.rows.length !== 1
    || !actual
    || actual.source.trim() !== IMMUTABLE_FUNCTION_SOURCE
    || actual.language !== 'plpgsql'
    || actual.return_type !== 'trigger'
    || actual.security_definer
  ) drift('immutable function')
}

async function assertAuthority(db: Kysely<unknown>): Promise<void> {
  const tables = await presentTables(db)
  if (tables.size !== TABLES.length) drift('table set')
  for (const table of TABLES) await assertColumns(db, table)
  await assertConstraints(db)
  await assertChecks(db)
  for (const table of IMMUTABLE_TABLES) {
    await assertImmutableTrigger(db, table, `${table}_immutable_row`, 27)
    await assertImmutableTrigger(db, table, `${table}_immutable_truncate`, 34)
  }
  await assertImmutableFunction(db)
}

async function createAuthority(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE elearning_certificate_heads (
      org_id text NOT NULL,
      certificate_key text NOT NULL,
      id uuid NOT NULL,
      active_revision_id uuid,
      latest_version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_certificate_heads_pk PRIMARY KEY (org_id, certificate_key),
      CONSTRAINT elearning_certificate_heads_identity_key UNIQUE (org_id, id),
      CONSTRAINT elearning_certificate_heads_certificate_identity_key
        UNIQUE (org_id, certificate_key, id),
      CONSTRAINT elearning_certificate_heads_identity_check
        CHECK (org_id <> '' AND certificate_key <> ''),
      CONSTRAINT elearning_certificate_heads_version_check CHECK (latest_version >= 0)
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_certificate_revisions (
      id uuid NOT NULL,
      org_id text NOT NULL,
      head_id uuid NOT NULL,
      certificate_key text NOT NULL,
      version integer NOT NULL,
      actor_id text NOT NULL,
      name text NOT NULL,
      template_text text NOT NULL,
      background_image_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_certificate_revisions_pk PRIMARY KEY (org_id, id),
      CONSTRAINT elearning_certificate_revisions_head_version_key
        UNIQUE (org_id, head_id, version),
      CONSTRAINT elearning_certificate_revisions_head_identity_key
        UNIQUE (org_id, head_id, id),
      CONSTRAINT elearning_certificate_revisions_certificate_identity_key
        UNIQUE (org_id, certificate_key, id),
      CONSTRAINT elearning_certificate_revisions_identity_check
        CHECK (certificate_key <> '' AND version > 0 AND actor_id <> '' AND name <> ''),
      CONSTRAINT elearning_certificate_revisions_background_check
        CHECK (background_image_url IS NULL OR background_image_url ~ '^https://'),
      CONSTRAINT elearning_certificate_revisions_head_fk
        FOREIGN KEY (org_id, certificate_key, head_id)
        REFERENCES elearning_certificate_heads (org_id, certificate_key, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT elearning_certificate_revisions_actor_fk
        FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    ALTER TABLE elearning_certificate_heads
      ADD CONSTRAINT elearning_certificate_heads_active_revision_fk
      FOREIGN KEY (org_id, id, active_revision_id)
      REFERENCES elearning_certificate_revisions (org_id, head_id, id)
      MATCH SIMPLE
      ON UPDATE RESTRICT ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED
  `.execute(db)
  await sql`
    CREATE TABLE elearning_certificate_template_requests (
      org_id text NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      actor_id text NOT NULL,
      revision_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_certificate_template_requests_pk
        PRIMARY KEY (org_id, source_key),
      CONSTRAINT elearning_certificate_template_requests_identity_check
        CHECK (source_key <> '' AND actor_id <> ''),
      CONSTRAINT elearning_certificate_template_requests_hash_check
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_certificate_template_requests_actor_fk
        FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT elearning_certificate_template_requests_revision_fk
        FOREIGN KEY (org_id, revision_id)
        REFERENCES elearning_certificate_revisions (org_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_certificate_issues (
      id uuid NOT NULL,
      org_id text NOT NULL,
      user_id text NOT NULL,
      certificate_key text NOT NULL,
      template_revision_id uuid NOT NULL,
      actor_id text NOT NULL,
      source_key text NOT NULL,
      effect_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      serial_number uuid NOT NULL,
      parameter_snapshot jsonb NOT NULL,
      issued_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_certificate_issues_pk PRIMARY KEY (org_id, id),
      CONSTRAINT elearning_certificate_issues_source_key UNIQUE (org_id, source_key),
      CONSTRAINT elearning_certificate_issues_effect_key
        UNIQUE (org_id, user_id, certificate_key, effect_key),
      CONSTRAINT elearning_certificate_issues_serial_key UNIQUE (org_id, serial_number),
      CONSTRAINT elearning_certificate_issues_identity_check
        CHECK (
          user_id <> '' AND certificate_key <> '' AND actor_id <> ''
          AND source_key <> '' AND effect_key <> ''
        ),
      CONSTRAINT elearning_certificate_issues_hash_check
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_certificate_issues_parameters_check
        CHECK (jsonb_typeof(parameter_snapshot) = 'object'),
      CONSTRAINT elearning_certificate_issues_user_fk
        FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT elearning_certificate_issues_actor_fk
        FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT elearning_certificate_issues_revision_fk
        FOREIGN KEY (org_id, certificate_key, template_revision_id)
        REFERENCES elearning_certificate_revisions (org_id, certificate_key, id)
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
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureCanonicalUserOrgsTable(db)
  const immutable = await sql<{ present: boolean }>`
    SELECT to_regprocedure(${`${IMMUTABLE_FUNCTION}()`}) IS NOT NULL AS present
  `.execute(db)
  if (!immutable.rows[0]?.present) drift('credit authority prerequisite')
  await assertImmutableFunction(db)
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
      EXISTS (SELECT 1 FROM elearning_certificate_heads LIMIT 1)
      OR EXISTS (SELECT 1 FROM elearning_certificate_revisions LIMIT 1)
      OR EXISTS (SELECT 1 FROM elearning_certificate_template_requests LIMIT 1)
      OR EXISTS (SELECT 1 FROM elearning_certificate_issues LIMIT 1)
      AS has_rows
  `.execute(db)
  if (rows.rows[0]?.has_rows) {
    throw new Error('elearning certificate migration down refused: authoritative rows exist')
  }
  await sql`
    ALTER TABLE elearning_certificate_heads
      DROP CONSTRAINT elearning_certificate_heads_active_revision_fk
  `.execute(db)
  await sql`DROP TABLE elearning_certificate_issues`.execute(db)
  await sql`DROP TABLE elearning_certificate_template_requests`.execute(db)
  await sql`DROP TABLE elearning_certificate_revisions`.execute(db)
  await sql`DROP TABLE elearning_certificate_heads`.execute(db)
}
