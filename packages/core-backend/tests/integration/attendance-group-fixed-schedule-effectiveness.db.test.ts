import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createAttendanceGroupFixedScheduleEffectivenessService,
} = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs') as {
  createAttendanceGroupFixedScheduleEffectivenessService: (input: Record<string, unknown>) => { getEffectiveness: (db: unknown, input: Record<string, string>) => Promise<any> }
}

class FakeHttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

const databaseUrl = process.env.DATABASE_URL
const describeDb = databaseUrl ? describe : describe.skip
const producerType = 'attendance_group_fixed_schedule'

function producerKey(input: { groupId: string; shiftId: string; startDate: string; endDate: string | null }) {
  return [producerType, input.groupId, input.shiftId, input.startDate, input.endDate ?? 'null'].join(':')
}

describeDb('attendance group fixed-schedule effectiveness (real DB)', () => {
  let adminPool: Pool
  let pool: Pool
  let schema: string
  let orgId: string
  let groupId: string
  let shiftId: string
  let queryLog: string[]
  let canonicalBuilderCalls: Array<{ groupId: string; shiftId: string; startDate: string; endDate: string | null }>
  const now = '2026-08-04T00:00:00.000Z'

  const service = createAttendanceGroupFixedScheduleEffectivenessService({
    HttpError: FakeHttpError,
    buildAttendanceGroupFixedScheduleProducerKey: (input: { groupId: string; shiftId: string; startDate: string; endDate: string | null }) => {
      canonicalBuilderCalls.push(input)
      return producerKey(input)
    },
    now: () => now,
  })

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: databaseUrl })
    schema = `fser2_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
    queryLog = []
    canonicalBuilderCalls = []
    orgId = `org-${randomUUID()}`
    groupId = randomUUID()
    shiftId = randomUUID()
    await pool.query(`
      CREATE TABLE attendance_groups (id uuid PRIMARY KEY, org_id text NOT NULL);
      CREATE TABLE attendance_group_fixed_schedule_configs (
        org_id text NOT NULL, group_id uuid NOT NULL, shift_id uuid NOT NULL,
        start_date date NOT NULL, end_date date NOT NULL, revision integer NOT NULL,
        PRIMARY KEY (org_id, group_id)
      );
      CREATE TABLE attendance_group_members (org_id text NOT NULL, group_id uuid NOT NULL, user_id text NOT NULL);
      CREATE TABLE attendance_shift_assignments (
        id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, shift_id uuid NOT NULL,
        start_date date NOT NULL, end_date date, is_active boolean, publish_status text,
        producer_type text, producer_ref_id uuid, producer_key text, created_at timestamptz NOT NULL DEFAULT now()
      );
    `)
    await pool.query('INSERT INTO attendance_groups (id, org_id) VALUES ($1, $2)', [groupId, orgId])
  })

  afterEach(async () => {
    await pool.end()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  function db() {
    return {
      async query(statement: string, params?: unknown[]) {
        queryLog.push(statement)
        return (await pool.query(statement, params as unknown[])).rows
      },
    }
  }

  async function configure(overrides: Partial<{ shiftId: string; startDate: string; endDate: string; revision: number }> = {}) {
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs (org_id, group_id, shift_id, start_date, end_date, revision)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, groupId, overrides.shiftId ?? shiftId, overrides.startDate ?? '2026-08-01', overrides.endDate ?? '2026-08-31', overrides.revision ?? 1],
    )
  }

  async function members(...userIds: string[]) {
    for (const userId of userIds) {
      await pool.query('INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)', [orgId, groupId, userId])
    }
  }

  async function assignment(overrides: Partial<{ userId: string; shiftId: string; startDate: string; endDate: string | null; producerKey: string; publishStatus: string; active: boolean }> = {}) {
    const startDate = overrides.startDate ?? '2026-08-01'
    const endDate = overrides.endDate ?? '2026-08-31'
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, producer_type, producer_ref_id, producer_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(), orgId, overrides.userId ?? 'member-a', overrides.shiftId ?? shiftId, startDate, endDate,
        overrides.active ?? true, overrides.publishStatus ?? 'published', producerType, groupId,
        overrides.producerKey ?? producerKey({ groupId, shiftId: overrides.shiftId ?? shiftId, startDate, endDate }),
      ],
    )
  }

  async function read() {
    queryLog = []
    const tableNames = [
      'attendance_groups',
      'attendance_group_fixed_schedule_configs',
      'attendance_group_members',
      'attendance_shift_assignments',
    ]
    const countRows = () => Promise.all(tableNames.map(async tableName => {
      const result = await pool.query(`SELECT count(*)::int AS total FROM ${tableName}`)
      return result.rows[0].total
    }))
    const before = await countRows()
    const result = await service.getEffectiveness(db(), { orgId, groupId })
    const after = await countRows()
    expect(after).toEqual(before)
    expect(queryLog).toHaveLength(4)
    expect(queryLog.every(statement => /^\s*SELECT\b/i.test(statement))).toBe(true)
    return result
  }

  it('1: no config is not_configured', async () => {
    await members('member-a')
    expect((await read()).state).toBe('not_configured')
  })

  it('2: historical managed rows without config remain drift, not intent', async () => {
    await assignment()
    const result = await read()
    expect(result).toMatchObject({ state: 'not_configured', reasonCodes: ['NO_DESIRED_CONFIG'], drift: { unconfiguredManagedRows: 1 } })
  })

  it('3: newly saved config is pending_apply', async () => {
    await configure(); await members('member-a')
    expect(await read()).toMatchObject({ state: 'pending_apply', reasonCodes: ['TARGET_MEMBER_MISSING'] })
  })

  it('4: configured group without members is pending_apply', async () => {
    await configure()
    expect(await read()).toMatchObject({ state: 'pending_apply', reasonCodes: ['NO_TARGET_MEMBERS'] })
  })

  it('5: exact complete published coverage is effective', async () => {
    await configure(); await members('member-a', 'member-b'); await assignment(); await assignment({ userId: 'member-b' })
    expect(await read()).toMatchObject({ state: 'effective', reasonCodes: ['EFFECTIVE'], coverage: { matchingMembers: 2 } })
  })

  it('6: an eligible old key is configuration_changed', async () => {
    await configure(); await members('member-a'); await assignment({ shiftId: randomUUID(), startDate: '2026-07-01', endDate: '2026-07-31' })
    expect(await read()).toMatchObject({ state: 'configuration_changed', reasonCodes: ['DIFFERENT_MANAGED_KEY_ACTIVE', 'TARGET_MEMBER_MISSING'] })
  })

  it('7: configuration_changed takes precedence over missing coverage', async () => {
    await configure(); await members('member-a', 'member-b'); await assignment({ shiftId: randomUUID(), startDate: '2026-07-01', endDate: '2026-07-31' })
    expect(await read()).toMatchObject({ state: 'configuration_changed', reasonCodes: ['DIFFERENT_MANAGED_KEY_ACTIVE', 'TARGET_MEMBER_MISSING'] })
  })

  it('8: a missing current member is pending_apply', async () => {
    await configure(); await members('member-a', 'member-b'); await assignment()
    expect(await read()).toMatchObject({ state: 'pending_apply', reasonCodes: ['TARGET_MEMBER_MISSING'] })
  })

  it('9: a desired-key row for a former member is pending_apply', async () => {
    await configure(); await members('member-a'); await assignment(); await assignment({ userId: 'former-member' })
    expect(await read()).toMatchObject({ state: 'pending_apply', reasonCodes: ['NON_MEMBER_TARGET_ACTIVE'] })
  })

  it('10: duplicate matching assignments are never effective', async () => {
    await configure(); await members('member-a'); await assignment(); await assignment()
    expect(await read()).toMatchObject({ state: 'pending_apply', reasonCodes: ['DUPLICATE_MATCHING_ASSIGNMENT'] })
  })

  it('11: a matching key with corrupt assignment values is pending_apply', async () => {
    await configure(); await members('member-a'); await assignment({ shiftId: randomUUID(), producerKey: producerKey({ groupId, shiftId, startDate: '2026-08-01', endDate: '2026-08-31' }) })
    expect(await read()).toMatchObject({ state: 'pending_apply', reasonCodes: ['TARGET_MEMBER_MISSING', 'ASSIGNMENT_VALUE_MISMATCH'] })
  })

  it('12: unpublished managed rows are reported but do not cover members', async () => {
    await configure(); await members('member-a'); await assignment({ publishStatus: 'pending' })
    expect(await read()).toMatchObject({ state: 'pending_apply', reasonCodes: ['TARGET_MEMBER_MISSING', 'UNPUBLISHED_MANAGED_ROW'], drift: { unpublishedManagedRows: 1 } })
  })

  it('13: inactive rows are ignored', async () => {
    await configure(); await members('member-a'); await assignment({ active: false })
    expect(await read()).toMatchObject({ state: 'pending_apply', reasonCodes: ['TARGET_MEMBER_MISSING'], drift: { unpublishedManagedRows: 0 } })
  })

  it('14: managed-set metadata is values-only and deterministic', async () => {
    await configure(); await members('member-a'); await assignment({ shiftId: randomUUID(), startDate: '2026-07-01', endDate: '2026-07-31' })
    const result = await read()
    expect(result.drift.managedSets).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('member-a')
  })

  it('15: a foreign-org row targeting this group cannot affect this group', async () => {
    await configure(); await members('member-a'); await assignment()
    const foreignShiftId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, producer_type, producer_ref_id, producer_key)
       VALUES ($1, 'foreign-org', 'foreign-member', $2, '2026-07-01', '2026-07-31', true, 'published', $3, $4, $5)`,
      [randomUUID(), foreignShiftId, producerType, groupId, producerKey({ groupId, shiftId: foreignShiftId, startDate: '2026-07-01', endDate: '2026-07-31' })],
    )
    const result = await read()
    expect(result).toMatchObject({ state: 'effective', reasonCodes: ['EFFECTIVE'] })
    expect(JSON.stringify(result)).not.toContain('foreign-member')
    // Mutation proof: remove `org_id = $1` from the managed-row query and this row
    // becomes an eligible different key, changing the result to configuration_changed.
  })

  it('16: a foreign-org membership for the same group cannot affect target coverage', async () => {
    await configure(); await members('member-a'); await assignment()
    await pool.query(
      'INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)',
      ['foreign-org', groupId, 'foreign-member'],
    )
    const result = await read()
    expect(result).toMatchObject({
      state: 'effective',
      reasonCodes: ['EFFECTIVE'],
      coverage: { targetMembers: 1, matchingMembers: 1, missingMembers: 0 },
    })
    expect(JSON.stringify(result)).not.toContain('foreign-member')
    // Mutation proof: remove `org_id = $1` from the membership query and the
    // foreign member becomes a missing target, changing the state to pending_apply.
  })

  it('17: the canonical producer-key builder receives the desired values', async () => {
    await configure(); await members('member-a'); await assignment()
    expect(await read()).toMatchObject({ desired: { shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 1 }, evaluatedAt: now })
    expect(canonicalBuilderCalls).toEqual([{ groupId, shiftId, startDate: '2026-08-01', endDate: '2026-08-31' }])
  })

  it('18: group ownership is org-scoped before dependent reads', async () => {
    await expect(service.getEffectiveness(db(), { orgId: 'foreign-org', groupId })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(queryLog).toHaveLength(1)
  })
})
