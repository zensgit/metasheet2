/**
 * W3 / #4556 — `zzzz20260724120000_create_attendance_shift_segments` real-DB coverage.
 *
 * Proves (design lock section 7.1 + W3 safety erratum):
 *   1. FRESH: up() on an empty pre-segment schema creates the table, composite-org FK,
 *      unique (shift_id, segment_index), and check constraints.
 *   2. UPGRADE + BACKFILL: every legacy shift becomes exactly one segment 0 derived from
 *      its envelope (overnight -> end_day_offset 1); org is copied from the parent.
 *   3. REPLAY: up() twice is a no-op for already-covered shifts (idempotent backfill).
 *   4. FAIL CLOSED BEFORE DDL: a legacy row outside (0, 24h] (non-overnight end <=
 *      start, or overnight end > start) aborts up() and leaves schema + data unchanged.
 *   5. CROSS-ORG INTEGRITY: the composite FK rejects a segment whose org differs from
 *      the parent shift org.
 *   6. down(): with any segment row present it throws BEFORE any DDL (table and index
 *      intact afterwards); on an empty table it drops table + the attendance_shifts
 *      unique index this migration introduced.
 *
 * Isolated schema + search_path (house rule for shared-DB integration).
 */
import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  up as segmentsUp,
  down as segmentsDown,
} from '../../src/db/migrations/zzzz20260724120000_create_attendance_shift_segments'
import {
  up as dispatchFkUp,
  down as dispatchFkDown,
} from '../../src/db/migrations/zzzz20260724130000_attendance_dispatch_target_shift_set_null'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const SHIFTS_ID_ORG_INDEX = 'uq_attendance_shifts_id_org'

