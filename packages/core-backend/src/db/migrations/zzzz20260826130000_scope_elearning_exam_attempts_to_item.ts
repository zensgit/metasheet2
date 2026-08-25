import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Scope e-learning exam attempts to the exact course_version_item that
 * mounted the exam. Same exam in two items or versions must not share
 * attempt identity, max-attempt counts, or learner aggregates.
 *
 * Preflight/backfill is fail-closed: every existing attempt must match
 * exactly one exam item in its org+version+exam. Zero or ambiguous
 * matches abort without guessing. Rollback refuses while attempts exist
 * so nonempty item provenance is not silently dropped.
 */

export const ATTEMPTS_ITEM_COLUMN = 'course_version_item_id'
export const ATTEMPTS_ITEM_FK = 'elearning_exam_attempts_item_fk'
export const ATTEMPTS_ATTEMPT_UNIQ = 'elearning_exam_attempts_attempt_uniq'
export const ITEMS_ORG_VERSION_EXAM_ID_UNIQ =
  'elearning_course_version_items_org_version_exam_id_uniq'
export const ATTEMPTS_ITEM_USER_INDEX = 'idx_elearning_exam_attempts_org_item_user'
export const ATTEMPTS_EXAM_USER_INDEX = 'idx_elearning_exam_attempts_org_exam_user'
export const ATTEMPT_ITEM_BACKFILL_ABORT =
  'elearning_exam_attempts item backfill is not deterministic'
export const ATTEMPT_ITEM_DOWN_NONEMPTY =
  'refusing to drop elearning_exam_attempts.course_version_item_id while attempts exist'
export const ATTEMPT_ITEM_SCHEMA_CONFLICT =
  'elearning exam attempt item-scope schema object has an incompatible definition'

export const ATTEMPT_ITEM_BACKFILL_PREFLIGHT_SQL = `
DO $preflight$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad
    FROM elearning_exam_attempts a
   WHERE a.course_version_item_id IS NULL
     AND (
       SELECT count(*)
         FROM elearning_course_version_items i
        WHERE i.org_id = a.org_id
          AND i.course_version_id = a.course_version_id
          AND i.exam_id = a.exam_id
          AND i.item_type = 'exam'
     ) <> 1;
  IF bad > 0 THEN
    RAISE EXCEPTION '${ATTEMPT_ITEM_BACKFILL_ABORT}';
  END IF;
END
$preflight$;
`

const ORIGINAL_ATTEMPT_STATE_GUARD = `
CREATE OR REPLACE FUNCTION elearning_exam_attempts_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'started' THEN
      RAISE EXCEPTION 'elearning_exam_attempts must be inserted as started';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'graded' THEN
      RAISE EXCEPTION 'elearning_exam_attempts graded rows cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.exam_id IS DISTINCT FROM OLD.exam_id
     OR NEW.course_version_id IS DISTINCT FROM OLD.course_version_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.paper_snapshot IS DISTINCT FROM OLD.paper_snapshot
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'elearning_exam_attempts identity fields are immutable after insert';
  END IF;

  IF OLD.status = 'graded' THEN
    RAISE EXCEPTION 'elearning_exam_attempts graded rows cannot be updated';
  END IF;

  IF OLD.status IN ('submitted', 'expired') THEN
    IF NEW.answers IS DISTINCT FROM OLD.answers
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'elearning_exam_attempts answers and submitted_at are immutable after submit/expire';
    END IF;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status = 'started' AND NEW.status IN ('submitted', 'expired') THEN
      RETURN NEW;
    END IF;
    IF OLD.status IN ('submitted', 'expired') AND NEW.status = 'graded' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'elearning_exam_attempts illegal status transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$fn$;
`

