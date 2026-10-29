/**
 * Native query-scope proof for legacy-plan preconditions. Direct precondition
 * fixtures do not attest full worker admission, HTTP authorization or MUT06's
 * full parent denominator. Every query result comes from PostgreSQL unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import { Pool, type PoolClient } from 'pg'
import {
  computeLegacyImportGroupStateFingerprintV1,
  computeLegacyImportRecordPreconditionFingerprintV1,
  LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
  type LegacyImportGroupEffectPlanV1,
  type LegacyImportRecordWritePlanV1,
} from '../../src/attendance/w4c3a-legacy-execution-plan'
import {
  lockAndRecheckAttendanceLegacyGroupPreconditionsV1,
  lockAndRecheckAttendanceLegacyRecordPreconditionsV1,
} from '../../src/attendance/w4c3a-legacy-plan-preconditions'
import { AttendanceLegacyGroupEffectError } from '../../src/attendance/w4c3a-legacy-plan-group-effects'
import type { VerifiedAttendanceLegacyPlanV1 } from '../../src/attendance/w4c3a-legacy-plan-worker'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
if (!dbUrl) throw new Error('MUT06_W3 requires PostgreSQL; it must not skip without DB')
const workDate = '2026-05-06'
const runMigrationCli = promisify(execFile)
type NativeGroup = { id: string; org_id: string; name: string; code: string | null; timezone: string; rule_set_id: string | null }
type Trace = { sql: string; rows: Array<Record<string, unknown>>; sourceCallLine: number | null }
type Fixture = { client: PoolClient; orgId: string; foreignOrgId: string; userId: string; own: NativeGroup; foreign: NativeGroup }

function groupState(group: NativeGroup) {
  return { id: group.id, orgId: group.org_id, name: group.name, code: group.code, timezone: group.timezone, ruleSetId: group.rule_set_id }
}
function groupEffect(group: NativeGroup, existed = true): LegacyImportGroupEffectPlanV1 {
  return { kind: 'ensure_group', groupId: group.id, normalizedName: group.name.toLowerCase(), displayName: group.name, code: group.code, timezone: group.timezone, ruleSetId: group.rule_set_id, groupExistedAtPrepare: existed }
}
function memberEffect(f: Fixture, groupId: string, existed: boolean): LegacyImportGroupEffectPlanV1 {
  return { kind: 'ensure_member', memberId: randomUUID(), groupRef: groupId, userId: f.userId, membershipExistedAtPrepare: existed, sourceOrdinals: [0] }
}
async function groupPlan(f: Fixture, effects: LegacyImportGroupEffectPlanV1[], groups: NativeGroup[]) {
  const revision = await f.client.query<{ revision: string }>('SELECT revision::text FROM attendance_group_effect_revisions WHERE org_id = $1', [f.orgId])
  expect(revision.rows).toHaveLength(1)
  const memberships = effects.flatMap(effect => effect.kind === 'ensure_member'
    ? [{ orgId: f.orgId, groupId: effect.groupRef, userId: effect.userId, exists: effect.membershipExistedAtPrepare }]
    : [])
  // Only the precondition boundary's frozen inputs are populated, as in the
  // existing record/group native tests. No verified-worker/publication claim.
  return {
    manifest: { orgId: f.orgId, groupRevision: Number(revision.rows[0].revision), groupStateFingerprint: computeLegacyImportGroupStateFingerprintV1({ groups: groups.map(groupState), memberships }) },
    chunks: [], items: [], recordWrites: [], groupEffects: effects,
  } as unknown as VerifiedAttendanceLegacyPlanV1
}
function recordWrite(f: Fixture, recordId: string, revision: number, fingerprint: string): LegacyImportRecordWritePlanV1 {
  return {
    recordWriteId: randomUUID(), orgId: f.orgId, userId: f.userId, workDate, sourceOrdinals: [0], mergeMode: 'merge',
    firstInAt: null, lastOutAt: null, workMinutes: null, lateMinutes: null, earlyLeaveMinutes: null, status: null, isWorkday: null,
    timezone: 'UTC', targetRevision: revision, existingRecordPreconditionFingerprint: fingerprint, expectedSourceOwnership: null,
    recordId, compatibilityMetadata: {}, policySnapshot: {}, profileSnapshot: {}, multiPunchSnapshot: {}, attributionSnapshot: {}, sourceBatchId: randomUUID(), resultSlots: {},
  }
}
function recordPlan(f: Fixture, write: LegacyImportRecordWritePlanV1): VerifiedAttendanceLegacyPlanV1 {
  return { manifest: { orgId: f.orgId }, chunks: [], items: [], recordWrites: [write], groupEffects: [] } as unknown as VerifiedAttendanceLegacyPlanV1
}
async function insertRecord(f: Fixture, orgId: string) {
  const id = randomUUID()
  await f.client.query(
    `INSERT INTO attendance_records
     (id, org_id, user_id, work_date, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta)
     VALUES ($1, $2, $3, $4, '2026-05-06T01:00:00Z', '2026-05-06T09:00:00Z', 480, 0, 0, 'normal', true, '{"kind":"mut06-w3"}'::jsonb)`,
    [id, orgId, f.userId, workDate],
  )
  return id
}
async function insertMember(f: Fixture, orgId: string, groupId: string) {
  await f.client.query('INSERT INTO attendance_group_members (id, org_id, group_id, user_id) VALUES ($1, $2, $3, $4)', [randomUUID(), orgId, groupId, f.userId])
}
async function snapshot(f: Fixture) {
  const rows: Record<string, unknown> = {}
  for (const table of ['attendance_records', 'attendance_record_target_revisions', 'attendance_groups', 'attendance_group_members', 'attendance_group_effect_revisions', 'user_orgs']) {
    rows[table] = (await f.client.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id = ANY($1::text[]) ORDER BY to_jsonb(t)::text`, [[f.orgId, f.foreignOrgId]])).rows
  }
  rows.users = (await f.client.query('SELECT to_jsonb(u) AS row FROM users u WHERE id = $1', [f.userId])).rows
  return rows
}
async function verify(f: Fixture, marker: string, kind: 'record' | 'group', plan: VerifiedAttendanceLegacyPlanV1, expected: unknown) {
  await f.client.query('SET CONSTRAINTS ALL IMMEDIATE')
  const before = await snapshot(f), trace: Trace[] = []
  const observed: AttendanceW4TransactionClientV1 = {
    async query(sql, values = []) {
      const source = new Error().stack?.match(/w4c3a-legacy-plan-preconditions\.ts:(\d+):\d+/)
      const result = await f.client.query(sql, [...values])
      trace.push({ sql, rows: result.rows.map(row => ({ ...row })), sourceCallLine: source ? Number(source[1]) : null })
      return result
    },
  }
  let outcome: unknown
  try {
    outcome = { value: await (kind === 'record' ? lockAndRecheckAttendanceLegacyRecordPreconditionsV1(observed, plan) : lockAndRecheckAttendanceLegacyGroupPreconditionsV1(observed, plan)) }
  } catch (error) {
    if (!(error instanceof AttendanceLegacyGroupEffectError)) throw error
    outcome = { code: error.code, status: error.status, details: error.details }
  }
  console.info('MUT06_W3_NATIVE_RECEIPT', JSON.stringify({ case: marker, carriers: trace.map(t => ({ sqlSHA256: createHash('sha256').update(t.sql).digest('hex'), rowCount: t.rows.length, sourceCallLine: t.sourceCallLine })) }))
  expect(await snapshot(f), `${marker}_READONLY`).toEqual(before)
  expect(outcome, marker).toEqual(expected)
  return trace
}

describe('MUT06 W3 native precondition organization scope', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeAll(async () => {
    const cwd = path.resolve(__dirname, '../..')
    const migrationEnv = { ...process.env, DATABASE_URL: dbUrl }
    const args = ['--import', 'tsx', 'src/db/migrate.ts']
    // Use the production CLI's TypeScript loader. Already-applied migrations
    // are only listed; the official runner applies genuinely pending entries.
    const { stdout: output } = await runMigrationCli(process.execPath, [...args, '--list'], { cwd, env: migrationEnv, encoding: 'utf8', timeout: 120000 })
    const pending = output.match(/^Pending:\s+(\d+)/m)
    if (!pending) throw new Error('MUT06_W3_SCHEMA_PENDING_COUNT_MISSING')
    if (Number(pending[1]) > 0) await runMigrationCli(process.execPath, [...args, '--latest'], { cwd, env: migrationEnv, timeout: 120000 })
    console.info('MUT06_W3_SCHEMA', JSON.stringify({ productionMigrationsPendingBefore: Number(pending[1]) }))
    const constraints = await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'attendance_group_members'::regclass AND contype = 'f'`)
    expect(constraints.rows.some(row => /FOREIGN KEY \(group_id\).*REFERENCES attendance_groups\(id\)/.test(row.definition)), 'MUT06_W3_REAL_GROUP_FK').toBe(true)
  }, 180000)
  afterAll(async () => { await pool.end() }, 60000)

  async function fixture(_marker: string, action: (f: Fixture) => Promise<void>) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const orgId = randomUUID(), foreignOrgId = randomUUID(), userId = randomUUID()
      await client.query(`INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin) VALUES ($1, $2, $1, 'MUT06 W3 fixture', 'x', 'user', '[]'::jsonb, true, false)`, [userId, `${userId}@mut06-w3.test`])
      for (const org of [orgId, foreignOrgId]) await client.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, org])
      const groups: NativeGroup[] = []
      for (const org of [orgId, foreignOrgId]) {
        const id = randomUUID()
        const result = await client.query<NativeGroup>(`INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1, $2, $3, 'UTC') RETURNING id::text AS id, org_id, name, code, timezone, rule_set_id::text AS rule_set_id`, [id, org, `MUT06 ${id}`])
        groups.push(result.rows[0])
      }
      await action({ client, orgId, foreignOrgId, userId, own: groups[0], foreign: groups[1] })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  it('MUT06_W3_RECORD_EXISTING: own record and revision survive legal foreign target decoys', async () => {
    await fixture('MUT06_W3_RECORD_EXISTING', async f => {
      const id = await insertRecord(f, f.orgId)
      await insertRecord(f, f.foreignOrgId)
      const record = (await f.client.query<{ first_in_at: Date; last_out_at: Date }>('SELECT first_in_at, last_out_at FROM attendance_records WHERE id = $1', [id])).rows[0]
      const revision = (await f.client.query<{ revision: string }>('SELECT revision::text FROM attendance_record_target_revisions WHERE org_id = $1 AND user_id = $2 AND work_date = $3', [f.orgId, f.userId, workDate])).rows[0]
      const fingerprint = computeLegacyImportRecordPreconditionFingerprintV1({ exists: true, id, orgId: f.orgId, userId: f.userId, workDate, firstInAt: record.first_in_at.toISOString(), lastOutAt: record.last_out_at.toISOString(), workMinutes: 480, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'normal', isWorkday: true, meta: { kind: 'mut06-w3' }, sourceBatchId: null })
      const trace = await verify(f, 'MUT06_W3_RECORD_EXISTING', 'record', recordPlan(f, recordWrite(f, id, Number(revision.revision), fingerprint)), { value: true })
      expect(trace.map(t => t.rows.length)).toEqual([1, 1])
    })
  })
  it('MUT06_W3_RECORD_MISSING: foreign record does not occupy the missing own target', async () => {
    await fixture('MUT06_W3_RECORD_MISSING', async f => {
      await insertRecord(f, f.foreignOrgId)
      await f.client.query('INSERT INTO attendance_record_target_revisions (org_id, user_id, work_date, revision) VALUES ($1, $2, $3, 0)', [f.orgId, f.userId, workDate])
      const trace = await verify(f, 'MUT06_W3_RECORD_MISSING', 'record', recordPlan(f, recordWrite(f, randomUUID(), 0, LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1)), { value: true })
      expect(trace.map(t => t.rows.length)).toEqual([1, 0])
    })
  })
  it('MUT06_W3_GROUP_EXISTING: own member, revision and liveness exclude foreign peers', async () => {
    await fixture('MUT06_W3_GROUP_EXISTING', async f => {
      await insertMember(f, f.orgId, f.own.id)
      // Deliberately inconsistent org/group association, legal under the real
      // single-column FK; never claim an authorized public writer can create it.
      await insertMember(f, f.foreignOrgId, f.own.id)
      const peers = await f.client.query('SELECT org_id FROM attendance_group_members WHERE group_id = $1 AND user_id = $2 ORDER BY org_id', [f.own.id, f.userId])
      expect(peers.rows).toHaveLength(2)
      const plan = await groupPlan(f, [groupEffect(f.own), memberEffect(f, f.own.id, true)], [f.own])
      await verify(f, 'MUT06_W3_GROUP_EXISTING', 'group', plan, { value: true })
    })
  })
  it('MUT06_W3_GROUP_NAME_ABSENT: a foreign normalized name does not occupy the own name', async () => {
    await fixture('MUT06_W3_GROUP_NAME_ABSENT', async f => {
      const proposed = { ...f.foreign, id: randomUUID(), org_id: f.orgId }
      await verify(f, 'MUT06_W3_GROUP_NAME_ABSENT', 'group', await groupPlan(f, [groupEffect(proposed, false)], []), { value: true })
    })
  })
  it('MUT06_W3_GROUP_MEMBER_ABSENT: a foreign membership does not occupy the own pair', async () => {
    await fixture('MUT06_W3_GROUP_MEMBER_ABSENT', async f => {
      await insertMember(f, f.foreignOrgId, f.own.id)
      const trace = await verify(f, 'MUT06_W3_GROUP_MEMBER_ABSENT', 'group', await groupPlan(f, [memberEffect(f, f.own.id, false)], [f.own]), { value: true })
      expect(trace.some(t => /FROM attendance_group_members/.test(t.sql) && t.rows.length === 0)).toBe(true)
    })
  })
  it('MUT06_W3_MEMBER_REVOKED: current own membership refusal cannot borrow foreign liveness', async () => {
    await fixture('MUT06_W3_MEMBER_REVOKED', async f => {
      const plan = await groupPlan(f, [memberEffect(f, f.own.id, false)], [f.own])
      await f.client.query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [f.userId, f.orgId])
      await verify(f, 'MUT06_W3_MEMBER_REVOKED', 'group', plan, { code: 'W4C3A_MEMBER_NOT_ACTIVE_IN_ORG', status: 404, details: [{ code: 'USER_NOT_IN_ORG', rejectedCount: 1, indexes: [0] }] })
    })
  })
  it('MUT06_W3_FOREIGN_GROUP_LOCK: a foreign global ID is refused at its first locked row', async () => {
    await fixture('MUT06_W3_FOREIGN_GROUP_LOCK', async f => {
      const trace = await verify(f, 'MUT06_W3_FOREIGN_GROUP_LOCK', 'group', await groupPlan(f, [groupEffect(f.foreign)], [f.foreign]), { value: false })
      expect(trace, 'MUT06_W3_FOREIGN_GROUP_LOCK_EARLY_REFUSAL').toHaveLength(1)
      expect(trace[0].rows).toEqual([{ id: f.foreign.id, org_id: f.foreignOrgId }])
    })
  })
  it('MUT06_W3_FOREIGN_GROUP_READ: membership-only foreign group ID is refused after native read', async () => {
    await fixture('MUT06_W3_FOREIGN_GROUP_READ', async f => {
      const trace = await verify(f, 'MUT06_W3_FOREIGN_GROUP_READ', 'group', await groupPlan(f, [memberEffect(f, f.foreign.id, false)], [f.foreign]), { value: false })
      const group = trace.find(t => /SELECT id::text AS id, org_id, name/.test(t.sql))
      expect(group?.rows.map(row => row.org_id)).toEqual([f.foreignOrgId])
    })
  })
  it('MUT06_W3_FOREIGN_GROUP_ID_OCCUPIED: a new own group cannot reuse an existing foreign UUID', async () => {
    await fixture('MUT06_W3_FOREIGN_GROUP_ID_OCCUPIED', async f => {
      const proposed = { ...f.foreign, name: `New ${randomUUID()}`, org_id: f.orgId }
      await verify(f, 'MUT06_W3_FOREIGN_GROUP_ID_OCCUPIED', 'group', await groupPlan(f, [groupEffect(proposed, false)], []), { value: false })
    })
  })
})
