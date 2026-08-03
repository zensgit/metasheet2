import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  up,
} from '../../src/db/migrations/zzzz20260803120000_create_attendance_group_fixed_schedule_configs'

const require = createRequire(import.meta.url)
const configServiceLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-config-service.cjs')

class FakeHttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('attendance group fixed-schedule config migration (real DB)', () => {
  let adminPool: Pool
  let schema: string
  let pool: Pool
  let db: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `fser1_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await sql`
      CREATE TABLE attendance_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL,
        name text NOT NULL,
        UNIQUE (id, org_id)
      )
    `.execute(db)
    await sql`
      CREATE TABLE attendance_shifts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL,
        name text NOT NULL,
        UNIQUE (id, org_id)
      )
    `.execute(db)
  })

  afterEach(async () => {
    await db.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  async function insertParents(orgId: string) {
    const group = await sql<{ id: string }>`
      INSERT INTO attendance_groups (org_id, name) VALUES (${orgId}, 'Group') RETURNING id
    `.execute(db)
    const shift = await sql<{ id: string }>`
      INSERT INTO attendance_shifts (org_id, name) VALUES (${orgId}, 'Shift') RETURNING id
    `.execute(db)
    return { groupId: group.rows[0]!.id, shiftId: shift.rows[0]!.id }
  }

  async function insertConfig(orgId: string, groupId: string, shiftId: string) {
    return sql`
      INSERT INTO attendance_group_fixed_schedule_configs
        (org_id, group_id, shift_id, start_date, end_date, updated_by)
      VALUES (${orgId}, ${groupId}, ${shiftId}, '2026-08-01', '2026-08-31', 'admin-1')
    `.execute(db)
  }

  it('is replay-safe and permits only one desired config per organization and group', async () => {
    const { groupId, shiftId } = await insertParents('org-a')
    await up(db)
    await up(db)
    await insertConfig('org-a', groupId, shiftId)
    await expect(insertConfig('org-a', groupId, shiftId)).rejects.toThrow(/attendance_group_fixed_schedule_configs_org_group_unique/)

    const rows = await sql<{ revision: number }>`
      SELECT revision FROM attendance_group_fixed_schedule_configs
    `.execute(db)
    expect(rows.rows).toEqual([{ revision: 1 }])
  })

  it('enforces composite organization integrity for both group and shift', async () => {
    const orgA = await insertParents('org-a')
    const orgB = await insertParents('org-b')
    await up(db)

    await expect(insertConfig('org-a', orgB.groupId, orgA.shiftId)).rejects.toThrow(/attendance_group_fixed_schedule_configs_group_org_fk/)
    await expect(insertConfig('org-a', orgA.groupId, orgB.shiftId)).rejects.toThrow(/attendance_group_fixed_schedule_configs_shift_org_fk/)
    await insertConfig('org-a', orgA.groupId, orgA.shiftId)
  })

  it('cascades group deletion but restricts deletion of a referenced shift', async () => {
    const { groupId, shiftId } = await insertParents('org-a')
    await up(db)
    await insertConfig('org-a', groupId, shiftId)

    await expect(sql`DELETE FROM attendance_shifts WHERE id = ${shiftId}`.execute(db))
      .rejects.toThrow(/attendance_group_fixed_schedule_configs_shift_org_fk/)
    await sql`DELETE FROM attendance_groups WHERE id = ${groupId}`.execute(db)
    const rows = await sql<{ total: string }>`
      SELECT COUNT(*)::text AS total FROM attendance_group_fixed_schedule_configs
    `.execute(db)
    expect(rows.rows[0]!.total).toBe('0')
  })

  it('keeps identical saves idempotent and increments revision only when desired values change', async () => {
    const { groupId, shiftId } = await insertParents('org-a')
    await up(db)
    const service = configServiceLib.createAttendanceGroupFixedScheduleConfigService({ HttpError: FakeHttpError })
    const client = {
      query: async (text: string, values: unknown[]) => (await pool.query(text, values)).rows,
    }
    const desired = {
      orgId: 'org-a',
      groupId,
      shiftId,
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      updatedBy: 'admin-1',
    }

    const first = await service.upsertConfig(client, desired)
    const replay = await service.upsertConfig(client, { ...desired, updatedBy: 'admin-2' })
    const changed = await service.upsertConfig(client, { ...desired, endDate: '2026-09-30', updatedBy: 'admin-2' })

    expect(first).toMatchObject({ revision: 1, updatedBy: 'admin-1' })
    expect(replay).toMatchObject({ revision: 1, updatedBy: 'admin-1' })
    expect(changed).toMatchObject({ revision: 2, endDate: '2026-09-30', updatedBy: 'admin-2' })
  })
})
