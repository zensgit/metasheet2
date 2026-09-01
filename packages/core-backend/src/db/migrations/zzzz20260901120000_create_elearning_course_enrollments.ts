import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { ensureCanonicalUserOrgsTable } from './_ensure-user-orgs'

export const ELEARNING_COURSE_ENROLLMENTS_TABLE = 'elearning_course_enrollments'
export const ELEARNING_COURSE_ENROLLMENTS_IMMUTABLE_FUNCTION =
  'elearning_course_enrollments_reject_mutation'
export const ELEARNING_COURSE_ENROLLMENTS_ROW_TRIGGER =
  'trg_elearning_course_enrollments_reject_row_mutation'
export const ELEARNING_COURSE_ENROLLMENTS_TRUNCATE_TRIGGER =
  'trg_elearning_course_enrollments_reject_truncate'

const IMMUTABLE_FUNCTION_BODY = `
BEGIN
  RAISE EXCEPTION 'elearning_course_enrollments is immutable: % is not permitted', TG_OP;
END;
`.trim()

type CatalogConstraint = {
  name: string
  type: string
  columns: string[]
  referenced_table: string | null
  referenced_columns: string[] | null
  delete_action: string
  update_action: string
  match_type: string
  deferrable: boolean
  deferred: boolean
  validated: boolean
}

function drift(detail: string): never {
  throw new Error(`elearning course enrollment migration drift: ${detail}`)
}

