import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const TABLE = 'elearning_notification_deliveries'
const KIND_BASIS_CHECK = 'elearning_notification_deliveries_kind_basis_chk'
const ENROLLMENT_FK = 'elearning_notification_deliveries_enrollment_fk'
const EXAM_ATTEMPT_FK = 'elearning_notification_deliveries_exam_attempt_fk'

const BEFORE_KIND_DEFINITION =
  "CHECK (kind = 'assignment_reminder'::text)"
const AFTER_KIND_DEFINITION =
  "CHECK (kind = 'assignment_reminder'::text AND assignment_member_id IS NOT NULL AND enrollment_id IS NULL AND exam_attempt_id IS NULL OR kind = 'training_available'::text AND exam_attempt_id IS NULL AND num_nonnulls(assignment_member_id, enrollment_id) = 1 OR kind = 'result_published'::text AND assignment_member_id IS NULL AND enrollment_id IS NULL AND exam_attempt_id IS NOT NULL)"
const ASSIGNMENT_FK_DEFINITION =
  'FOREIGN KEY (org_id, assignment_member_id) REFERENCES elearning_assignment_members(org_id, id) ON DELETE RESTRICT'
const ENROLLMENT_FK_DEFINITION =
  'FOREIGN KEY (org_id, enrollment_id) REFERENCES elearning_course_enrollments(org_id, id) ON DELETE RESTRICT'
const EXAM_ATTEMPT_FK_DEFINITION =
  'FOREIGN KEY (org_id, exam_attempt_id) REFERENCES elearning_exam_attempts(org_id, id) ON DELETE RESTRICT'

const BASE_IDENTITY_FIELDS = `NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.assignment_member_id IS DISTINCT FROM OLD.assignment_member_id`
const EXTENDED_IDENTITY_FIELDS = `${BASE_IDENTITY_FIELDS}
         OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id
         OR NEW.exam_attempt_id IS DISTINCT FROM OLD.exam_attempt_id`

function identityGuardBody(extended: boolean): string {
  const identityFields = extended ? EXTENDED_IDENTITY_FIELDS : BASE_IDENTITY_FIELDS
  return `BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'elearning_notification_deliveries destructive operation is not permitted';
      END IF;

      IF ${identityFields}
         OR NEW.kind IS DISTINCT FROM OLD.kind
         OR NEW.source_key IS DISTINCT FROM OLD.source_key
         OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
         OR NEW.request_hash_version IS DISTINCT FROM OLD.request_hash_version
         OR NEW.recipient_role IS DISTINCT FROM OLD.recipient_role
         OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
         OR NEW.channel IS DISTINCT FROM OLD.channel
         OR NEW.payload IS DISTINCT FROM OLD.payload
         OR NEW.due_at IS DISTINCT FROM OLD.due_at
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning_notification_deliveries identity fields are immutable';
      END IF;

      RETURN NEW;
    END;`
}

type MigrationState = 'before' | 'after'

function normalizedDefinition(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : ''
}

type CatalogConstraint = {
  constraint_name: string
  constraint_type: string
  definition: string
  validated: boolean
  deferrable: boolean
  initially_deferred: boolean
  current_schema_name: string
  referenced_schema: string | null
  referenced_table: string | null
  local_columns: string[]
  referenced_columns: string[]
  update_action: string
  delete_action: string
  match_type: string
}

function assertConstraint(
  row: CatalogConstraint | undefined,
  expected: {
    name: string
    type: 'c' | 'f'
    definition: string
    referencedTable?: string
    localColumns?: string[]
    referencedColumns?: string[]
  },
): void {
  if (
    !row
    || row.constraint_name !== expected.name
    || row.constraint_type !== expected.type
    || normalizedDefinition(row.definition)
      !== normalizedDefinition(expected.definition)
    || row.validated !== true
    || row.deferrable !== false
    || row.initially_deferred !== false
  ) {
    throw new Error(`e-learning notification event migration drift: ${expected.name}`)
  }
  if (expected.type === 'f') {
    if (
      row.referenced_schema !== row.current_schema_name
      || row.referenced_table !== expected.referencedTable
      || JSON.stringify(row.local_columns) !== JSON.stringify(expected.localColumns)
      || JSON.stringify(row.referenced_columns)
        !== JSON.stringify(expected.referencedColumns)
      || row.update_action !== 'a'
      || row.delete_action !== 'r'
      || row.match_type !== 's'
    ) {
      throw new Error(`e-learning notification event migration drift: ${expected.name}`)
    }
  } else if (
    row.referenced_schema !== null
    || row.referenced_table !== null
    || row.referenced_columns.length !== 0
    || row.update_action !== ' '
    || row.delete_action !== ' '
    || row.match_type !== ' '
  ) {
    throw new Error(`e-learning notification event migration drift: ${expected.name}`)
  }
}

