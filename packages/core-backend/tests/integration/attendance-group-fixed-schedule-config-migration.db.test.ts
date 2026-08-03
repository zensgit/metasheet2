import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  up,
} from '../../src/db/migrations/zzzz20260803120000_create_attendance_group_fixed_schedule_configs'
import {
  down as membershipMigrationDown,
} from '../../src/db/migrations/zzzz20260723140000_create_attendance_calculation_group_memberships'

const require = createRequire(import.meta.url)
const configServiceLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-config-service.cjs')
const shiftServiceLib = require('../../../../plugins/plugin-attendance/lib/attendance-shift-service.cjs')

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
        CONSTRAINT attendance_groups_id_org_unique UNIQUE (id, org_id)
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
    await sql`CREATE TABLE attendance_shift_segments (org_id text NOT NULL, shift_id uuid NOT NULL)`.execute(db)
    await sql`CREATE TABLE attendance_shift_assignments (org_id text NOT NULL, shift_id uuid NOT NULL)`.execute(db)
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

  it('removes the group-org key when no later foreign key depends on it', async () => {
    await sql`CREATE TABLE attendance_calculation_group_memberships (id uuid PRIMARY KEY)`.execute(db)
    await sql`CREATE TABLE attendance_calculation_group_membership_operations (id uuid PRIMARY KEY)`.execute(db)

    await membershipMigrationDown(db)

    const constraint = await sql<{ constraint_present: boolean }>`
      SELECT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'attendance_groups_id_org_unique'
           AND conrelid = 'attendance_groups'::regclass
      ) AS constraint_present
    `.execute(db)
    expect(constraint.rows[0]?.constraint_present).toBe(false)
  })

  it('keeps the shared group-org key when the earlier membership migration rolls back', async () => {
    const { groupId, shiftId } = await insertParents('org-a')
    await up(db)
    await sql`CREATE TABLE attendance_calculation_group_memberships (id uuid PRIMARY KEY)`.execute(db)
    await sql`CREATE TABLE attendance_calculation_group_membership_operations (id uuid PRIMARY KEY)`.execute(db)

    await membershipMigrationDown(db)

    const constraints = await sql<{ conname: string }>`
      SELECT conname
        FROM pg_constraint
       WHERE conname IN (
         'attendance_groups_id_org_unique',
         'attendance_group_fixed_schedule_configs_group_org_fk'
       )
    `.execute(db)
    expect(constraints.rows.map(row => row.conname)).toEqual(expect.arrayContaining([
      'attendance_groups_id_org_unique',
      'attendance_group_fixed_schedule_configs_group_org_fk',
    ]))
    await insertConfig('org-a', groupId, shiftId)
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
    const statements: string[] = []
    const client = {
      query: async (text: string, values: unknown[]) => {
        statements.push(text)
        return (await pool.query(text, values)).rows
      },
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
    expect(statements.filter(statement => statement.includes('FROM attendance_shifts'))).toHaveLength(3)
    expect(statements.filter(statement => statement.includes('FROM attendance_shifts'))
      .every(statement => statement.includes('FOR SHARE'))).toBe(true)
  })

  it('holds the shift reference lock through config commit so canonical delete returns typed 409', async () => {
    const { groupId, shiftId } = await insertParents('org-a')
    await up(db)
    const configService = configServiceLib.createAttendanceGroupFixedScheduleConfigService({ HttpError: FakeHttpError })
    const shiftService = shiftServiceLib.createAttendanceShiftService({
      HttpError: FakeHttpError,
      randomUUID,
      resolveShiftTiming: () => { throw new Error('not used') },
      normalizeWorkingDays: (value: unknown) => value,
      mapShiftRow: (row: Record<string, unknown>) => row,
      DEFAULT_SHIFT: {},
      DEFAULT_ORG_ID: 'default',
      normalizeLegacyRotationRulesForShiftName: (value: unknown) => value,
    })

    let releaseWriter!: () => void
    const writerCanFinish = new Promise<void>((resolve) => { releaseWriter = resolve })
    let signalWriterLocked!: () => void
    const writerLocked = new Promise<void>((resolve) => { signalWriterLocked = resolve })
    const writerClient = await pool.connect()
    const writer = (async () => {
      await writerClient.query('BEGIN')
      try {
        const result = await configService.upsertConfig({
          query: async (text: string, values: unknown[]) => {
            const response = await writerClient.query(text, values)
            if (text.includes('FROM attendance_shifts')) {
              signalWriterLocked()
              await writerCanFinish
            }
            return response.rows
          },
        }, {
          orgId: 'org-a',
          groupId,
          shiftId,
          startDate: '2026-08-01',
          endDate: '2026-08-31',
          updatedBy: 'admin-1',
        })
        await writerClient.query('COMMIT')
        return result
      } catch (error) {
        await writerClient.query('ROLLBACK')
        throw error
      } finally {
        writerClient.release()
      }
    })()

    await writerLocked
    let signalDeleteLockAttempted!: () => void
    const deleteLockAttempted = new Promise<void>((resolve) => { signalDeleteLockAttempted = resolve })
    const deleteDb = {
      transaction: async (callback: (trx: { query: (text: string, values?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) => {
        const client = await pool.connect()
        await client.query('BEGIN')
        try {
          const result = await callback({
            query: async (text: string, values: unknown[] = []) => {
              if (text.includes('FROM attendance_shifts') && text.includes('FOR UPDATE')) {
                signalDeleteLockAttempted()
              }
              return (await client.query(text, values)).rows
            },
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
    const deletion = shiftService.deleteShift(deleteDb, { orgId: 'org-a', shiftId })
    let deletionSettled = false
    void deletion.then(
      () => { deletionSettled = true },
      () => { deletionSettled = true },
    )
    await deleteLockAttempted
    expect(deletionSettled).toBe(false)
    releaseWriter()

    await expect(writer).resolves.toMatchObject({ revision: 1 })
    await expect(deletion).rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_SHIFT_DELETE_BLOCKED' })
    const configRows = await sql<{ total: string }>`
      SELECT COUNT(*)::text AS total FROM attendance_group_fixed_schedule_configs
       WHERE org_id = 'org-a' AND group_id = ${groupId} AND shift_id = ${shiftId}
    `.execute(db)
    const shiftRows = await sql<{ total: string }>`
      SELECT COUNT(*)::text AS total FROM attendance_shifts WHERE org_id = 'org-a' AND id = ${shiftId}
    `.execute(db)
    expect(configRows.rows[0]!.total).toBe('1')
    expect(shiftRows.rows[0]!.total).toBe('1')
  })
})
