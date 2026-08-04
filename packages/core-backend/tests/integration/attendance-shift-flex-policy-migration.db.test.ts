/**
 * W5 / #4556 — flex policy persistence migration real-DB coverage.
 *
 * Proves:
 *   1. up() adds discriminated flex columns with strict default;
 *   2. strict rows keep null flex values;
 *   3. flex_required_duration accepts a valid shape;
 *   4. multi-field discriminator rejects incomplete flex rows;
 *   5. down() fails closed when non-strict flex data exists;
 *   6. down() on all-strict rows restores the pre-W5 shape.
 *
 * Core-hours coverage is an authoring/service guarantee, not a DB reasonCode.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  up as segmentsUp,
} from '../../src/db/migrations/zzzz20260724120000_create_attendance_shift_segments'
import {
  up as flexUp,
  down as flexDown,
} from '../../src/db/migrations/zzzz20260804120000_attendance_shift_flex_policy'

const require = createRequire(import.meta.url)
const shiftServiceLib = require('../../../../plugins/plugin-attendance/lib/attendance-shift-service.cjs')

class FakeHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Array<{ field: string; message: string }>,
  ) {
    super(message)
  }
}

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('attendance_shift_flex_policy migration (real DB, isolated schema)', () => {
  let pool: Pool
  let db: Kysely<any>
  let schemaName: string

  function makeShiftService() {
    return shiftServiceLib.createAttendanceShiftService({
      HttpError: FakeHttpError,
      randomUUID,
      resolveShiftTiming: () => { throw new Error('segments are required in this suite') },
      normalizeWorkingDays: (value: unknown) => value,
      mapShiftRow: (row: Record<string, unknown>) => ({
        id: row.id,
        orgId: row.org_id,
        name: row.name,
        timezone: row.timezone,
        workStartTime: row.work_start_time,
        workEndTime: row.work_end_time,
        isOvernight: row.is_overnight,
        lateGraceMinutes: row.late_grace_minutes,
        earlyGraceMinutes: row.early_grace_minutes,
        roundingMinutes: row.rounding_minutes,
        workingDays: row.working_days,
      }),
      DEFAULT_SHIFT: {
        name: 'Default',
        timezone: 'UTC',
        lateGraceMinutes: 10,
        earlyGraceMinutes: 10,
        roundingMinutes: 5,
        workingDays: [1, 2, 3, 4, 5],
      },
      DEFAULT_ORG_ID: 'default',
    })
  }

  function makeServiceDb() {
    return {
      transaction: async <T>(callback: (trx: {
        query: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>
      }) => Promise<T>): Promise<T> => {
        const client = await pool.connect()
        await client.query('BEGIN')
        try {
          await client.query(`SET LOCAL search_path TO "${schemaName}"`)
          const result = await callback({
            query: async (text: string, values: unknown[] = []) => (
              await client.query(text, values)
            ).rows,
          })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
    }
  }

  beforeEach(async () => {
    schemaName = `w5_flex_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    pool = new Pool({ connectionString: dbUrl })
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    await sql.raw(`CREATE SCHEMA ${schemaName}`).execute(db)
    await sql.raw(`SET search_path TO ${schemaName}`).execute(db)

    await sql`
      CREATE TABLE attendance_shifts (
        id uuid PRIMARY KEY,
        org_id text NOT NULL,
        name text NOT NULL,
        timezone text NOT NULL DEFAULT 'UTC',
        work_start_time time NOT NULL,
        work_end_time time NOT NULL,
        late_grace_minutes integer NOT NULL DEFAULT 0,
        early_grace_minutes integer NOT NULL DEFAULT 0,
        rounding_minutes integer NOT NULL DEFAULT 1,
        working_days jsonb,
        is_overnight boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db)
    await segmentsUp(db)
    await sql`CREATE TABLE attendance_shift_assignments (org_id text NOT NULL, shift_id uuid NOT NULL)`.execute(db)
    await sql`CREATE TABLE attendance_group_fixed_schedule_configs (org_id text NOT NULL, shift_id uuid NOT NULL)`.execute(db)
    await sql`CREATE TABLE attendance_rotation_rules (org_id text NOT NULL, shift_sequence jsonb NOT NULL DEFAULT '[]'::jsonb)`.execute(db)
    await sql`CREATE TABLE attendance_requests (id uuid PRIMARY KEY, status text NOT NULL)`.execute(db)
    await sql`
      CREATE TABLE attendance_shift_swap_requests (
        org_id text NOT NULL,
        request_id uuid NOT NULL,
        requester_shift_id uuid,
        counterparty_shift_id uuid
      )
    `.execute(db)
    await sql`
      CREATE TABLE attendance_schedule_dispatch_requests (
        org_id text NOT NULL,
        target_shift_id uuid NOT NULL,
        publish_status text NOT NULL
      )
    `.execute(db)
  })

  afterEach(async () => {
    try {
      await sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).execute(db)
    } finally {
      await db.destroy()
    }
  })

  it('adds strict defaults, enforces discriminated flex, and fail-closes down with flex data', async () => {
    const strictId = randomUUID()
    const flexId = randomUUID()
    await sql`
      INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
      VALUES (${strictId}::uuid, 'org-a', 'Strict', '09:00', '18:00')
    `.execute(db)

    await flexUp(db)
    await flexUp(db) // replay-safe

    const strictRow = await sql<{
      flex_mode: string
      flex_required_minutes: number | null
    }>`
      SELECT flex_mode, flex_required_minutes
        FROM attendance_shifts
       WHERE id = ${strictId}::uuid
    `.execute(db)
    expect(strictRow.rows[0]).toEqual({
      flex_mode: 'strict',
      flex_required_minutes: null,
    })

    await sql`
      INSERT INTO attendance_shifts (
        id, org_id, name, work_start_time, work_end_time,
        flex_mode, flex_required_minutes,
        flex_arrival_window_before_minutes, flex_arrival_window_after_minutes,
        flex_core_start_time, flex_core_end_time
      ) VALUES (
        ${flexId}::uuid, 'org-a', 'Flex', '09:00', '18:00',
        'flex_required_duration', 480, 60, 60, '10:00', '15:00'
      )
    `.execute(db)

    await expect(sql`
      INSERT INTO attendance_shifts (
        id, org_id, name, work_start_time, work_end_time,
        flex_mode, flex_required_minutes
      ) VALUES (
        ${randomUUID()}::uuid, 'org-a', 'Bad', '09:00', '18:00',
        'flex_required_duration', 480
      )
    `.execute(db)).rejects.toThrow()

    await expect(flexDown(db)).rejects.toThrow(/aborted before DDL/)

    await sql`
      UPDATE attendance_shifts
         SET flex_mode = 'strict',
             flex_required_minutes = NULL,
             flex_arrival_window_before_minutes = NULL,
             flex_arrival_window_after_minutes = NULL,
             flex_core_start_time = NULL,
             flex_core_end_time = NULL
    `.execute(db)
    await flexDown(db)

    const columns = await sql<{ column_name: string }>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'attendance_shifts'
         AND column_name LIKE 'flex_%'
    `.execute(db)
    expect(columns.rows).toEqual([])
  })

  it('persists canonical flex creates and rolls back invalid updates with zero partial writes', async () => {
    await flexUp(db)
    const service = makeShiftService()
    const serviceDb = makeServiceDb()
    const flexPolicy = {
      mode: 'flex_required_duration',
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 60,
      coreStartTime: '10:00',
      coreEndTime: '15:00',
    }

    const created = await service.createShift(serviceDb, {
      orgId: 'org-a',
      input: {
        name: 'Flex shift',
        timezone: 'Asia/Shanghai',
        segments: [{ startTime: '09:00', endTime: '18:00' }],
        flexPolicy,
      },
    })
    expect(created).toMatchObject({
      orgId: 'org-a',
      flexPolicy,
      flexEligible: true,
      plannedMinutes: 480,
    })

    const beforeInvalid = await sql<{
      flex_mode: string
      flex_required_minutes: number | null
      segment_count: number
    }>`
      SELECT s.flex_mode,
             s.flex_required_minutes,
             COUNT(seg.id)::int AS segment_count
        FROM attendance_shifts s
        LEFT JOIN attendance_shift_segments seg
          ON seg.org_id = s.org_id AND seg.shift_id = s.id
       WHERE s.id = ${created.id}::uuid AND s.org_id = 'org-a'
       GROUP BY s.id
    `.execute(db)
    expect(beforeInvalid.rows[0]).toEqual({
      flex_mode: 'flex_required_duration',
      flex_required_minutes: 480,
      segment_count: 1,
    })

    await expect(service.updateShift(serviceDb, {
      orgId: 'org-a',
      shiftId: created.id,
      patch: {
        segments: [
          { startTime: '08:00', endTime: '12:00' },
          { startTime: '13:00', endTime: '17:00' },
        ],
      },
    })).rejects.toMatchObject({
      status: 422,
      code: 'ATTENDANCE_SHIFT_FLEX_POLICY_INVALID',
    })

    const afterInvalid = await sql<{
      flex_mode: string
      flex_required_minutes: number | null
      segment_count: number
    }>`
      SELECT s.flex_mode,
             s.flex_required_minutes,
             COUNT(seg.id)::int AS segment_count
        FROM attendance_shifts s
        LEFT JOIN attendance_shift_segments seg
          ON seg.org_id = s.org_id AND seg.shift_id = s.id
       WHERE s.id = ${created.id}::uuid AND s.org_id = 'org-a'
       GROUP BY s.id
    `.execute(db)
    expect(afterInvalid.rows).toEqual(beforeInvalid.rows)

    const strict = await service.updateShift(serviceDb, {
      orgId: 'org-a',
      shiftId: created.id,
      patch: { flexPolicy: { mode: 'strict' } },
    })
    expect(strict).toMatchObject({
      flexPolicy: { mode: 'strict' },
      plannedMinutes: 540,
    })
    const persistedStrict = await sql<{
      flex_mode: string
      flex_required_minutes: number | null
      flex_core_start_time: string | null
    }>`
      SELECT flex_mode, flex_required_minutes, flex_core_start_time
        FROM attendance_shifts
       WHERE id = ${created.id}::uuid AND org_id = 'org-a'
    `.execute(db)
    expect(persistedStrict.rows[0]).toEqual({
      flex_mode: 'strict',
      flex_required_minutes: null,
      flex_core_start_time: null,
    })

    await expect(service.updateShift(serviceDb, {
      orgId: 'org-b',
      shiftId: created.id,
      patch: { name: 'Cross-org rewrite' },
    })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })
})
