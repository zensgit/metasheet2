import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { ensureCanonicalUserOrgsTable } from './_ensure-user-orgs'

export const ELEARNING_PORTAL_TABLES = [
  'elearning_portal_revisions',
  'elearning_portal_revision_navigation',
  'elearning_portal_heads',
  'elearning_portal_publish_requests',
] as const

export const ELEARNING_PORTAL_IMMUTABLE_FUNCTION =
  'elearning_portal_reject_immutable_write'
export const ELEARNING_PORTAL_IMMUTABLE_TRIGGERS = [
  'trg_elearning_portal_revisions_immutable',
  'trg_elearning_portal_revision_navigation_immutable',
  'trg_elearning_portal_publish_requests_immutable',
] as const

const EXPECTED_CHECKS = [
  {
    name: 'elearning_portal_heads_version_check',
    definition: 'CHECK ((latest_version > 0))',
  },
  {
    name: 'elearning_portal_publish_requests_hash_check',
    definition: `CHECK (((request_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash_version > 0)))`,
  },
  {
    name: 'elearning_portal_publish_requests_identity_check',
    definition: `CHECK (((org_id <> ''::text) AND (source_key <> ''::text) AND (actor_id <> ''::text)))`,
  },
  {
    name: 'elearning_portal_revision_navigation_content_check',
    definition: `CHECK ((((position >= 1) AND (position <= 8)) AND ((char_length(label) >= 1) AND (char_length(label) <= 40)) AND ((char_length(href) >= 1) AND (char_length(href) <= 512)) AND (left(href, 1) = '/'::text) AND (left(href, 2) <> '//'::text) AND (POSITION((chr(92)) IN (href)) = 0)))`,
  },
  {
    name: 'elearning_portal_revisions_content_check',
    definition: `CHECK ((((char_length(site_name) >= 1) AND (char_length(site_name) <= 80)) AND ((tagline IS NULL) OR ((char_length(tagline) >= 1) AND (char_length(tagline) <= 160))) AND ((banner_url IS NULL) OR (((char_length(banner_url) >= 1) AND (char_length(banner_url) <= 512)) AND ((banner_url ~~ 'https://%'::text) OR ((left(banner_url, 1) = '/'::text) AND (left(banner_url, 2) <> '//'::text)))))))`,
  },
  {
    name: 'elearning_portal_revisions_identity_check',
    definition: `CHECK (((org_id <> ''::text) AND (version > 0) AND (actor_id <> ''::text)))`,
  },
] as const

async function presentTables(db: Kysely<unknown>): Promise<Set<string>> {
  const result = await sql<{ name: string }>`
    SELECT table_name AS name
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ANY(${sql.val([...ELEARNING_PORTAL_TABLES])}::text[])
  `.execute(db)
  return new Set(result.rows.map((row) => row.name))
}

function drift(detail: string): never {
  throw new Error(`elearning portal migration drift: ${detail}`)
}

function canonicalizeDefinition(value: string): string {
  return value.replaceAll('"', '').replace(/\s+/g, '')
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
    type: 'c' | 'f' | 'p' | 'u'
    columns: string[]
    referencedTable?: string
    referencedColumns?: string[]
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
    || (expected.type === 'f' && (
      actual.delete_action !== 'r'
      || actual.update_action !== 'a'
      || actual.match_type !== 's'
    ))
  ) drift(expected.name)
}

