/**
 * W3 (#4556 design lock docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md,
 * section 3.1 + W3 safety erratum 2026-07-24): normalized `attendance_shift_segments` storage.
 *
 * Contract per row:
 *   - one row per shift segment, `segment_index` dense 0..2 (unique per shift);
 *   - `start_time`/`end_time` are local wall-clock times in the PARENT shift timezone
 *     (the table deliberately carries no timezone column — every segment uses the parent
 *     `attendance_shifts.timezone`);
 *   - `start_day_offset` is fixed to 0 in v1, `end_day_offset` is 0 or 1 (at most one
 *     midnight crossing per shift, enforced by the canonical shift service);
 *   - composite FK (shift_id, org_id) -> attendance_shifts(id, org_id) makes it impossible
 *     to persist a segment whose org differs from its parent shift org (composite org
 *     integrity). The cascade on this FK is safe: segments are owned BY the shift; the W3
 *     erratum's "delete never relies on FK cascade" rule covers the REFERENCE classes
 *     (assignments, rotation rules, swap snapshots, dispatch targets), which are checked
 *     explicitly by the canonical shift delete service instead.
 *
 * Backfill: every pre-existing shift is replay-safely backfilled as segment 0 derived from
 * its legacy envelope (work_start_time/work_end_time/is_overnight). Re-running `up()` is a
 * no-op for already-covered shifts (NOT EXISTS + ON CONFLICT DO NOTHING).
 *
 * Fail closed BEFORE any DDL (erratum): a legacy shift whose envelope cannot map to a
 * duration in (0, 24h] aborts the whole migration with the offending ids and leaves schema
 * and data unchanged. This includes non-overnight rows with end <= start and overnight rows
 * with end > start (which would become longer than 24h after adding the day offset).
 * Overnight rows with start == end are a valid 24h envelope and are NOT invalid.
 *
 * `down()` is not runtime rollback (erratum): it queries the segment table BEFORE any DDL
 * and throws when any row exists, leaving schema/data untouched; only an empty table may be
 * dropped, together with the unique index this migration added on attendance_shifts.
 *
 * Implementation note: every existence check below is pinned to `current_schema()` and all
 * DDL uses unqualified (search_path-relative) names on purpose — the shared `_patterns`
 * helpers are schema-blind, which breaks isolated-schema integration tests on a shared
 * database and could resolve a DROP against the wrong schema.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const SEGMENTS = 'attendance_shift_segments'
const SHIFTS = 'attendance_shifts'
const SHIFTS_ID_ORG_INDEX = 'uq_attendance_shifts_id_org'
const SHIFTS_ID_ORG_INDEX_OWNER = 'attendance_shift_segments_migration_owned'
const COMPOSITE_FK = 'fk_attendance_shift_segments_shift_org'

async function tableExistsInCurrentSchema(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = ${tableName}
    ) AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

async function indexExistsInCurrentSchema(db: Kysely<unknown>, indexName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = ${indexName}
    ) AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

async function indexOwnedByThisMigration(db: Kysely<unknown>, indexName: string): Promise<boolean> {
  const result = await sql<{ owned: boolean }>`
    SELECT COALESCE(obj_description(c.oid, 'pg_class'), '') = ${SHIFTS_ID_ORG_INDEX_OWNER} AS owned
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = ${indexName}
       AND c.relkind = 'i'
  `.execute(db)
  return result.rows[0]?.owned === true
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExistsInCurrentSchema(db, SHIFTS))) return

  // Fail closed BEFORE any DDL: legacy envelopes that cannot become a segment 0 whose
  // duration is in (0, 24h]. No CREATE/ALTER above this line may touch the database.
  const invalid = await sql<{ id: string }>`
    SELECT id
      FROM ${sql.table(SHIFTS)}
     WHERE (
       NOT COALESCE(is_overnight, false)
       AND work_end_time <= work_start_time
     ) OR (
       COALESCE(is_overnight, false)
       AND work_end_time > work_start_time
     )
     ORDER BY id
  `.execute(db)
  if (invalid.rows.length > 0) {
    const ids = invalid.rows.map((row) => row.id).join(', ')
    throw new Error(
      `attendance_shift_segments migration aborted before DDL: ${invalid.rows.length} ` +
      `attendance_shifts row(s) have a legacy envelope outside (0, 24h] and cannot be ` +
      `backfilled as segment 0: ${ids}`,
    )
  }

  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  if (!(await tableExistsInCurrentSchema(db, SEGMENTS))) {
    await db.schema
      .createTable(SEGMENTS)
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('org_id', 'text', (col) => col.notNull())
      .addColumn('shift_id', 'uuid', (col) => col.notNull())
      .addColumn('segment_index', 'integer', (col) => col.notNull())
      .addColumn('start_time', 'time', (col) => col.notNull())
      .addColumn('start_day_offset', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('end_time', 'time', (col) => col.notNull())
      .addColumn('end_day_offset', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
      .addCheckConstraint('chk_attendance_shift_segments_index_range', sql`segment_index BETWEEN 0 AND 2`)
      .addCheckConstraint('chk_attendance_shift_segments_start_day_offset', sql`start_day_offset = 0`)
      .addCheckConstraint('chk_attendance_shift_segments_end_day_offset', sql`end_day_offset IN (0, 1)`)
      .execute()
  }

  // Composite org integrity target: the FK below references (id, org_id), so Postgres needs
  // a unique index over exactly those columns on the parent (id alone is already the PK).
  if (!(await indexExistsInCurrentSchema(db, SHIFTS_ID_ORG_INDEX))) {
    await sql`CREATE UNIQUE INDEX ${sql.id(SHIFTS_ID_ORG_INDEX)} ON ${sql.table(SHIFTS)} (id, org_id)`.execute(db)
    await sql`COMMENT ON INDEX ${sql.id(SHIFTS_ID_ORG_INDEX)} IS ${sql.lit(SHIFTS_ID_ORG_INDEX_OWNER)}`.execute(db)
  }

  const fkExists = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = ${COMPOSITE_FK}
         AND conrelid = ${SEGMENTS}::regclass
    ) AS exists
  `.execute(db)
  if (!fkExists.rows[0]?.exists) {
    await sql`
      ALTER TABLE ${sql.table(SEGMENTS)}
        ADD CONSTRAINT ${sql.id(COMPOSITE_FK)}
        FOREIGN KEY (shift_id, org_id)
        REFERENCES ${sql.table(SHIFTS)} (id, org_id)
        ON DELETE CASCADE
    `.execute(db)
  }

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.id('uq_attendance_shift_segments_shift_index')} ON ${sql.table(SEGMENTS)} (shift_id, segment_index)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS ${sql.id('idx_attendance_shift_segments_org_shift')} ON ${sql.table(SEGMENTS)} (org_id, shift_id)`.execute(db)

  // Replay-safe backfill: every shift becomes segment 0 exactly once. Shifts that already
  // have any segment row (canonical service writes, or an earlier replay) are skipped.
  await sql`
    INSERT INTO ${sql.table(SEGMENTS)}
      (org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
    SELECT s.org_id,
           s.id,
           0,
           s.work_start_time,
           0,
           s.work_end_time,
           CASE WHEN COALESCE(s.is_overnight, false) THEN 1 ELSE 0 END
      FROM ${sql.table(SHIFTS)} s
     WHERE NOT EXISTS (
       SELECT 1
         FROM ${sql.table(SEGMENTS)} seg
        WHERE seg.shift_id = s.id
     )
    ON CONFLICT (shift_id, segment_index) DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await tableExistsInCurrentSchema(db, SEGMENTS)) {
    // Fail closed BEFORE any DDL: never destructively drop persisted segment data.
    const count = await sql<{ total: string | number }>`
      SELECT COUNT(*)::bigint AS total FROM ${sql.table(SEGMENTS)}
    `.execute(db)
    const total = Number(count.rows[0]?.total ?? 0)
    if (total > 0) {
      throw new Error(
        `attendance_shift_segments down() aborted before DDL: ${total} segment row(s) exist. ` +
        `Migration down() is not runtime rollback; persisted segment data is never dropped ` +
        `destructively. Empty the table through a separately authorized cleanup first.`,
      )
    }
    await sql`
      ALTER TABLE ${sql.table(SEGMENTS)}
        DROP CONSTRAINT IF EXISTS ${sql.id(COMPOSITE_FK)}
    `.execute(db)
    await db.schema.dropTable(SEGMENTS).ifExists().execute()
  }
  // Schema-local and ownership-marked drop only: an identically named index that
  // predated this migration belongs to its original owner and must survive down().
  if (
    await indexExistsInCurrentSchema(db, SHIFTS_ID_ORG_INDEX)
    && await indexOwnedByThisMigration(db, SHIFTS_ID_ORG_INDEX)
  ) {
    await sql`DROP INDEX IF EXISTS ${sql.id(SHIFTS_ID_ORG_INDEX)}`.execute(db)
  }
}
