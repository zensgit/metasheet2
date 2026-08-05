import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createAttendanceGroupFixedScheduleEffectivenessService,
} = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs') as {
  createAttendanceGroupFixedScheduleEffectivenessService: (input: Record<string, unknown>) => {
    getEffectiveness: (db: unknown, input: Record<string, string>) => Promise<any>
    getSelfEffectiveness: (db: unknown, input: Record<string, string>) => Promise<any>
  }
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

// #4709 FSER-4 prerequisite (contract amendment `docs/development/
// attendance-4709-fser4-member-projection-contract-amendment-20260804.md` §2,
// RATIFIED `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): real-DB
// authorization matrix + parity + exact-key proof for `getSelfEffectiveness`.
// File-level fixture namespace (`fser4pre_<uuid>` schema) so this can run
// concurrently with every other attendance real-DB suite sharing the test
// database, per this line's shared-DB fixture-collision discipline.
describeDb('attendance group fixed-schedule self effectiveness (real DB, #4709 FSER-4 prerequisite)', () => {
  let adminPool: Pool
  let pool: Pool
  let schema: string
  let orgId: string
  let otherOrgId: string
  let groupId: string
  let shiftId: string
  let queryLog: string[]
  const now = '2026-08-05T00:00:00.000Z'

  const service = createAttendanceGroupFixedScheduleEffectivenessService({
    HttpError: FakeHttpError,
    buildAttendanceGroupFixedScheduleProducerKey: (input: { groupId: string; shiftId: string; startDate: string; endDate: string | null }) =>
      producerKey(input),
    now: () => now,
  })

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: databaseUrl })
    schema = `fser4pre_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
    queryLog = []
    orgId = `org-${randomUUID()}`
    otherOrgId = `other-org-${randomUUID()}`
    groupId = randomUUID()
    shiftId = randomUUID()
    await pool.query(`
      CREATE TABLE users (
        id text PRIMARY KEY,
        is_active boolean NOT NULL DEFAULT true,
        activation_status text NOT NULL DEFAULT 'activated'
      );
      CREATE TABLE user_orgs (
        user_id text NOT NULL, org_id text NOT NULL, is_active boolean NOT NULL DEFAULT true,
        PRIMARY KEY (user_id, org_id)
      );
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

  async function user(userId: string, overrides: Partial<{ isActive: boolean; activationStatus: string }> = {}) {
    await pool.query('INSERT INTO users (id, is_active, activation_status) VALUES ($1, $2, $3)', [
      userId,
      overrides.isActive ?? true,
      overrides.activationStatus ?? 'activated',
    ])
  }

  async function orgMembership(userId: string, org: string, overrides: Partial<{ isActive: boolean }> = {}) {
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)', [
      userId,
      org,
      overrides.isActive ?? true,
    ])
  }

  async function groupMembership(userId: string, org: string, group: string) {
    await pool.query('INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)', [org, group, userId])
  }

  /** A fully live, activated, org-member, group-member subject — the positive-control baseline every negative leg mutates exactly one predicate away from. */
  async function liveMember(userId: string, overrides: { isActive?: boolean; activationStatus?: string; orgActive?: boolean; skipOrgMembership?: boolean; skipGroupMembership?: boolean } = {}) {
    await user(userId, { isActive: overrides.isActive, activationStatus: overrides.activationStatus })
    if (!overrides.skipOrgMembership) await orgMembership(userId, orgId, { isActive: overrides.orgActive })
    if (!overrides.skipGroupMembership) await groupMembership(userId, orgId, groupId)
  }

  async function configure(overrides: Partial<{ shiftId: string; startDate: string; endDate: string; revision: number }> = {}) {
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs (org_id, group_id, shift_id, start_date, end_date, revision)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, groupId, overrides.shiftId ?? shiftId, overrides.startDate ?? '2026-08-01', overrides.endDate ?? '2026-08-31', overrides.revision ?? 1],
    )
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

  const tableNames = ['users', 'user_orgs', 'attendance_groups', 'attendance_group_fixed_schedule_configs', 'attendance_group_members', 'attendance_shift_assignments']
  async function countRows() {
    return Promise.all(tableNames.map(async tableName => {
      const result = await pool.query(`SELECT count(*)::int AS total FROM ${tableName}`)
      return result.rows[0].total
    }))
  }

  async function readSelf(userId: string, forOrg: string = orgId, forGroup: string = groupId) {
    queryLog = []
    const before = await countRows()
    const result = await service.getSelfEffectiveness(db(), { orgId: forOrg, groupId: forGroup, userId })
    const after = await countRows()
    expect(after).toEqual(before)
    expect(queryLog.every(statement => /^\s*SELECT\b/i.test(statement))).toBe(true)
    return result
  }

  // ---------------------------------------------------------------------
  // Authorization matrix — every negative leg fails BEFORE any config/member/
  // assignment SQL (queryLog length 1, the proof query only) and returns the
  // SAME values-free 404 shape (contract §2, gate #4).
  // ---------------------------------------------------------------------

  it('AUTHZ-1: missing group (no membership row at all) is 404, one query', async () => {
    await liveMember('member-a')
    queryLog = []
    await expect(service.getSelfEffectiveness(db(), { orgId, groupId: randomUUID(), userId: 'member-a' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(queryLog).toHaveLength(1)
  })

  it('AUTHZ-2: non-member subject (live user, active org membership, no group membership) is the same 404, one query', async () => {
    await liveMember('member-a', { skipGroupMembership: true })
    queryLog = []
    await expect(service.getSelfEffectiveness(db(), { orgId, groupId, userId: 'member-a' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(queryLog).toHaveLength(1)
  })

  it('AUTHZ-3: inactive subject (users.is_active=false) is the same 404, one query', async () => {
    await liveMember('member-a', { isActive: false })
    queryLog = []
    await expect(service.getSelfEffectiveness(db(), { orgId, groupId, userId: 'member-a' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(queryLog).toHaveLength(1)
  })

  it('AUTHZ-4: non-activated subject (activation_status=pending_activation) is the same 404, one query', async () => {
    await liveMember('member-a', { activationStatus: 'pending_activation' })
    queryLog = []
    await expect(service.getSelfEffectiveness(db(), { orgId, groupId, userId: 'member-a' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(queryLog).toHaveLength(1)
  })

  it('AUTHZ-5: missing user_orgs row entirely is the same 404, one query', async () => {
    await liveMember('member-a', { skipOrgMembership: true })
    queryLog = []
    await expect(service.getSelfEffectiveness(db(), { orgId, groupId, userId: 'member-a' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(queryLog).toHaveLength(1)
  })

  it('AUTHZ-6: inactive user_orgs row (org membership deactivated) is the same 404, one query', async () => {
    await liveMember('member-a', { orgActive: false })
    queryLog = []
    await expect(service.getSelfEffectiveness(db(), { orgId, groupId, userId: 'member-a' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(queryLog).toHaveLength(1)
  })

  it('AUTHZ-7 (forged witness / cross-org): a subject live in orgId cannot read this group under a forged otherOrgId, before SQL, same 404 shape', async () => {
    await liveMember('member-a')
    queryLog = []
    await expect(service.getSelfEffectiveness(db(), { orgId: otherOrgId, groupId, userId: 'member-a' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(queryLog).toHaveLength(1)
  })

  it('AUTHZ-8 (cross-org isolation, positive control): a live member of a DIFFERENT org\'s own group reads only that org\'s (unconfigured) state, never orgId\'s config', async () => {
    const foreignGroupId = randomUUID()
    await pool.query('INSERT INTO attendance_groups (id, org_id) VALUES ($1, $2)', [foreignGroupId, otherOrgId])
    await user('member-x')
    await orgMembership('member-x', otherOrgId)
    await groupMembership('member-x', otherOrgId, foreignGroupId)
    await configure() // desired config lives under orgId/groupId only — otherOrgId's group has none
    queryLog = []
    await expect(service.getSelfEffectiveness(db(), { orgId: otherOrgId, groupId: foreignGroupId, userId: 'member-x' }))
      .resolves.toMatchObject({ applicability: 'not_configured', desired: null })
    // Positive control: the same otherOrgId member never sees orgId's config — proves isolation
    // is genuine (not merely "always 404s"), matching this line's positive-control discipline.
    // And the forged-org attempt against orgId's actual groupId (AUTHZ-7) still 404s for this
    // same subject identity shape, confirming the isolation is symmetric.
  })

  it('AUTHZ-9 mutation-style: an active member missing ONLY the group-membership row still 404s (isolates the group-membership predicate)', async () => {
    await user('member-a')
    await orgMembership('member-a', orgId)
    // deliberately no groupMembership call
    queryLog = []
    await expect(service.getSelfEffectiveness(db(), { orgId, groupId, userId: 'member-a' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(queryLog).toHaveLength(1)
  })

  it('AUTHZ-10: the 404 message never discloses which predicate failed (values-free, byte-identical across all failure reasons)', async () => {
    await liveMember('m1', { isActive: false })
    await liveMember('m2', { activationStatus: 'pending_activation' })
    await liveMember('m3', { orgActive: false })
    await liveMember('m4', { skipGroupMembership: true })
    const messages = new Set<string>()
    for (const userId of ['m1', 'm2', 'm3', 'm4', randomUUID()]) {
      try {
        await service.getSelfEffectiveness(db(), { orgId, groupId, userId })
        throw new Error('expected rejection')
      } catch (error: any) {
        messages.add(`${error.status}:${error.code}:${error.message}`)
      }
    }
    expect(messages.size).toBe(1)
  })

  // ---------------------------------------------------------------------
  // Positive matrix + applicability + parity + exact-key projection
  // ---------------------------------------------------------------------

  it('POS-1: two members in the same org/group — each subject sees only their own applicability, never the other\'s', async () => {
    await liveMember('member-a')
    await liveMember('member-b')
    await configure()
    await assignment({ userId: 'member-a' }) // member-a: matching
    // member-b has no assignment: non_matching

    const selfA = await readSelf('member-a')
    const selfB = await readSelf('member-b')

    expect(selfA).toMatchObject({ applicability: 'matching', state: 'pending_apply' })
    expect(selfB).toMatchObject({ applicability: 'non_matching', state: 'pending_apply' })
    expect(JSON.stringify(selfA)).not.toContain('member-b')
    expect(JSON.stringify(selfB)).not.toContain('member-a')
  })

  it('POS-2: not_configured applicability when no desired config exists', async () => {
    await liveMember('member-a')
    const self = await readSelf('member-a')
    expect(self).toMatchObject({ applicability: 'not_configured', state: 'not_configured', desired: null })
  })

  it('POS-3: matching applicability when the group state is fully effective', async () => {
    await liveMember('member-a')
    await configure()
    await assignment({ userId: 'member-a' })
    const self = await readSelf('member-a')
    expect(self).toMatchObject({ applicability: 'matching', state: 'effective', reasonCodes: ['EFFECTIVE'] })
  })

  it('POS-4: non_matching when the subject only has a stale different-key row (group state configuration_changed)', async () => {
    await liveMember('member-a')
    await configure()
    await assignment({ shiftId: randomUUID(), startDate: '2026-07-01', endDate: '2026-07-31' })
    const self = await readSelf('member-a')
    expect(self).toMatchObject({ applicability: 'non_matching', state: 'configuration_changed' })
  })

  it('PARITY: admin getEffectiveness and self getSelfEffectiveness return byte-identical state/reasonCodes/desired/evaluatedAt over the same fixture', async () => {
    await liveMember('member-a')
    await liveMember('member-b')
    await configure()
    await assignment({ userId: 'member-a' })

    const admin = await service.getEffectiveness(db(), { orgId, groupId })
    const self = await service.getSelfEffectiveness(db(), { orgId, groupId, userId: 'member-a' })

    expect(self.state).toBe(admin.state)
    expect(self.reasonCodes).toEqual(admin.reasonCodes)
    expect(self.desired).toEqual(admin.desired)
    expect(self.evaluatedAt).toBe(admin.evaluatedAt)
    expect(self.evaluatedAt).toBe(now)
  })

  it('EXACT-KEY: the self response has exactly the contract-declared keys, no coverage/drift/managedSets/producerKey/raw user ids at any depth', async () => {
    await liveMember('member-a')
    await liveMember('unrelated-member')
    await configure()
    await assignment({ userId: 'member-a' })
    await assignment({ userId: 'unrelated-member', shiftId: randomUUID(), startDate: '2026-07-01', endDate: '2026-07-31' })

    const self = await readSelf('member-a')
    expect(Object.keys(self).sort()).toEqual(['applicability', 'desired', 'evaluatedAt', 'groupId', 'reasonCodes', 'state'].sort())

    const serialized = JSON.stringify(self)
    expect(serialized).not.toContain('coverage')
    expect(serialized).not.toContain('drift')
    expect(serialized).not.toContain('managedSets')
    expect(serialized).not.toContain('producerKey')
    expect(serialized).not.toContain('unrelated-member')
    expect(serialized).not.toContain('member-a')
  })

  it('the canonical producer-key builder inputs match the admin path (desired shift/window)', async () => {
    await liveMember('member-a')
    await configure({ shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 3 })
    await assignment({ userId: 'member-a' })
    const self = await readSelf('member-a')
    expect(self.desired).toEqual({ shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 3 })
  })
})