async function assertPortalAuthority(db: Kysely<unknown>): Promise<void> {
  const tables = await presentTables(db)
  if (tables.size !== ELEARNING_PORTAL_TABLES.length) drift('table set')

  const columns = await sql<{
    table_name: string
    column_name: string
    type_name: string
    not_null: boolean
  }>`
    SELECT
      table_row.relname AS table_name,
      attribute.attname AS column_name,
      type.typname AS type_name,
      attribute.attnotnull AS not_null
      FROM pg_attribute attribute
      JOIN pg_class table_row ON table_row.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      JOIN pg_type type ON type.oid = attribute.atttypid
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ANY(${sql.val([...ELEARNING_PORTAL_TABLES])}::text[])
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY table_row.relname, attribute.attnum
  `.execute(db)
  const signatures = columns.rows.map((row) =>
    `${row.table_name}.${row.column_name}:${row.type_name}:${row.not_null ? 'required' : 'nullable'}`,
  )
  const expected = [
    'elearning_portal_heads.org_id:text:required',
    'elearning_portal_heads.active_revision_id:uuid:required',
    'elearning_portal_heads.latest_version:int4:required',
    'elearning_portal_heads.created_at:timestamptz:required',
    'elearning_portal_heads.updated_at:timestamptz:required',
    'elearning_portal_publish_requests.org_id:text:required',
    'elearning_portal_publish_requests.source_key:text:required',
    'elearning_portal_publish_requests.request_hash:text:required',
    'elearning_portal_publish_requests.request_hash_version:int2:required',
    'elearning_portal_publish_requests.actor_id:text:required',
    'elearning_portal_publish_requests.revision_id:uuid:required',
    'elearning_portal_publish_requests.created_at:timestamptz:required',
    'elearning_portal_revision_navigation.org_id:text:required',
    'elearning_portal_revision_navigation.revision_id:uuid:required',
    'elearning_portal_revision_navigation.position:int2:required',
    'elearning_portal_revision_navigation.label:text:required',
    'elearning_portal_revision_navigation.href:text:required',
    'elearning_portal_revisions.id:uuid:required',
    'elearning_portal_revisions.org_id:text:required',
    'elearning_portal_revisions.version:int4:required',
    'elearning_portal_revisions.site_name:text:required',
    'elearning_portal_revisions.tagline:text:nullable',
    'elearning_portal_revisions.banner_url:text:nullable',
    'elearning_portal_revisions.actor_id:text:required',
    'elearning_portal_revisions.created_at:timestamptz:required',
  ].sort()
  if (JSON.stringify(signatures.sort()) !== JSON.stringify(expected)) drift('column set')

  for (const expected of [
    { table: 'elearning_portal_revisions', name: 'elearning_portal_revisions_pk', type: 'p', columns: ['org_id', 'id'] },
    { table: 'elearning_portal_revisions', name: 'elearning_portal_revisions_org_version_key', type: 'u', columns: ['org_id', 'version'] },
    { table: 'elearning_portal_revisions', name: 'elearning_portal_revisions_head_ref_key', type: 'u', columns: ['org_id', 'id', 'version'] },
    { table: 'elearning_portal_revisions', name: 'elearning_portal_revisions_identity_check', type: 'c', columns: ['org_id', 'version', 'actor_id'] },
    { table: 'elearning_portal_revisions', name: 'elearning_portal_revisions_content_check', type: 'c', columns: ['site_name', 'tagline', 'banner_url'] },
    { table: 'elearning_portal_revisions', name: 'elearning_portal_revisions_actor_fk', type: 'f', columns: ['actor_id', 'org_id'], referencedTable: 'user_orgs', referencedColumns: ['user_id', 'org_id'] },
    { table: 'elearning_portal_revision_navigation', name: 'elearning_portal_revision_navigation_pk', type: 'p', columns: ['org_id', 'revision_id', 'position'] },
    { table: 'elearning_portal_revision_navigation', name: 'elearning_portal_revision_navigation_href_key', type: 'u', columns: ['org_id', 'revision_id', 'href'] },
    { table: 'elearning_portal_revision_navigation', name: 'elearning_portal_revision_navigation_content_check', type: 'c', columns: ['position', 'label', 'href'] },
    { table: 'elearning_portal_revision_navigation', name: 'elearning_portal_revision_navigation_revision_fk', type: 'f', columns: ['org_id', 'revision_id'], referencedTable: 'elearning_portal_revisions', referencedColumns: ['org_id', 'id'] },
    { table: 'elearning_portal_heads', name: 'elearning_portal_heads_pk', type: 'p', columns: ['org_id'] },
    { table: 'elearning_portal_heads', name: 'elearning_portal_heads_version_check', type: 'c', columns: ['latest_version'] },
    { table: 'elearning_portal_heads', name: 'elearning_portal_heads_active_revision_fk', type: 'f', columns: ['org_id', 'active_revision_id', 'latest_version'], referencedTable: 'elearning_portal_revisions', referencedColumns: ['org_id', 'id', 'version'] },
    { table: 'elearning_portal_publish_requests', name: 'elearning_portal_publish_requests_pk', type: 'p', columns: ['org_id', 'source_key'] },
    { table: 'elearning_portal_publish_requests', name: 'elearning_portal_publish_requests_identity_check', type: 'c', columns: ['org_id', 'source_key', 'actor_id'] },
    { table: 'elearning_portal_publish_requests', name: 'elearning_portal_publish_requests_hash_check', type: 'c', columns: ['request_hash', 'request_hash_version'] },
    { table: 'elearning_portal_publish_requests', name: 'elearning_portal_publish_requests_actor_fk', type: 'f', columns: ['actor_id', 'org_id'], referencedTable: 'user_orgs', referencedColumns: ['user_id', 'org_id'] },
    { table: 'elearning_portal_publish_requests', name: 'elearning_portal_publish_requests_revision_fk', type: 'f', columns: ['org_id', 'revision_id'], referencedTable: 'elearning_portal_revisions', referencedColumns: ['org_id', 'id'] },
  ] as const) {
    await assertConstraint(db, {
      ...expected,
      columns: [...expected.columns],
      referencedColumns: 'referencedColumns' in expected
        ? [...expected.referencedColumns]
        : undefined,
    })
  }

  const checks = await sql<{ name: string; definition: string; validated: boolean }>`
    SELECT
      constraint_row.conname AS name,
      pg_get_constraintdef(constraint_row.oid) AS definition,
      constraint_row.convalidated AS validated
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ANY(${sql.val([...ELEARNING_PORTAL_TABLES])}::text[])
       AND constraint_row.contype = 'c'
     ORDER BY constraint_row.conname
  `.execute(db)
  const actualChecks = checks.rows.map((row) => ({
    name: row.name,
    definition: canonicalizeDefinition(row.definition),
    validated: row.validated,
  }))
  const expectedChecks = EXPECTED_CHECKS.map((row) => ({
    name: row.name,
    definition: canonicalizeDefinition(row.definition),
    validated: true,
  }))
  if (JSON.stringify(actualChecks) !== JSON.stringify(expectedChecks)) {
    drift('check constraint set')
  }

  const immutable = await sql<{
    trigger_name: string
    table_name: string
    enabled: string
    trigger_type: number
    when_clause: string | null
    update_columns: number
    function_name: string
    language_name: string
    security_definer: boolean
    body: string
  }>`
    SELECT
      trigger_row.tgname AS trigger_name,
      table_row.relname AS table_name,
      trigger_row.tgenabled::text AS enabled,
      trigger_row.tgtype::int AS trigger_type,
      pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid) AS when_clause,
      cardinality(trigger_row.tgattr::smallint[]) AS update_columns,
      function_row.proname AS function_name,
      language_row.lanname AS language_name,
      function_row.prosecdef AS security_definer,
      function_row.prosrc AS body
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
      JOIN pg_language language_row ON language_row.oid = function_row.prolang
     WHERE namespace.nspname = current_schema()
       AND trigger_row.tgname = ANY(${sql.val([...ELEARNING_PORTAL_IMMUTABLE_TRIGGERS])}::text[])
       AND NOT trigger_row.tgisinternal
     ORDER BY trigger_row.tgname
  `.execute(db)
  if (immutable.rows.length !== ELEARNING_PORTAL_IMMUTABLE_TRIGGERS.length) {
    drift('immutable trigger set')
  }
  for (const row of immutable.rows) {
    if (
      row.enabled !== 'O'
      || row.trigger_type !== 27
      || row.when_clause !== null
      || row.update_columns !== 0
      || row.function_name !== ELEARNING_PORTAL_IMMUTABLE_FUNCTION
      || row.language_name !== 'plpgsql'
      || row.security_definer
      || row.body.replace(/\r\n/g, '\n').trim()
        !== `BEGIN
        RAISE EXCEPTION 'ELEARNING_PORTAL_IMMUTABLE';
      END;`
    ) drift(`immutable trigger ${row.trigger_name}`)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureCanonicalUserOrgsTable(db)
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  const before = await presentTables(db)
  if (before.size !== 0 && before.size !== ELEARNING_PORTAL_TABLES.length) {
    drift('partial table set')
  }

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_portal_revisions (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      version integer NOT NULL,
      site_name text NOT NULL,
      tagline text,
      banner_url text,
      actor_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_portal_revisions_pk PRIMARY KEY (org_id, id),
      CONSTRAINT elearning_portal_revisions_org_version_key UNIQUE (org_id, version),
      CONSTRAINT elearning_portal_revisions_head_ref_key UNIQUE (org_id, id, version),
      CONSTRAINT elearning_portal_revisions_identity_check
        CHECK (org_id <> '' AND version > 0 AND actor_id <> ''),
      CONSTRAINT elearning_portal_revisions_content_check CHECK (
        char_length(site_name) BETWEEN 1 AND 80
        AND (tagline IS NULL OR char_length(tagline) BETWEEN 1 AND 160)
        AND (
          banner_url IS NULL
          OR (
            char_length(banner_url) BETWEEN 1 AND 512
            AND (
              banner_url LIKE 'https://%'
              OR (left(banner_url, 1) = '/' AND left(banner_url, 2) <> '//')
            )
          )
        )
      ),
      CONSTRAINT elearning_portal_revisions_actor_fk
        FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_portal_revision_navigation (
      org_id text NOT NULL,
      revision_id uuid NOT NULL,
      position smallint NOT NULL,
      label text NOT NULL,
      href text NOT NULL,
      CONSTRAINT elearning_portal_revision_navigation_pk
        PRIMARY KEY (org_id, revision_id, position),
      CONSTRAINT elearning_portal_revision_navigation_href_key
        UNIQUE (org_id, revision_id, href),
      CONSTRAINT elearning_portal_revision_navigation_content_check CHECK (
        position BETWEEN 1 AND 8
        AND char_length(label) BETWEEN 1 AND 40
        AND char_length(href) BETWEEN 1 AND 512
        AND left(href, 1) = '/'
        AND left(href, 2) <> '//'
        AND position(chr(92) in href) = 0
      ),
      CONSTRAINT elearning_portal_revision_navigation_revision_fk
        FOREIGN KEY (org_id, revision_id)
        REFERENCES elearning_portal_revisions (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_portal_heads (
      org_id text NOT NULL,
      active_revision_id uuid NOT NULL,
      latest_version integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_portal_heads_pk PRIMARY KEY (org_id),
      CONSTRAINT elearning_portal_heads_version_check CHECK (latest_version > 0),
      CONSTRAINT elearning_portal_heads_active_revision_fk
        FOREIGN KEY (org_id, active_revision_id, latest_version)
        REFERENCES elearning_portal_revisions (org_id, id, version)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_portal_publish_requests (
      org_id text NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      actor_id text NOT NULL,
      revision_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_portal_publish_requests_pk PRIMARY KEY (org_id, source_key),
      CONSTRAINT elearning_portal_publish_requests_identity_check
        CHECK (org_id <> '' AND source_key <> '' AND actor_id <> ''),
      CONSTRAINT elearning_portal_publish_requests_hash_check
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_portal_publish_requests_actor_fk
        FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_portal_publish_requests_revision_fk
        FOREIGN KEY (org_id, revision_id)
        REFERENCES elearning_portal_revisions (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  if (before.size === 0) {
    await sql`
      CREATE FUNCTION elearning_portal_reject_immutable_write()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        RAISE EXCEPTION 'ELEARNING_PORTAL_IMMUTABLE';
      END;
      $fn$
    `.execute(db)

    for (const [table, trigger] of [
      ['elearning_portal_revisions', ELEARNING_PORTAL_IMMUTABLE_TRIGGERS[0]],
      ['elearning_portal_revision_navigation', ELEARNING_PORTAL_IMMUTABLE_TRIGGERS[1]],
      ['elearning_portal_publish_requests', ELEARNING_PORTAL_IMMUTABLE_TRIGGERS[2]],
    ] as const) {
      await sql.raw(`
        CREATE TRIGGER ${trigger}
        BEFORE UPDATE OR DELETE ON ${table}
        FOR EACH ROW
        EXECUTE FUNCTION ${ELEARNING_PORTAL_IMMUTABLE_FUNCTION}()
      `).execute(db)
    }
  }

  await assertPortalAuthority(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const present = await presentTables(db)
  if (present.size !== 0 && present.size !== ELEARNING_PORTAL_TABLES.length) {
    drift('partial table set during down')
  }
  if (present.size === ELEARNING_PORTAL_TABLES.length) {
    const count = await sql<{ count: string }>`
      SELECT (
        (SELECT count(*) FROM elearning_portal_revisions)
        + (SELECT count(*) FROM elearning_portal_revision_navigation)
        + (SELECT count(*) FROM elearning_portal_heads)
        + (SELECT count(*) FROM elearning_portal_publish_requests)
      )::text AS count
    `.execute(db)
    if (count.rows[0]?.count !== '0') {
      throw new Error('elearning portal migration down refused: authoritative rows exist')
    }
  }
  await sql`DROP TABLE IF EXISTS elearning_portal_publish_requests`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_portal_heads`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_portal_revision_navigation`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_portal_revisions`.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_portal_reject_immutable_write()`.execute(db)
}