async function tableExists(db: Kysely<unknown>): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass(current_schema() || '.' || ${ELEARNING_COURSE_ENROLLMENTS_TABLE})
      IS NOT NULL AS present
  `.execute(db)
  return result.rows[0]?.present === true
}

async function assertCanonicalColumns(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    column_name: string
    type_name: string
    not_null: boolean
    default_expression: string | null
  }>`
    SELECT
      attribute.attname AS column_name,
      type.typname AS type_name,
      attribute.attnotnull AS not_null,
      pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression
      FROM pg_attribute attribute
      JOIN pg_class table_row ON table_row.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      JOIN pg_type type ON type.oid = attribute.atttypid
      LEFT JOIN pg_attrdef default_row
        ON default_row.adrelid = attribute.attrelid
       AND default_row.adnum = attribute.attnum
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_COURSE_ENROLLMENTS_TABLE}
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  `.execute(db)
  const actual = result.rows.map((row) => ({
    ...row,
    default_expression: row.default_expression?.replaceAll('public.', '') ?? null,
  }))
  const expected = [
    { column_name: 'id', type_name: 'uuid', not_null: true, default_expression: 'gen_random_uuid()' },
    { column_name: 'org_id', type_name: 'text', not_null: true, default_expression: null },
    { column_name: 'user_id', type_name: 'text', not_null: true, default_expression: null },
    { column_name: 'course_id', type_name: 'uuid', not_null: true, default_expression: null },
    { column_name: 'course_version_id', type_name: 'uuid', not_null: true, default_expression: null },
    { column_name: 'scope_revision_rule_id', type_name: 'uuid', not_null: true, default_expression: null },
    { column_name: 'request_id', type_name: 'uuid', not_null: true, default_expression: null },
    { column_name: 'request_hash', type_name: 'text', not_null: true, default_expression: null },
    { column_name: 'request_hash_version', type_name: 'int2', not_null: true, default_expression: null },
    { column_name: 'enrolled_at', type_name: 'timestamptz', not_null: true, default_expression: 'now()' },
  ]
  if (JSON.stringify(actual) !== JSON.stringify(expected)) drift('column authority')
}

async function readConstraints(db: Kysely<unknown>): Promise<CatalogConstraint[]> {
  const result = await sql<CatalogConstraint>`
    SELECT
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
      constraint_row.confdeltype::text AS delete_action,
      constraint_row.confupdtype::text AS update_action,
      constraint_row.confmatchtype::text AS match_type,
      constraint_row.condeferrable AS deferrable,
      constraint_row.condeferred AS deferred,
      constraint_row.convalidated AS validated
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      LEFT JOIN pg_class referenced_table ON referenced_table.oid = constraint_row.confrelid
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_COURSE_ENROLLMENTS_TABLE}
     ORDER BY constraint_row.conname
  `.execute(db)
  return result.rows
}

async function assertCanonicalConstraints(db: Kysely<unknown>): Promise<void> {
  const constraints = await readConstraints(db)
  const byName = new Map(constraints.map((constraint) => [constraint.name, constraint]))
  const expectedNames = [
    'elearning_course_enrollments_course_version_fk',
    'elearning_course_enrollments_hash_chk',
    'elearning_course_enrollments_identity_chk',
    'elearning_course_enrollments_org_user_course_uniq',
    'elearning_course_enrollments_org_user_request_uniq',
    'elearning_course_enrollments_pkey',
    'elearning_course_enrollments_scope_rule_fk',
    'elearning_course_enrollments_user_org_fk',
  ]
  if (JSON.stringify([...byName.keys()].sort()) !== JSON.stringify(expectedNames)) {
    drift('constraint set')
  }

  const assert = (expected: {
    name: string
    type: string
    columns: string[]
    referencedTable?: string
    referencedColumns?: string[]
  }): void => {
    const actual = byName.get(expected.name)
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

  assert({ name: 'elearning_course_enrollments_pkey', type: 'p', columns: ['org_id', 'id'] })
  assert({ name: 'elearning_course_enrollments_org_user_course_uniq', type: 'u', columns: ['org_id', 'user_id', 'course_id'] })
  assert({ name: 'elearning_course_enrollments_org_user_request_uniq', type: 'u', columns: ['org_id', 'user_id', 'request_id'] })
  assert({ name: 'elearning_course_enrollments_identity_chk', type: 'c', columns: ['org_id', 'user_id'] })
  assert({ name: 'elearning_course_enrollments_hash_chk', type: 'c', columns: ['request_hash', 'request_hash_version'] })
  assert({
    name: 'elearning_course_enrollments_user_org_fk',
    type: 'f',
    columns: ['user_id', 'org_id'],
    referencedTable: 'user_orgs',
    referencedColumns: ['user_id', 'org_id'],
  })
  assert({
    name: 'elearning_course_enrollments_course_version_fk',
    type: 'f',
    columns: ['org_id', 'course_id', 'course_version_id'],
    referencedTable: 'elearning_course_versions',
    referencedColumns: ['org_id', 'course_id', 'id'],
  })
  assert({
    name: 'elearning_course_enrollments_scope_rule_fk',
    type: 'f',
    columns: ['org_id', 'scope_revision_rule_id'],
    referencedTable: 'elearning_scope_revision_rules',
    referencedColumns: ['org_id', 'id'],
  })
}

async function assertCanonicalFunctionAndTriggers(db: Kysely<unknown>): Promise<void> {
  const fn = await sql<{
    oid: string
    body: string
    language: string
    security_definer: boolean
    result_type: string
    argument_count: number
  }>`
    SELECT
      procedure.oid::text AS oid,
      btrim(procedure.prosrc, E' \n\r\t') AS body,
      language.lanname AS language,
      procedure.prosecdef AS security_definer,
      procedure.prorettype::regtype::text AS result_type,
      procedure.pronargs::integer AS argument_count
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      JOIN pg_language language ON language.oid = procedure.prolang
     WHERE namespace.nspname = current_schema()
       AND procedure.proname = ${ELEARNING_COURSE_ENROLLMENTS_IMMUTABLE_FUNCTION}
  `.execute(db)
  const functionRow = fn.rows[0]
  if (
    !functionRow
    || functionRow.body !== IMMUTABLE_FUNCTION_BODY
    || functionRow.language !== 'plpgsql'
    || functionRow.security_definer
    || functionRow.result_type !== 'trigger'
    || functionRow.argument_count !== 0
  ) drift('immutable function')

  const triggers = await sql<{
    name: string
    function_oid: string
    trigger_type: number
    enabled: string
    qualification: string | null
    attributes: number[]
  }>`
    SELECT
      trigger.tgname AS name,
      trigger.tgfoid::text AS function_oid,
      trigger.tgtype::integer AS trigger_type,
      trigger.tgenabled::text AS enabled,
      pg_get_expr(trigger.tgqual, trigger.tgrelid) AS qualification,
      trigger.tgattr::smallint[]::integer[] AS attributes
      FROM pg_trigger trigger
      JOIN pg_class table_row ON table_row.oid = trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_COURSE_ENROLLMENTS_TABLE}
       AND NOT trigger.tgisinternal
     ORDER BY trigger.tgname
  `.execute(db)
  const expected = [
    {
      name: ELEARNING_COURSE_ENROLLMENTS_ROW_TRIGGER,
      function_oid: functionRow.oid,
      trigger_type: 27,
      enabled: 'O',
      qualification: null,
      attributes: [],
    },
    {
      name: ELEARNING_COURSE_ENROLLMENTS_TRUNCATE_TRIGGER,
      function_oid: functionRow.oid,
      trigger_type: 34,
      enabled: 'O',
      qualification: null,
      attributes: [],
    },
  ]
  if (JSON.stringify(triggers.rows) !== JSON.stringify(expected)) drift('trigger authority')
}

async function assertCanonicalChecks(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ name: string; definition: string }>`
    SELECT constraint_row.conname AS name,
           pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${ELEARNING_COURSE_ENROLLMENTS_TABLE}
       AND constraint_row.contype = 'c'
     ORDER BY constraint_row.conname
  `.execute(db)
  const definitions = new Map(result.rows.map((row) => [
    row.name,
    row.definition.replaceAll('"', '').replace(/\s+/g, ''),
  ]))
  if (
    definitions.get('elearning_course_enrollments_identity_chk')
      !== "CHECK(((btrim(org_id)<>''::text)AND(btrim(user_id)<>''::text)))"
    || definitions.get('elearning_course_enrollments_hash_chk')
      !== "CHECK(((request_hash~'^[0-9a-f]{64}$'::text)AND(request_hash_version=1)))"
  ) drift('check definitions')
}

async function assertCanonical(db: Kysely<unknown>): Promise<void> {
  await assertCanonicalColumns(db)
  await assertCanonicalConstraints(db)
  await assertCanonicalChecks(db)
  await assertCanonicalFunctionAndTriggers(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureCanonicalUserOrgsTable(db)
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  if (await tableExists(db)) {
    await assertCanonical(db)
    return
  }

  await sql`
    CREATE TABLE elearning_course_enrollments (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      user_id text NOT NULL,
      course_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      scope_revision_rule_id uuid NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      enrolled_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_course_enrollments_pkey PRIMARY KEY (org_id, id),
      CONSTRAINT elearning_course_enrollments_org_user_course_uniq
        UNIQUE (org_id, user_id, course_id),
      CONSTRAINT elearning_course_enrollments_org_user_request_uniq
        UNIQUE (org_id, user_id, request_id),
      CONSTRAINT elearning_course_enrollments_identity_chk
        CHECK (btrim(org_id) <> '' AND btrim(user_id) <> ''),
      CONSTRAINT elearning_course_enrollments_hash_chk
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version = 1),
      CONSTRAINT elearning_course_enrollments_user_org_fk
        FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_course_enrollments_course_version_fk
        FOREIGN KEY (org_id, course_id, course_version_id)
        REFERENCES elearning_course_versions (org_id, course_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_course_enrollments_scope_rule_fk
        FOREIGN KEY (org_id, scope_revision_rule_id)
        REFERENCES elearning_scope_revision_rules (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql.raw(`
    CREATE FUNCTION ${ELEARNING_COURSE_ENROLLMENTS_IMMUTABLE_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    ${IMMUTABLE_FUNCTION_BODY}
    $fn$
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${ELEARNING_COURSE_ENROLLMENTS_ROW_TRIGGER}
      BEFORE UPDATE OR DELETE ON ${ELEARNING_COURSE_ENROLLMENTS_TABLE}
      FOR EACH ROW
      EXECUTE FUNCTION ${ELEARNING_COURSE_ENROLLMENTS_IMMUTABLE_FUNCTION}()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER ${ELEARNING_COURSE_ENROLLMENTS_TRUNCATE_TRIGGER}
      BEFORE TRUNCATE ON ${ELEARNING_COURSE_ENROLLMENTS_TABLE}
      FOR EACH STATEMENT
      EXECUTE FUNCTION ${ELEARNING_COURSE_ENROLLMENTS_IMMUTABLE_FUNCTION}()
  `).execute(db)

  await assertCanonical(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExists(db))) return
  const rows = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM elearning_course_enrollments
  `.execute(db)
  if (rows.rows[0]?.count !== '0') {
    throw new Error('elearning course enrollment migration down refused: authoritative rows exist')
  }
  await sql.raw(`
    DROP TRIGGER ${ELEARNING_COURSE_ENROLLMENTS_TRUNCATE_TRIGGER}
      ON ${ELEARNING_COURSE_ENROLLMENTS_TABLE}
  `).execute(db)
  await sql.raw(`
    DROP TRIGGER ${ELEARNING_COURSE_ENROLLMENTS_ROW_TRIGGER}
      ON ${ELEARNING_COURSE_ENROLLMENTS_TABLE}
  `).execute(db)
  await sql.raw(`DROP FUNCTION ${ELEARNING_COURSE_ENROLLMENTS_IMMUTABLE_FUNCTION}()`).execute(db)
  await sql.raw(`DROP TABLE ${ELEARNING_COURSE_ENROLLMENTS_TABLE}`).execute(db)
}