async function assertAffectedCatalogShape(
  db: Kysely<unknown>,
  expected: MigrationState,
): Promise<void> {
  const columns = await sql<{
    column_name: string
    data_type: string
    not_null: boolean
    default_expression: string | null
  }>`
    SELECT attribute_row.attname AS column_name,
           pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod) AS data_type,
           attribute_row.attnotnull AS not_null,
           pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression
      FROM pg_catalog.pg_attribute attribute_row
      LEFT JOIN pg_catalog.pg_attrdef default_row
        ON default_row.adrelid = attribute_row.attrelid
       AND default_row.adnum = attribute_row.attnum
     WHERE attribute_row.attrelid = pg_catalog.to_regclass(
             pg_catalog.format('%I.%I', current_schema(), ${TABLE}::text)
           )
       AND attribute_row.attname IN ('assignment_member_id', 'enrollment_id', 'exam_attempt_id')
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
     ORDER BY attribute_row.attname
  `.execute(db)
  const byName = new Map(columns.rows.map((row) => [row.column_name, row]))
  const assignment = byName.get('assignment_member_id')
  if (
    !assignment
    || assignment.data_type !== 'uuid'
    || assignment.default_expression !== null
  ) {
    throw new Error('e-learning notification event migration drift: assignment column')
  }
  if (expected === 'before') {
    if (!assignment.not_null || byName.has('enrollment_id') || byName.has('exam_attempt_id')) {
      throw new Error('e-learning notification event migration drift: pre columns')
    }
  } else if (
    assignment.not_null
    || byName.get('enrollment_id')?.data_type !== 'uuid'
    || byName.get('enrollment_id')?.not_null !== false
    || byName.get('enrollment_id')?.default_expression !== null
    || byName.get('exam_attempt_id')?.data_type !== 'uuid'
    || byName.get('exam_attempt_id')?.not_null !== false
    || byName.get('exam_attempt_id')?.default_expression !== null
  ) {
    throw new Error('e-learning notification event migration drift: post columns')
  }

  const constraints = await sql<CatalogConstraint>`
    SELECT constraint_row.conname AS constraint_name,
           constraint_row.contype::text AS constraint_type,
           pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition,
           constraint_row.convalidated AS validated,
           constraint_row.condeferrable AS deferrable,
           constraint_row.condeferred AS initially_deferred,
           current_schema() AS current_schema_name,
           referenced_namespace.nspname AS referenced_schema,
           referenced_table.relname AS referenced_table,
           constraint_row.confupdtype::text AS update_action,
           constraint_row.confdeltype::text AS delete_action,
           constraint_row.confmatchtype::text AS match_type,
           ARRAY(
             SELECT local_attribute.attname
               FROM unnest(constraint_row.conkey) WITH ORDINALITY AS local_key(attnum, position)
               JOIN pg_catalog.pg_attribute local_attribute
                 ON local_attribute.attrelid = constraint_row.conrelid
                AND local_attribute.attnum = local_key.attnum
              ORDER BY local_key.position
           )::text[] AS local_columns,
           CASE WHEN constraint_row.confrelid = 0 THEN ARRAY[]::text[] ELSE ARRAY(
             SELECT referenced_attribute.attname
               FROM unnest(constraint_row.confkey) WITH ORDINALITY AS referenced_key(attnum, position)
               JOIN pg_catalog.pg_attribute referenced_attribute
                 ON referenced_attribute.attrelid = constraint_row.confrelid
                AND referenced_attribute.attnum = referenced_key.attnum
              ORDER BY referenced_key.position
           )::text[] END AS referenced_columns
      FROM pg_catalog.pg_constraint constraint_row
      LEFT JOIN pg_catalog.pg_class referenced_table
        ON referenced_table.oid = constraint_row.confrelid
      LEFT JOIN pg_catalog.pg_namespace referenced_namespace
        ON referenced_namespace.oid = referenced_table.relnamespace
     WHERE constraint_row.conrelid = pg_catalog.to_regclass(
             pg_catalog.format('%I.%I', current_schema(), ${TABLE}::text)
           )
       AND constraint_row.conname IN (
         'elearning_notification_deliveries_kind_chk',
         'elearning_notification_deliveries_kind_basis_chk',
         'elearning_notification_deliveries_assignment_member_fk',
         'elearning_notification_deliveries_enrollment_fk',
         'elearning_notification_deliveries_exam_attempt_fk'
       )
       AND (
         constraint_row.confrelid = 0
         OR referenced_namespace.nspname = current_schema()
       )
     ORDER BY constraint_row.conname
  `.execute(db)
  const constraintMap = new Map(
    constraints.rows.map((row) => [row.constraint_name, row]),
  )
  assertConstraint(
    constraintMap.get('elearning_notification_deliveries_assignment_member_fk'),
    {
      name: 'elearning_notification_deliveries_assignment_member_fk',
      type: 'f',
      definition: ASSIGNMENT_FK_DEFINITION,
      referencedTable: 'elearning_assignment_members',
      localColumns: ['org_id', 'assignment_member_id'],
      referencedColumns: ['org_id', 'id'],
    },
  )

  if (expected === 'before') {
    if (constraintMap.size !== 2) {
      throw new Error('e-learning notification event migration drift: pre constraints')
    }
    assertConstraint(
      constraintMap.get('elearning_notification_deliveries_kind_chk'),
      {
        name: 'elearning_notification_deliveries_kind_chk',
        type: 'c',
        definition: BEFORE_KIND_DEFINITION,
      },
    )
  } else {
    if (constraintMap.size !== 4) {
      throw new Error('e-learning notification event migration drift: post constraints')
    }
    assertConstraint(constraintMap.get(KIND_BASIS_CHECK), {
      name: KIND_BASIS_CHECK,
      type: 'c',
      definition: AFTER_KIND_DEFINITION,
    })
    assertConstraint(constraintMap.get(ENROLLMENT_FK), {
      name: ENROLLMENT_FK,
      type: 'f',
      definition: ENROLLMENT_FK_DEFINITION,
      referencedTable: 'elearning_course_enrollments',
      localColumns: ['org_id', 'enrollment_id'],
      referencedColumns: ['org_id', 'id'],
    })
    assertConstraint(constraintMap.get(EXAM_ATTEMPT_FK), {
      name: EXAM_ATTEMPT_FK,
      type: 'f',
      definition: EXAM_ATTEMPT_FK_DEFINITION,
      referencedTable: 'elearning_exam_attempts',
      localColumns: ['org_id', 'exam_attempt_id'],
      referencedColumns: ['org_id', 'id'],
    })
  }

  const functions = await sql<{
    function_oid: string
    source: string
    language_name: string
    return_type: string
    security_definer: boolean
    function_kind: string
    argument_count: number
  }>`
    SELECT procedure_row.oid::text AS function_oid,
           procedure_row.prosrc AS source,
           language_row.lanname AS language_name,
           pg_catalog.format_type(procedure_row.prorettype, NULL) AS return_type,
           procedure_row.prosecdef AS security_definer,
           procedure_row.prokind::text AS function_kind,
           procedure_row.pronargs::integer AS argument_count
      FROM pg_catalog.pg_proc procedure_row
      JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = procedure_row.pronamespace
      JOIN pg_catalog.pg_language language_row
        ON language_row.oid = procedure_row.prolang
     WHERE namespace_row.nspname = current_schema()
       AND procedure_row.proname = 'elearning_notification_deliveries_identity_guard'
       AND procedure_row.pronargs = 0
  `.execute(db)
  const guard = functions.rows[0]
  if (
    functions.rows.length !== 1
    || !guard
    || guard.source.trim() !== identityGuardBody(expected === 'after')
    || guard.language_name !== 'plpgsql'
    || guard.return_type !== 'trigger'
    || guard.security_definer !== false
    || guard.function_kind !== 'f'
    || guard.argument_count !== 0
  ) {
    throw new Error('e-learning notification event migration drift: identity guard')
  }

  const triggers = await sql<{
    trigger_name: string
    trigger_type: number
    trigger_attributes: string
    trigger_when: string | null
    trigger_enabled: string
    function_oid: string
  }>`
    SELECT trigger_row.tgname AS trigger_name,
           trigger_row.tgtype::integer AS trigger_type,
           trigger_row.tgattr::text AS trigger_attributes,
           pg_catalog.pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid) AS trigger_when,
           trigger_row.tgenabled::text AS trigger_enabled,
           trigger_row.tgfoid::text AS function_oid
      FROM pg_catalog.pg_trigger trigger_row
     WHERE trigger_row.tgrelid = pg_catalog.to_regclass(
             pg_catalog.format('%I.%I', current_schema(), ${TABLE}::text)
           )
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgname IN (
         'trg_elearning_notification_deliveries_identity_guard',
         'trg_elearning_notification_deliveries_truncate_guard'
       )
     ORDER BY trigger_row.tgname
  `.execute(db)
  const triggerMap = new Map(triggers.rows.map((row) => [row.trigger_name, row]))
  const rowTrigger = triggerMap.get('trg_elearning_notification_deliveries_identity_guard')
  const truncateTrigger = triggerMap.get('trg_elearning_notification_deliveries_truncate_guard')
  if (
    triggerMap.size !== 2
    || !rowTrigger
    || rowTrigger.trigger_type !== 27
    || rowTrigger.trigger_attributes !== ''
    || rowTrigger.trigger_when !== null
    || rowTrigger.trigger_enabled !== 'O'
    || rowTrigger.function_oid !== guard.function_oid
    || !truncateTrigger
    || truncateTrigger.trigger_type !== 34
    || truncateTrigger.trigger_attributes !== ''
    || truncateTrigger.trigger_when !== null
    || truncateTrigger.trigger_enabled !== 'O'
    || truncateTrigger.function_oid !== guard.function_oid
  ) {
    throw new Error('e-learning notification event migration drift: triggers')
  }
}

