/**
 * W5 (#4556 design lock
 * docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md
 * sections 3.3 + 9.6): minimal persistence for flexible single-segment attendance.
 *
 * Contract:
 *   - `flex_mode` is the discriminator: `strict` (default) | `flex_required_duration`;
 *   - when `strict`, every flex_* value column is NULL (legacy/default shape);
 *   - when `flex_required_duration`, required minutes and both arrival windows are
 *     NOT NULL non-negative integers with required_minutes in (0, 1440]; core times
 *     are optional as a pair;
 *   - multi-segment flex is rejected by the canonical shift service (not a DB
 *     multi-table constraint): the service refuses flex_required_duration when the
 *     shift has more than one segment;
 *   - optional core-hours coverage for every clamped arrival is an **authoring**
 *     guarantee (service + pure validator); this migration does not invent a new
 *     runtime segment reasonCode;
 *   - existing shifts backfill as `strict` with NULL flex values (byte-compatible
 *     reads of legacy rows);
 *   - `down()` fails closed before any DDL when any non-strict flex row exists.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const SHIFTS = 'attendance_shifts'
const FLEX_MODE_CHECK = 'chk_attendance_shifts_flex_mode'
const FLEX_DISCRIMINATED_CHECK = 'chk_attendance_shifts_flex_discriminated'

async function tableExistsInCurrentSchema(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = ${tableName}
    ) AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

async function columnExistsInCurrentSchema(
  db: Kysely<unknown>,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExistsInCurrentSchema(db, SHIFTS))) return

  if (!(await columnExistsInCurrentSchema(db, SHIFTS, 'flex_mode'))) {
    await sql`
      ALTER TABLE ${sql.table(SHIFTS)}
        ADD COLUMN flex_mode text NOT NULL DEFAULT 'strict'
    `.execute(db)
  }
  if (!(await columnExistsInCurrentSchema(db, SHIFTS, 'flex_required_minutes'))) {
    await sql`
      ALTER TABLE ${sql.table(SHIFTS)}
        ADD COLUMN flex_required_minutes integer NULL
    `.execute(db)
  }
  if (!(await columnExistsInCurrentSchema(db, SHIFTS, 'flex_arrival_window_before_minutes'))) {
    await sql`
      ALTER TABLE ${sql.table(SHIFTS)}
        ADD COLUMN flex_arrival_window_before_minutes integer NULL
    `.execute(db)
  }
  if (!(await columnExistsInCurrentSchema(db, SHIFTS, 'flex_arrival_window_after_minutes'))) {
    await sql`
      ALTER TABLE ${sql.table(SHIFTS)}
        ADD COLUMN flex_arrival_window_after_minutes integer NULL
    `.execute(db)
  }
  if (!(await columnExistsInCurrentSchema(db, SHIFTS, 'flex_core_start_time'))) {
    await sql`
      ALTER TABLE ${sql.table(SHIFTS)}
        ADD COLUMN flex_core_start_time time NULL
    `.execute(db)
  }
  if (!(await columnExistsInCurrentSchema(db, SHIFTS, 'flex_core_end_time'))) {
    await sql`
      ALTER TABLE ${sql.table(SHIFTS)}
        ADD COLUMN flex_core_end_time time NULL
    `.execute(db)
  }

  // Replay-safe: every pre-existing row stays strict with null flex values.
  await sql`
    UPDATE ${sql.table(SHIFTS)}
       SET flex_mode = 'strict',
           flex_required_minutes = NULL,
           flex_arrival_window_before_minutes = NULL,
           flex_arrival_window_after_minutes = NULL,
           flex_core_start_time = NULL,
           flex_core_end_time = NULL
     WHERE flex_mode IS NULL
        OR flex_mode NOT IN ('strict', 'flex_required_duration')
  `.execute(db)

  await sql`
    ALTER TABLE ${sql.table(SHIFTS)}
      DROP CONSTRAINT IF EXISTS ${sql.id(FLEX_MODE_CHECK)}
  `.execute(db)
  await sql`
    ALTER TABLE ${sql.table(SHIFTS)}
      ADD CONSTRAINT ${sql.id(FLEX_MODE_CHECK)}
      CHECK (flex_mode IN ('strict', 'flex_required_duration'))
  `.execute(db)

  await sql`
    ALTER TABLE ${sql.table(SHIFTS)}
      DROP CONSTRAINT IF EXISTS ${sql.id(FLEX_DISCRIMINATED_CHECK)}
  `.execute(db)
  await sql`
    ALTER TABLE ${sql.table(SHIFTS)}
      ADD CONSTRAINT ${sql.id(FLEX_DISCRIMINATED_CHECK)}
      CHECK (
        (
          flex_mode = 'strict'
          AND flex_required_minutes IS NULL
          AND flex_arrival_window_before_minutes IS NULL
          AND flex_arrival_window_after_minutes IS NULL
          AND flex_core_start_time IS NULL
          AND flex_core_end_time IS NULL
        )
        OR (
          flex_mode = 'flex_required_duration'
          AND flex_required_minutes IS NOT NULL
          AND flex_required_minutes > 0
          AND flex_required_minutes <= 1440
          AND flex_arrival_window_before_minutes IS NOT NULL
          AND flex_arrival_window_before_minutes >= 0
          AND flex_arrival_window_after_minutes IS NOT NULL
          AND flex_arrival_window_after_minutes >= 0
          AND (
            (flex_core_start_time IS NULL AND flex_core_end_time IS NULL)
            OR (flex_core_start_time IS NOT NULL AND flex_core_end_time IS NOT NULL)
          )
        )
      )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExistsInCurrentSchema(db, SHIFTS))) return

  if (await columnExistsInCurrentSchema(db, SHIFTS, 'flex_mode')) {
    const count = await sql<{ total: string | number }>`
      SELECT COUNT(*)::bigint AS total
        FROM ${sql.table(SHIFTS)}
       WHERE flex_mode IS DISTINCT FROM 'strict'
          OR flex_required_minutes IS NOT NULL
          OR flex_arrival_window_before_minutes IS NOT NULL
          OR flex_arrival_window_after_minutes IS NOT NULL
          OR flex_core_start_time IS NOT NULL
          OR flex_core_end_time IS NOT NULL
    `.execute(db)
    const total = Number(count.rows[0]?.total ?? 0)
    if (total > 0) {
      throw new Error(
        `attendance_shift_flex_policy down() aborted before DDL: ${total} shift row(s) ` +
          `carry non-strict flex policy. Migration down() is not runtime rollback; ` +
          `clear flex configuration through a separately authorized cleanup first.`,
      )
    }
  }

  await sql`
    ALTER TABLE ${sql.table(SHIFTS)}
      DROP CONSTRAINT IF EXISTS ${sql.id(FLEX_DISCRIMINATED_CHECK)}
  `.execute(db)
  await sql`
    ALTER TABLE ${sql.table(SHIFTS)}
      DROP CONSTRAINT IF EXISTS ${sql.id(FLEX_MODE_CHECK)}
  `.execute(db)

  if (await columnExistsInCurrentSchema(db, SHIFTS, 'flex_core_end_time')) {
    await sql`ALTER TABLE ${sql.table(SHIFTS)} DROP COLUMN flex_core_end_time`.execute(db)
  }
  if (await columnExistsInCurrentSchema(db, SHIFTS, 'flex_core_start_time')) {
    await sql`ALTER TABLE ${sql.table(SHIFTS)} DROP COLUMN flex_core_start_time`.execute(db)
  }
  if (await columnExistsInCurrentSchema(db, SHIFTS, 'flex_arrival_window_after_minutes')) {
    await sql`ALTER TABLE ${sql.table(SHIFTS)} DROP COLUMN flex_arrival_window_after_minutes`.execute(db)
  }
  if (await columnExistsInCurrentSchema(db, SHIFTS, 'flex_arrival_window_before_minutes')) {
    await sql`ALTER TABLE ${sql.table(SHIFTS)} DROP COLUMN flex_arrival_window_before_minutes`.execute(db)
  }
  if (await columnExistsInCurrentSchema(db, SHIFTS, 'flex_required_minutes')) {
    await sql`ALTER TABLE ${sql.table(SHIFTS)} DROP COLUMN flex_required_minutes`.execute(db)
  }
  if (await columnExistsInCurrentSchema(db, SHIFTS, 'flex_mode')) {
    await sql`ALTER TABLE ${sql.table(SHIFTS)} DROP COLUMN flex_mode`.execute(db)
  }
}