const ITEM_SCOPED_ATTEMPT_STATE_GUARD = `
CREATE OR REPLACE FUNCTION elearning_exam_attempts_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'started' THEN
      RAISE EXCEPTION 'elearning_exam_attempts must be inserted as started';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'graded' THEN
      RAISE EXCEPTION 'elearning_exam_attempts graded rows cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.exam_id IS DISTINCT FROM OLD.exam_id
     OR NEW.course_version_id IS DISTINCT FROM OLD.course_version_id
     OR NEW.course_version_item_id IS DISTINCT FROM OLD.course_version_item_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.paper_snapshot IS DISTINCT FROM OLD.paper_snapshot
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'elearning_exam_attempts identity fields are immutable after insert';
  END IF;

  IF OLD.status = 'graded' THEN
    RAISE EXCEPTION 'elearning_exam_attempts graded rows cannot be updated';
  END IF;

  IF OLD.status IN ('submitted', 'expired') THEN
    IF NEW.answers IS DISTINCT FROM OLD.answers
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'elearning_exam_attempts answers and submitted_at are immutable after submit/expire';
    END IF;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status = 'started' AND NEW.status IN ('submitted', 'expired') THEN
      RETURN NEW;
    END IF;
    IF OLD.status IN ('submitted', 'expired') AND NEW.status = 'graded' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'elearning_exam_attempts illegal status transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$fn$;
`

type ConstraintShape = {
  kind: string
  local_columns: string[]
  referenced_table: string | null
  referenced_schema: string | null
  current_schema_name: string
  referenced_columns: string[]
  delete_action: string
  update_action: string
  match_type: string
  validated: boolean
  deferrable: boolean
  initially_deferred: boolean
}

type IndexShape = {
  table_name: string
  method: string
  unique: boolean
  valid: boolean
  ready: boolean
  live: boolean
  has_predicate: boolean
  has_expressions: boolean
  columns: string[]
  definition: string
}

async function constraintShape(
  db: Kysely<unknown>,
  table: string,
  conname: string,
): Promise<ConstraintShape | null> {
  const result = await sql<ConstraintShape>`
    SELECT c.contype::text AS kind,
           ARRAY(
             SELECT a.attname
               FROM unnest(c.conkey) WITH ORDINALITY AS x(attnum, n)
               JOIN pg_attribute a
                 ON a.attrelid = c.conrelid
                AND a.attnum = x.attnum
              ORDER BY x.n
           )::text[] AS local_columns,
           referenced.relname::text AS referenced_table,
           referenced_namespace.nspname::text AS referenced_schema,
           current_schema()::text AS current_schema_name,
           CASE
             WHEN c.contype = 'f' THEN ARRAY(
               SELECT a.attname
                 FROM unnest(c.confkey) WITH ORDINALITY AS x(attnum, n)
                 JOIN pg_attribute a
                   ON a.attrelid = c.confrelid
                  AND a.attnum = x.attnum
                ORDER BY x.n
             )::text[]
             ELSE ARRAY[]::text[]
           END AS referenced_columns,
           c.confdeltype::text AS delete_action,
           c.confupdtype::text AS update_action,
           c.confmatchtype::text AS match_type,
           c.convalidated AS validated,
           c.condeferrable AS deferrable,
           c.condeferred AS initially_deferred
      FROM pg_constraint c
      LEFT JOIN pg_class referenced ON referenced.oid = c.confrelid
      LEFT JOIN pg_namespace referenced_namespace
        ON referenced_namespace.oid = referenced.relnamespace
     WHERE c.conrelid = ${sql.raw(`'${table}'::regclass`)}
       AND c.conname = ${conname}
  `.execute(db)
  if (result.rows.length === 0) return null
  return result.rows[0]
}

async function hasColumn(
  db: Kysely<unknown>,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM pg_attribute
       WHERE attrelid = ${sql.raw(`'${table}'::regclass`)}
         AND attname = ${column}
         AND NOT attisdropped
    ) AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

function sameColumns(actual: string[], expected: string[]): boolean {
  return actual.join(',') === expected.join(',')
}

function isExpectedUnique(
  shape: ConstraintShape,
  columns: string[],
): boolean {
  return shape.kind === 'u'
    && sameColumns(shape.local_columns, columns)
    && shape.validated
    && !shape.deferrable
    && !shape.initially_deferred
}

