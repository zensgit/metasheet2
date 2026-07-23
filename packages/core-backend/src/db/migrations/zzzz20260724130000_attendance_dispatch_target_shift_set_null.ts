/**
 * W3 (#4556 design lock, W3 safety erratum 2026-07-24): cancelled dispatch snapshots
 * are immutable historical evidence — they do NOT block shift delete and must remain
 * stored. The original `attendance_schedule_dispatch_requests_target_shift_id_fkey`
 * was NO ACTION, so deleting a shift referenced by a cancelled snapshot would have
 * failed with a raw FK violation (500), making the erratum contract undeliverable.
 *
 * This migration re-creates the FK as ON DELETE SET NULL and makes the column
 * nullable (it was NOT NULL, which made SET NULL impossible):
 *   - the evidence ROW is never removed (delete never relies on FK cascade to remove
 *     references — SET NULL preserves the row and only clears the unresolvable
 *     pointer, exactly the state the read side already labels as deleted/unavailable);
 *   - `target_shift_id` is populated at create for every row, so a NULL value can only
 *     mean "the target shift was deleted" — which is what the neutral-label read
 *     contract reports;
 *   - pending/published rows are unaffected because the canonical shift delete blocks
 *     on them before any DELETE happens.
 *
 * Replay-safe: the constraint is only rebuilt when the existing definition is not
 * already the SET NULL variant. A partial SET NULL + NOT NULL state is repaired by
 * dropping the contradictory column constraint before returning.
 * down() restores the original NOT NULL + NO ACTION shape, failing closed (before any
 * DDL) when NULL targets exist — those rows are deleted-shift evidence and cannot be
 * re-pinned to a shift.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const TABLE = 'attendance_schedule_dispatch_requests'
const CONSTRAINT = 'attendance_schedule_dispatch_requests_target_shift_id_fkey'

async function tableExistsInCurrentSchema(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = ${tableName}
    ) AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

async function constraintDefinition(db: Kysely<unknown>): Promise<string | null> {
  const result = await sql<{ def: string | null }>`
    SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conname = ${CONSTRAINT}
       AND conrelid = ${TABLE}::regclass
  `.execute(db)
  return result.rows[0]?.def ?? null
}

async function targetColumnIsNullable(db: Kysely<unknown>): Promise<boolean> {
  const result = await sql<{ is_nullable: string }>`
    SELECT is_nullable
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ${TABLE}
       AND column_name = 'target_shift_id'
  `.execute(db)
  return result.rows[0]?.is_nullable === 'YES'
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExistsInCurrentSchema(db, TABLE))) return
  const current = await constraintDefinition(db)
  const nullable = await targetColumnIsNullable(db)
  if (current?.includes('ON DELETE SET NULL') && nullable) return

  if (!nullable) {
    // A partially applied/manual SET NULL constraint can still coexist with NOT NULL.
    // Repair that state instead of treating the FK text alone as migration completion.
    await sql`
      ALTER TABLE ${sql.table(TABLE)}
        ALTER COLUMN target_shift_id DROP NOT NULL
    `.execute(db)
  }
  if (!current?.includes('ON DELETE SET NULL')) {
    await sql`
      ALTER TABLE ${sql.table(TABLE)}
        DROP CONSTRAINT IF EXISTS ${sql.id(CONSTRAINT)}
    `.execute(db)
    await sql`
      ALTER TABLE ${sql.table(TABLE)}
        ADD CONSTRAINT ${sql.id(CONSTRAINT)}
        FOREIGN KEY (target_shift_id)
        REFERENCES attendance_shifts (id)
        ON DELETE SET NULL
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExistsInCurrentSchema(db, TABLE))) return
  const current = await constraintDefinition(db)
  if (!current || !current.includes('ON DELETE SET NULL')) return

  // Fail closed BEFORE any DDL: NULL targets are deleted-shift evidence and cannot
  // be re-pinned to a shift, so the original NOT NULL shape cannot be restored.
  const nullCount = await sql<{ total: string | number }>`
    SELECT COUNT(*)::bigint AS total
      FROM ${sql.table(TABLE)}
     WHERE target_shift_id IS NULL
  `.execute(db)
  if (Number(nullCount.rows[0]?.total ?? 0) > 0) {
    throw new Error(
      `dispatch target_shift_id down() aborted before DDL: ${Number(nullCount.rows[0]?.total)} row(s) have a NULL ` +
      `target_shift_id (deleted-shift evidence). Restore or rehome those rows before reverting to NOT NULL.`,
    )
  }

  await sql`
    ALTER TABLE ${sql.table(TABLE)}
      DROP CONSTRAINT IF EXISTS ${sql.id(CONSTRAINT)}
  `.execute(db)
  await sql`
    ALTER TABLE ${sql.table(TABLE)}
      ALTER COLUMN target_shift_id SET NOT NULL
  `.execute(db)
  await sql`
    ALTER TABLE ${sql.table(TABLE)}
      ADD CONSTRAINT ${sql.id(CONSTRAINT)}
      FOREIGN KEY (target_shift_id)
      REFERENCES attendance_shifts (id)
  `.execute(db)
}