describeDb('attendance_shift_segments migration (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `w3seg_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

    // Pre-segment attendance_shifts shape (zzzz20260114120000 + zzzz20260323153000).
    await sql`
      CREATE TABLE attendance_shifts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL DEFAULT 'default',
        name text NOT NULL,
        timezone varchar(64) NOT NULL DEFAULT 'UTC',
        work_start_time time NOT NULL DEFAULT '09:00',
        work_end_time time NOT NULL DEFAULT '18:00',
        late_grace_minutes integer NOT NULL DEFAULT 10,
        early_grace_minutes integer NOT NULL DEFAULT 10,
        rounding_minutes integer NOT NULL DEFAULT 5,
        working_days jsonb NOT NULL DEFAULT '[1,2,3,4,5]',
        is_overnight boolean NOT NULL DEFAULT false,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )
    `.execute(testDb)
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  async function tableExists(name: string): Promise<boolean> {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ${name}
      ) AS exists
    `.execute(testDb)
    return r.rows[0]?.exists === true
  }

  async function indexExists(name: string): Promise<boolean> {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = ${name}
      ) AS exists
    `.execute(testDb)
    return r.rows[0]?.exists === true
  }

  async function segmentRows(): Promise<Array<Record<string, unknown>>> {
    if (!(await tableExists('attendance_shift_segments'))) return []
    const r = await sql`SELECT * FROM attendance_shift_segments ORDER BY shift_id, segment_index`.execute(testDb)
    return r.rows as Array<Record<string, unknown>>
  }

  async function insertShift(overrides: Record<string, unknown> = {}): Promise<string> {
    const row = {
      org_id: 'org-a',
      name: 'Day',
      work_start_time: '09:00',
      work_end_time: '18:00',
      is_overnight: false,
      ...overrides,
    }
    const r = await sql<{ id: string }>`
      INSERT INTO attendance_shifts (org_id, name, work_start_time, work_end_time, is_overnight)
      VALUES (${row.org_id}, ${row.name}, ${row.work_start_time}, ${row.work_end_time}, ${row.is_overnight})
      RETURNING id
    `.execute(testDb)
    return r.rows[0]!.id
  }

  it('FRESH: up() on an empty schema creates table, constraints, and the org-integrity FK', async () => {
    await segmentsUp(testDb)

    expect(await tableExists('attendance_shift_segments')).toBe(true)
    expect(await indexExists('uq_attendance_shift_segments_shift_index')).toBe(true)
    expect(await indexExists(SHIFTS_ID_ORG_INDEX)).toBe(true)

    const checks = await sql<{ conname: string }>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'attendance_shift_segments'::regclass AND contype = 'c'
    `.execute(testDb)
    const names = checks.rows.map((row) => row.conname)
    expect(names).toContain('chk_attendance_shift_segments_index_range')
    expect(names).toContain('chk_attendance_shift_segments_start_day_offset')
    expect(names).toContain('chk_attendance_shift_segments_end_day_offset')

    const fks = await sql<{ conname: string; def: string }>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'attendance_shift_segments'::regclass AND contype = 'f'
    `.execute(testDb)
    expect(fks.rows).toHaveLength(1)
    expect(fks.rows[0]!.conname).toBe('fk_attendance_shift_segments_shift_org')
    expect(fks.rows[0]!.def).toContain('FOREIGN KEY (shift_id, org_id)')
    expect(fks.rows[0]!.def).toContain('REFERENCES attendance_shifts(id, org_id)')

    expect(await segmentRows()).toEqual([])
  })

  it('UPGRADE + BACKFILL: every legacy shift becomes segment 0; overnight maps to end_day_offset 1', async () => {
    const dayId = await insertShift({ name: 'Day', org_id: 'org-a' })
    const nightId = await insertShift({ name: 'Night', org_id: 'org-b', work_start_time: '22:00', work_end_time: '06:00', is_overnight: true })

    await segmentsUp(testDb)

    const rows = await segmentRows()
    expect(rows).toHaveLength(2)
    const day = rows.find((row) => row.shift_id === dayId)!
    expect(day).toMatchObject({ org_id: 'org-a', segment_index: 0, start_day_offset: 0, end_day_offset: 0 })
    expect(String(day.start_time)).toBe('09:00:00')
    expect(String(day.end_time)).toBe('18:00:00')
    const night = rows.find((row) => row.shift_id === nightId)!
    expect(night).toMatchObject({ org_id: 'org-b', segment_index: 0, start_day_offset: 0, end_day_offset: 1 })
  })

  it('REPLAY: a second up() is a no-op for already-covered shifts', async () => {
    const dayId = await insertShift({})
    await segmentsUp(testDb)
    const first = await segmentRows()
    expect(first).toHaveLength(1)

    // A shift that already has ANY segment row must never be re-backfilled.
    await sql`
      INSERT INTO attendance_shift_segments (org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
      VALUES ('org-a', ${dayId}, 1, '13:00', 0, '17:00', 0)
    `.execute(testDb)
    const otherId = await insertShift({ name: 'Late', work_start_time: '13:00', work_end_time: '21:00' })

    await segmentsUp(testDb)
    const second = await segmentRows()
    // dayId keeps exactly its two rows (no duplicate segment 0); the new shift is backfilled once.
    expect(second.filter((row) => row.shift_id === dayId)).toHaveLength(2)
    expect(second.filter((row) => row.shift_id === otherId)).toHaveLength(1)
    expect(second).toHaveLength(3)
  })

  it('FAIL CLOSED BEFORE DDL: legacy envelopes outside (0, 24h] abort with schema and data unchanged', async () => {
    await insertShift({ name: 'Valid' })
    const zeroId = await insertShift({ name: 'Zero', work_start_time: '09:00', work_end_time: '09:00' })
    const over24Id = await insertShift({
      name: 'Over24',
      work_start_time: '09:00',
      work_end_time: '17:00',
      is_overnight: true,
    })

    await expect(segmentsUp(testDb)).rejects.toThrow(/aborted before DDL/)
    await expect(segmentsUp(testDb)).rejects.toThrow(zeroId)
    await expect(segmentsUp(testDb)).rejects.toThrow(over24Id)

    expect(await tableExists('attendance_shift_segments')).toBe(false)
    expect(await indexExists(SHIFTS_ID_ORG_INDEX)).toBe(false)
    const shifts = await sql<{ total: string }>`SELECT COUNT(*)::text AS total FROM attendance_shifts`.execute(testDb)
    expect(shifts.rows[0]!.total).toBe('3')
  })

  it('CROSS-ORG INTEGRITY: the composite FK rejects a segment whose org differs from the parent shift', async () => {
    const shiftId = await insertShift({ org_id: 'org-a' })
    await segmentsUp(testDb)

    await expect(sql`
      INSERT INTO attendance_shift_segments (org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
      VALUES ('org-b', ${shiftId}, 1, '13:00', 0, '17:00', 0)
    `.execute(testDb)).rejects.toThrow(/fk_attendance_shift_segments_shift_org/)

    // Same-org insert still works.
    await sql`
      INSERT INTO attendance_shift_segments (org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
      VALUES ('org-a', ${shiftId}, 1, '13:00', 0, '17:00', 0)
    `.execute(testDb)
    expect(await segmentRows()).toHaveLength(2)
  })

  it('down(): aborts BEFORE any DDL when segment rows exist; drops only an empty table', async () => {
    const shiftId = await insertShift({})
    await segmentsUp(testDb)
    expect(await segmentRows()).toHaveLength(1)

    await expect(segmentsDown(testDb)).rejects.toThrow(/aborted before DDL/)
    // Nothing was dropped: table, data, and the shifts index are all intact.
    expect(await tableExists('attendance_shift_segments')).toBe(true)
    expect(await segmentRows()).toHaveLength(1)
    expect(await indexExists(SHIFTS_ID_ORG_INDEX)).toBe(true)

    // Empty the table through an explicit data action (not the migration), then down()
    // may drop the empty table plus the index this migration introduced.
    await sql`DELETE FROM attendance_shift_segments WHERE shift_id = ${shiftId}`.execute(testDb)
    await segmentsDown(testDb)
    expect(await tableExists('attendance_shift_segments')).toBe(false)
    expect(await indexExists(SHIFTS_ID_ORG_INDEX)).toBe(false)

    // down() on a schema that never had the table is a safe no-op.
    await segmentsDown(testDb)
  })

  it('down(): preserves a same-named parent index that predated this migration', async () => {
    await sql`
      CREATE UNIQUE INDEX ${sql.id(SHIFTS_ID_ORG_INDEX)}
        ON attendance_shifts (id, org_id)
    `.execute(testDb)
    await segmentsUp(testDb)
    await sql`DELETE FROM attendance_shift_segments`.execute(testDb)

    await segmentsDown(testDb)

    expect(await tableExists('attendance_shift_segments')).toBe(false)
    expect(await indexExists(SHIFTS_ID_ORG_INDEX)).toBe(true)
  })

  it('dispatch target FK: SET NULL up() is replay-safe, down() restores and fails closed on evidence NULLs', async () => {
    // Pre-migration dispatch table shape (NO ACTION FK, NOT NULL target).
    await sql`
      CREATE TABLE attendance_schedule_dispatch_requests (
        request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL DEFAULT 'default',
        dispatch_type text NOT NULL DEFAULT 'daily',
        user_id text NOT NULL,
        target_schedule_group_id uuid,
        target_shift_id uuid NOT NULL,
        slot_index integer NOT NULL DEFAULT 0,
        start_date date NOT NULL,
        end_date date NOT NULL,
        publish_status text NOT NULL DEFAULT 'pending',
        source_key text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )
    `.execute(testDb)
    const shiftId = await insertShift({})
    await sql`
      ALTER TABLE attendance_schedule_dispatch_requests
        ADD CONSTRAINT attendance_schedule_dispatch_requests_target_shift_id_fkey
        FOREIGN KEY (target_shift_id) REFERENCES attendance_shifts (id)
    `.execute(testDb)
    await sql`
      INSERT INTO attendance_schedule_dispatch_requests (org_id, user_id, target_shift_id, start_date, end_date, publish_status)
      VALUES ('org-a', 'user-a', ${shiftId}, '2049-06-10', '2049-06-10', 'cancelled')
    `.execute(testDb)

    await dispatchFkUp(testDb)
    const def = async () => {
      const r = await sql<{ def: string }>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'attendance_schedule_dispatch_requests_target_shift_id_fkey'
          AND conrelid = 'attendance_schedule_dispatch_requests'::regclass
      `.execute(testDb)
      return r.rows[0]?.def ?? ''
    }
    expect(await def()).toContain('ON DELETE SET NULL')
    // Replay: second up() is a no-op.
    await dispatchFkUp(testDb)
    expect(await def()).toContain('ON DELETE SET NULL')

    // A cancelled snapshot no longer blocks the parent delete; the evidence row stays.
    await sql`DELETE FROM attendance_shifts WHERE id = ${shiftId}`.execute(testDb)
    const kept = await sql<{ target_shift_id: string | null }>`
      SELECT target_shift_id FROM attendance_schedule_dispatch_requests WHERE org_id = 'org-a'
    `.execute(testDb)
    expect(kept.rows).toHaveLength(1)
    expect(kept.rows[0]!.target_shift_id).toBeNull()

    // down() fails closed BEFORE any DDL while evidence NULLs exist.
    await expect(dispatchFkDown(testDb)).rejects.toThrow(/aborted before DDL/)
    expect(await def()).toContain('ON DELETE SET NULL')

    // With the evidence row removed by an explicit data action, down() restores the
    // original NOT NULL + NO ACTION shape.
    await sql`DELETE FROM attendance_schedule_dispatch_requests WHERE org_id = 'org-a'`.execute(testDb)
    await dispatchFkDown(testDb)
    const restored = await def()
    expect(restored).toContain('FOREIGN KEY (target_shift_id)')
    expect(restored).not.toContain('ON DELETE SET NULL')
    const nullable = await sql<{ is_nullable: string }>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'attendance_schedule_dispatch_requests'
        AND column_name = 'target_shift_id'
    `.execute(testDb)
    expect(nullable.rows[0]!.is_nullable).toBe('NO')
  })

  it('dispatch target FK: repairs a partial SET NULL + NOT NULL schema instead of false no-op', async () => {
    await sql`
      CREATE TABLE attendance_schedule_dispatch_requests (
        request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        target_shift_id uuid NOT NULL
      )
    `.execute(testDb)
    await sql`
      ALTER TABLE attendance_schedule_dispatch_requests
        ADD CONSTRAINT attendance_schedule_dispatch_requests_target_shift_id_fkey
        FOREIGN KEY (target_shift_id) REFERENCES attendance_shifts (id)
        ON DELETE SET NULL
    `.execute(testDb)

    await dispatchFkUp(testDb)

    const nullable = await sql<{ is_nullable: string }>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'attendance_schedule_dispatch_requests'
        AND column_name = 'target_shift_id'
    `.execute(testDb)
    expect(nullable.rows[0]!.is_nullable).toBe('YES')
  })
})