async function installIdentityGuard(db: Kysely<unknown>, extended: boolean): Promise<void> {
  await sql.raw(`CREATE OR REPLACE FUNCTION elearning_notification_deliveries_identity_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    AS $fn$${identityGuardBody(extended)}$fn$`).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ enrollment_id: boolean; exam_attempt_id: boolean }>`
    SELECT EXISTS (
             SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = pg_catalog.to_regclass(
                      pg_catalog.format('%I.%I', current_schema(), ${TABLE}::text)
                    )
                AND attname = 'enrollment_id' AND attnum > 0 AND NOT attisdropped
           ) AS enrollment_id,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = pg_catalog.to_regclass(
                      pg_catalog.format('%I.%I', current_schema(), ${TABLE}::text)
                    )
                AND attname = 'exam_attempt_id' AND attnum > 0 AND NOT attisdropped
           ) AS exam_attempt_id
  `.execute(db)
  if (existing.rows[0]?.enrollment_id && existing.rows[0]?.exam_attempt_id) {
    await assertAffectedCatalogShape(db, 'after')
    return
  }
  if (existing.rows[0]?.enrollment_id || existing.rows[0]?.exam_attempt_id) {
    throw new Error('e-learning notification event migration drift: partial columns')
  }
  await assertAffectedCatalogShape(db, 'before')

  await sql`
    ALTER TABLE elearning_notification_deliveries
      DROP CONSTRAINT elearning_notification_deliveries_kind_chk,
      ALTER COLUMN assignment_member_id DROP NOT NULL,
      ADD COLUMN enrollment_id uuid,
      ADD COLUMN exam_attempt_id uuid,
      ADD CONSTRAINT elearning_notification_deliveries_kind_basis_chk
        CHECK (
          (
            kind = 'assignment_reminder'
            AND assignment_member_id IS NOT NULL
            AND enrollment_id IS NULL
            AND exam_attempt_id IS NULL
          )
          OR (
            kind = 'training_available'
            AND exam_attempt_id IS NULL
            AND num_nonnulls(assignment_member_id, enrollment_id) = 1
          )
          OR (
            kind = 'result_published'
            AND assignment_member_id IS NULL
            AND enrollment_id IS NULL
            AND exam_attempt_id IS NOT NULL
          )
        ),
      ADD CONSTRAINT elearning_notification_deliveries_enrollment_fk
        FOREIGN KEY (org_id, enrollment_id)
        REFERENCES elearning_course_enrollments (org_id, id)
        ON DELETE RESTRICT,
      ADD CONSTRAINT elearning_notification_deliveries_exam_attempt_fk
        FOREIGN KEY (org_id, exam_attempt_id)
        REFERENCES elearning_exam_attempts (org_id, id)
        ON DELETE RESTRICT
  `.execute(db)
  await installIdentityGuard(db, true)
  await assertAffectedCatalogShape(db, 'after')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await assertAffectedCatalogShape(db, 'after')
  await sql`
    LOCK TABLE elearning_notification_deliveries IN ACCESS EXCLUSIVE MODE
  `.execute(db)
  const newRows = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM elearning_notification_deliveries
       WHERE kind IN ('training_available', 'result_published')
          OR enrollment_id IS NOT NULL
          OR exam_attempt_id IS NOT NULL
    ) AS exists
  `.execute(db)
  if (newRows.rows[0]?.exists) {
    throw new Error('e-learning notification event migration down refused: new event rows exist')
  }

  await sql`
    ALTER TABLE elearning_notification_deliveries
      DROP CONSTRAINT elearning_notification_deliveries_exam_attempt_fk,
      DROP CONSTRAINT elearning_notification_deliveries_enrollment_fk,
      DROP CONSTRAINT elearning_notification_deliveries_kind_basis_chk,
      DROP COLUMN exam_attempt_id,
      DROP COLUMN enrollment_id,
      ALTER COLUMN assignment_member_id SET NOT NULL,
      ADD CONSTRAINT elearning_notification_deliveries_kind_chk
        CHECK (kind = 'assignment_reminder')
  `.execute(db)
  await installIdentityGuard(db, false)
  await assertAffectedCatalogShape(db, 'before')
}