function isExpectedForeignKey(
  shape: ConstraintShape,
  localColumns: string[],
  referencedTable: string,
  referencedColumns: string[],
): boolean {
  return shape.kind === 'f'
    && sameColumns(shape.local_columns, localColumns)
    && shape.referenced_table === referencedTable
    && shape.referenced_schema === shape.current_schema_name
    && sameColumns(shape.referenced_columns, referencedColumns)
    && shape.delete_action === 'r'
    && shape.update_action === 'a'
    && shape.match_type === 's'
    && shape.validated
    && !shape.deferrable
    && !shape.initially_deferred
}

function schemaConflict(objectName: string): Error {
  return new Error(`${ATTEMPT_ITEM_SCHEMA_CONFLICT}: ${objectName}`)
}

async function indexShape(
  db: Kysely<unknown>,
  indexName: string,
): Promise<IndexShape | null> {
  const result = await sql<IndexShape>`
    SELECT tbl.relname::text AS table_name,
           am.amname::text AS method,
           ix.indisunique AS unique,
           ix.indisvalid AS valid,
           ix.indisready AS ready,
           ix.indislive AS live,
           (ix.indpred IS NOT NULL) AS has_predicate,
           (ix.indexprs IS NOT NULL) AS has_expressions,
           ARRAY(
             SELECT a.attname
               FROM unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n)
               JOIN pg_attribute a
                 ON a.attrelid = ix.indrelid
                AND a.attnum = x.attnum
              WHERE x.n <= ix.indnkeyatts
              ORDER BY x.n
           )::text[] AS columns,
           pg_get_indexdef(ix.indexrelid)::text AS definition
      FROM pg_class idx
      JOIN pg_namespace nsp ON nsp.oid = idx.relnamespace
      JOIN pg_index ix ON ix.indexrelid = idx.oid
      JOIN pg_class tbl ON tbl.oid = ix.indrelid
      JOIN pg_am am ON am.oid = idx.relam
     WHERE nsp.nspname = current_schema()
       AND idx.relname = ${indexName}
  `.execute(db)
  return result.rows[0] ?? null
}

function isExpectedIndex(
  shape: IndexShape,
  table: string,
  columns: string[],
): boolean {
  const normalized = shape.definition.replace(/"/g, '').replace(/\s+/g, ' ').trim()
  return shape.table_name === table
    && shape.method === 'btree'
    && !shape.unique
    && shape.valid
    && shape.ready
    && shape.live
    && !shape.has_predicate
    && !shape.has_expressions
    && sameColumns(shape.columns, columns)
    && normalized.endsWith(`USING btree (${columns.join(', ')})`)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // The PostgreSQL Migrator wraps the batch in one transaction. Take both
  // final-strength locks in service order (item before attempt): ADD UNIQUE
  // must not upgrade a weaker item lock after attempts are already frozen.
  // This also makes preflight/backfill observe one stable item mapping when
  // replaying a half-migrated schema.
  await sql`LOCK TABLE elearning_course_version_items IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_exam_attempts IN ACCESS EXCLUSIVE MODE`.execute(db)

  if (!(await hasColumn(db, 'elearning_exam_attempts', ATTEMPTS_ITEM_COLUMN))) {
    await sql`
      ALTER TABLE elearning_exam_attempts
        ADD COLUMN course_version_item_id uuid
    `.execute(db)
  }

  await sql.raw(ATTEMPT_ITEM_BACKFILL_PREFLIGHT_SQL).execute(db)

  await sql`
    UPDATE elearning_exam_attempts a
       SET course_version_item_id = i.id
      FROM elearning_course_version_items i
     WHERE a.course_version_item_id IS NULL
       AND i.org_id = a.org_id
       AND i.course_version_id = a.course_version_id
       AND i.exam_id = a.exam_id
       AND i.item_type = 'exam'
  `.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      ALTER COLUMN course_version_item_id SET NOT NULL
  `.execute(db)

  const itemParentColumns = ['org_id', 'course_version_id', 'exam_id', 'id']
  const existingItemUnique = await constraintShape(
    db,
    'elearning_course_version_items',
    ITEMS_ORG_VERSION_EXAM_ID_UNIQ,
  )
  if (existingItemUnique && !isExpectedUnique(existingItemUnique, itemParentColumns)) {
    throw schemaConflict(ITEMS_ORG_VERSION_EXAM_ID_UNIQ)
  }
  if (!existingItemUnique) {
    await sql`
      ALTER TABLE elearning_course_version_items
        ADD CONSTRAINT elearning_course_version_items_org_version_exam_id_uniq
        UNIQUE (org_id, course_version_id, exam_id, id)
    `.execute(db)
  }

  const itemFkColumns = ['org_id', 'course_version_id', 'exam_id', 'course_version_item_id']
  const existingItemFk = await constraintShape(
    db,
    'elearning_exam_attempts',
    ATTEMPTS_ITEM_FK,
  )
  if (
    existingItemFk
    && !isExpectedForeignKey(
      existingItemFk,
      itemFkColumns,
      'elearning_course_version_items',
      itemParentColumns,
    )
  ) {
    throw schemaConflict(ATTEMPTS_ITEM_FK)
  }
  if (!existingItemFk) {
    await sql`
      ALTER TABLE elearning_exam_attempts
        ADD CONSTRAINT elearning_exam_attempts_item_fk
        FOREIGN KEY (org_id, course_version_id, exam_id, course_version_item_id)
        REFERENCES elearning_course_version_items (org_id, course_version_id, exam_id, id)
        ON DELETE RESTRICT
    `.execute(db)
  }

  const attemptUniq = await constraintShape(
    db,
    'elearning_exam_attempts',
    ATTEMPTS_ATTEMPT_UNIQ,
  )
  const itemScopedUniq = [
    'org_id',
    'course_version_item_id',
    'user_id',
    'attempt_no',
  ]
  const legacyAttemptUniq = ['org_id', 'exam_id', 'user_id', 'attempt_no']
  if (attemptUniq && isExpectedUnique(attemptUniq, legacyAttemptUniq)) {
    await sql`
      ALTER TABLE elearning_exam_attempts
        DROP CONSTRAINT elearning_exam_attempts_attempt_uniq
    `.execute(db)
    await sql`
      ALTER TABLE elearning_exam_attempts
        ADD CONSTRAINT elearning_exam_attempts_attempt_uniq
        UNIQUE (org_id, course_version_item_id, user_id, attempt_no)
    `.execute(db)
  } else if (!attemptUniq) {
    await sql`
      ALTER TABLE elearning_exam_attempts
        ADD CONSTRAINT elearning_exam_attempts_attempt_uniq
        UNIQUE (org_id, course_version_item_id, user_id, attempt_no)
    `.execute(db)
  } else if (!isExpectedUnique(attemptUniq, itemScopedUniq)) {
    throw schemaConflict(ATTEMPTS_ATTEMPT_UNIQ)
  }

  await sql.raw(ITEM_SCOPED_ATTEMPT_STATE_GUARD).execute(db)

  await sql`
    DROP INDEX IF EXISTS idx_elearning_exam_attempts_org_exam_user
  `.execute(db)
  const expectedIndexColumns = ['org_id', 'course_version_item_id', 'user_id']
  const existingItemIndex = await indexShape(db, ATTEMPTS_ITEM_USER_INDEX)
  if (existingItemIndex && !isExpectedIndex(
    existingItemIndex,
    'elearning_exam_attempts',
    expectedIndexColumns,
  )) {
    throw schemaConflict(ATTEMPTS_ITEM_USER_INDEX)
  }
  if (!existingItemIndex) {
    await sql`
      CREATE INDEX idx_elearning_exam_attempts_org_item_user
        ON elearning_exam_attempts (org_id, course_version_item_id, user_id)
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, 'elearning_exam_attempts', ATTEMPTS_ITEM_COLUMN))) {
    return
  }

  // Match the service and up() lock order at final strength. Taking attempts
  // first would deadlock with a service transaction that already holds an item
  // row lock and then writes its attempt.
  await sql`LOCK TABLE elearning_course_version_items IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_exam_attempts IN ACCESS EXCLUSIVE MODE`.execute(db)

  const occupied = await sql<{ exists: boolean }>`
    SELECT EXISTS (SELECT 1 FROM elearning_exam_attempts) AS exists
  `.execute(db)
  if (occupied.rows[0]?.exists === true) {
    throw new Error(ATTEMPT_ITEM_DOWN_NONEMPTY)
  }

  const itemParentColumns = ['org_id', 'course_version_id', 'exam_id', 'id']
  const itemFkColumns = ['org_id', 'course_version_id', 'exam_id', 'course_version_item_id']
  const itemScopedUniq = [
    'org_id',
    'course_version_item_id',
    'user_id',
    'attempt_no',
  ]
  const itemIndexColumns = ['org_id', 'course_version_item_id', 'user_id']
  const itemParentUnique = await constraintShape(
    db,
    'elearning_course_version_items',
    ITEMS_ORG_VERSION_EXAM_ID_UNIQ,
  )
  const itemFk = await constraintShape(
    db,
    'elearning_exam_attempts',
    ATTEMPTS_ITEM_FK,
  )
  const attemptUniq = await constraintShape(
    db,
    'elearning_exam_attempts',
    ATTEMPTS_ATTEMPT_UNIQ,
  )
  const itemIndex = await indexShape(db, ATTEMPTS_ITEM_USER_INDEX)
  if (!itemParentUnique || !isExpectedUnique(itemParentUnique, itemParentColumns)) {
    throw schemaConflict(ITEMS_ORG_VERSION_EXAM_ID_UNIQ)
  }
  if (!itemFk || !isExpectedForeignKey(
    itemFk,
    itemFkColumns,
    'elearning_course_version_items',
    itemParentColumns,
  )) {
    throw schemaConflict(ATTEMPTS_ITEM_FK)
  }
  if (!attemptUniq || !isExpectedUnique(attemptUniq, itemScopedUniq)) {
    throw schemaConflict(ATTEMPTS_ATTEMPT_UNIQ)
  }
  if (!itemIndex || !isExpectedIndex(
    itemIndex,
    'elearning_exam_attempts',
    itemIndexColumns,
  )) {
    throw schemaConflict(ATTEMPTS_ITEM_USER_INDEX)
  }

  await sql`
    ALTER TABLE elearning_exam_attempts
      DROP CONSTRAINT IF EXISTS elearning_exam_attempts_item_fk
  `.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      DROP CONSTRAINT elearning_exam_attempts_attempt_uniq
  `.execute(db)
  await sql`
    ALTER TABLE elearning_exam_attempts
      ADD CONSTRAINT elearning_exam_attempts_attempt_uniq
      UNIQUE (org_id, exam_id, user_id, attempt_no)
  `.execute(db)

  await sql`
    ALTER TABLE elearning_exam_attempts
      DROP COLUMN course_version_item_id
  `.execute(db)

  await sql`
    ALTER TABLE elearning_course_version_items
      DROP CONSTRAINT IF EXISTS elearning_course_version_items_org_version_exam_id_uniq
  `.execute(db)

  await sql.raw(ORIGINAL_ATTEMPT_STATE_GUARD).execute(db)

  await sql`
    DROP INDEX IF EXISTS idx_elearning_exam_attempts_org_item_user
  `.execute(db)
  const legacyIndexColumns = ['org_id', 'exam_id', 'user_id']
  const existingLegacyIndex = await indexShape(db, ATTEMPTS_EXAM_USER_INDEX)
  if (existingLegacyIndex && !isExpectedIndex(
    existingLegacyIndex,
    'elearning_exam_attempts',
    legacyIndexColumns,
  )) {
    throw schemaConflict(ATTEMPTS_EXAM_USER_INDEX)
  }
  if (!existingLegacyIndex) {
    await sql`
      CREATE INDEX idx_elearning_exam_attempts_org_exam_user
        ON elearning_exam_attempts (org_id, exam_id, user_id)
    `.execute(db)
  }
}
