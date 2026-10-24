import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up, down } from '../../src/db/migrations/zzzz20261023120000_attendance_group_membership_policy'

const require = createRequire(import.meta.url)
const policy = require('../../../../plugins/plugin-attendance/lib/attendance-group-membership-policy.cjs')
const { authorizeAttendanceTimezoneManage: authorizeManage } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-manage-authority.cjs')
const url = process.env.ATTENDANCE_TEST_DATABASE_URL
if (!url) throw new Error('ATTENDANCE_MEMBERSHIP_POLICY_REAL_DATABASE_REQUIRED')
const scratchName = 'ms2_membership_policy_' + randomUUID().replaceAll('-', '')
let admin: Pool
let pool: Pool
let db: Kysely<unknown>
const userId = 'synthetic-user'
const groupA = 'aaaaaaaa-0000-4000-8000-000000000001'
const groupB = 'bbbbbbbb-0000-4000-8000-000000000002'
const groupC = 'cccccccc-0000-4000-8000-000000000003'
const members = (groupId: string) => [{ groupId, userId }]
async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await work(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
async function add(client: PoolClient, orgId: string, groupId: string) {
  await policy.assertCanAddMembers(client, orgId, members(groupId))
  await client.query('INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [orgId, groupId, userId])
}
async function count(orgId: string) {
  return (await pool.query('SELECT count(*)::int AS count FROM attendance_group_members WHERE org_id=$1', [orgId])).rows[0].count
}
async function waiting(client: PoolClient) {
  // Verify actual PostgreSQL blocking before releasing the winning transaction.
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  return async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]
      if (row?.wait_event_type === 'Lock') return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('EXPECTED_DATABASE_LOCK_NOT_OBSERVED')
  }
}

beforeAll(async () => {
  const adminUrl = new URL(url!)
  adminUrl.pathname = '/postgres'
  admin = new Pool({ connectionString: adminUrl.toString() })
  await admin.query('CREATE DATABASE ' + scratchName)
  const scratchUrl = new URL(url!)
  scratchUrl.pathname = '/' + scratchName
  pool = new Pool({ connectionString: scratchUrl.toString(), max: 5 })
  db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await up(db)
  await pool.query(`
    CREATE TABLE users(id text PRIMARY KEY, is_active boolean NOT NULL);
    CREATE TABLE user_orgs(user_id text, org_id text, is_active boolean NOT NULL);
    CREATE TABLE user_roles(user_id text, role_id text);
    CREATE TABLE user_permissions(user_id text, permission_code text);
    CREATE TABLE role_permissions(role_id text, permission_code text);
  `)
  await pool.query('CREATE TABLE attendance_group_members (org_id text NOT NULL, group_id uuid NOT NULL, user_id text NOT NULL, PRIMARY KEY(org_id,group_id,user_id))')
}, 60_000)
afterAll(async () => {
  await db?.destroy()
  if (admin) {
    await admin.query('DROP DATABASE IF EXISTS ' + scratchName)
    await admin.end()
  }
})

describe('management-group admission under real concurrent transactions', () => {
  it('migrates idempotently and rolls back only the policy table', async () => {
    await up(db)
    await down(db)
    expect((await pool.query("SELECT to_regclass('attendance_group_members') IS NOT NULL AS present")).rows).toEqual([{ present: true }])
    await up(db)
  })

  it('requires real active organization membership and database admin permission on both API methods', async () => {
    const orgId = randomUUID()
    const otherOrg = randomUUID()
    const actorId = randomUUID()
    await pool.query('INSERT INTO users VALUES($1,true)', [actorId])
    await pool.query('INSERT INTO user_orgs VALUES($1,$2,true)', [actorId, orgId])
    await pool.query("INSERT INTO user_permissions VALUES($1,'attendance:admin')", [actorId])
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
    policy.registerGroupMembershipPolicyRoutes({
      addRoute: (method: string, _path: string, handler: (req: unknown, res: unknown) => Promise<void>) => routes.set(method, handler),
      withPermission: (_permission: string, handler: unknown) => handler,
      resolveActor: (req: { orgId: string }) => ({ orgId: req.orgId, userId: actorId }),
      db: { transaction: inTransaction },
      authorizeManage,
    })
    async function invoke(method: string, selectedOrg = orgId) {
      const result = { status: 200, body: undefined as unknown }
      const res = { status: (status: number) => { result.status = status; return res }, json: (body: unknown) => { result.body = body } }
      await routes.get(method)!({ orgId: selectedOrg, body: { allowMultipleGroups: true, expectedVersion: 0 } }, res)
      return result
    }
    expect(await invoke('GET')).toEqual({ status: 200, body: { ok: true, data: { orgId, allowMultipleGroups: false, version: 0 } } })
    expect(await invoke('POST')).toEqual({ status: 200, body: { ok: true, data: { orgId, allowMultipleGroups: true, version: 1 } } })
    for (const method of ['GET', 'POST']) {
      expect((await invoke(method, otherOrg)).status).toBe(403)
      await pool.query('UPDATE users SET is_active=false WHERE id=$1', [actorId])
      expect((await invoke(method)).status).toBe(403)
      await pool.query('UPDATE users SET is_active=true WHERE id=$1', [actorId])
      await pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1', [actorId])
      expect((await invoke(method)).status).toBe(403)
      await pool.query('UPDATE user_orgs SET is_active=true WHERE user_id=$1', [actorId])
      await pool.query('DELETE FROM user_permissions WHERE user_id=$1', [actorId])
      expect((await invoke(method)).status).toBe(403)
      await pool.query("INSERT INTO user_permissions VALUES($1,'attendance:admin')", [actorId])
    }
    expect(await policy.readPolicy(pool, otherOrg)).toEqual({ orgId: otherOrg, allowMultipleGroups: false, version: 0 })
  })

  it('treats uppercase UUIDs as the same management group without folding user text', async () => {
    const orgId = randomUUID()
    await inTransaction(client => add(client, orgId, groupA))
    await inTransaction(client => add(client, orgId, groupA.toUpperCase()))
    expect(await count(orgId)).toBe(1)
    await inTransaction(async client => {
      await policy.prepareAdmission(client, orgId, members(groupA.toUpperCase()))
      await policy.requireAdmission(client, orgId, members(groupA))
      await expect(policy.requireAdmission(client, orgId, [{ groupId: groupA, userId: userId.toUpperCase() }]))
        .rejects.toMatchObject({ code: 'ATTENDANCE_GROUP_MEMBERSHIP_PRECONDITION_REQUIRED' })
    })
    await inTransaction(async client => {
      await policy.assertCanAddMembers(client, orgId, [{ groupId: groupB, userId: userId.toUpperCase() }])
      await client.query('INSERT INTO attendance_group_members(org_id,group_id,user_id) VALUES($1,$2,$3)', [orgId, groupB, userId.toUpperCase()])
    })
    expect(await count(orgId)).toBe(2)
  })

  it('serializes competing groups for one user, with a real waiting-lock positive control', async () => {
    const orgId = randomUUID()
    const first = await pool.connect()
    const second = await pool.connect()
    let outcome: Promise<unknown> | undefined
    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      await add(first, orgId, groupA)
      const blocked = await waiting(second)
      outcome = add(second, orgId, groupB).then(() => ({ admitted: true }), error => error)
      await blocked()
      await first.query('COMMIT')
      expect(await outcome).toMatchObject({ code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED', status: 409 })
      await second.query('ROLLBACK')
      expect(await count(orgId)).toBe(1)
      await inTransaction(client => add(client, orgId, groupA))
      expect(await count(orgId)).toBe(1)
    } finally {
      await first.query('ROLLBACK')
      await second.query('ROLLBACK')
      await outcome
      first.release(); second.release()
    }
  })

  it('disable-first rejects a waiting new second membership', async () => {
    const orgId = randomUUID()
    await inTransaction(client => policy.setPolicy(client, orgId, { allowMultipleGroups: true, expectedVersion: 0 }))
    await inTransaction(client => add(client, orgId, groupA))
    const toggler = await pool.connect()
    const writer = await pool.connect()
    let outcome: Promise<unknown> | undefined
    try {
      await toggler.query('BEGIN')
      await writer.query('BEGIN')
      await policy.setPolicy(toggler, orgId, { allowMultipleGroups: false, expectedVersion: 1 })
      const blocked = await waiting(writer)
      outcome = add(writer, orgId, groupB).then(() => ({ admitted: true }), error => error)
      await blocked()
      await toggler.query('COMMIT')
      expect(await outcome).toMatchObject({ code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED' })
      await writer.query('ROLLBACK')
      expect(await count(orgId)).toBe(1)
    } finally {
      await toggler.query('ROLLBACK'); await writer.query('ROLLBACK'); await outcome
      toggler.release(); writer.release()
    }
  })

  it('admission-first survives disabling without deleting legacy multiple memberships; removal stays possible', async () => {
    const orgId = randomUUID()
    await inTransaction(client => policy.setPolicy(client, orgId, { allowMultipleGroups: true, expectedVersion: 0 }))
    await inTransaction(client => add(client, orgId, groupA))
    const writer = await pool.connect()
    const toggler = await pool.connect()
    let outcome: Promise<unknown> | undefined
    try {
      await writer.query('BEGIN'); await toggler.query('BEGIN')
      await add(writer, orgId, groupB)
      const blocked = await waiting(toggler)
      outcome = policy.setPolicy(toggler, orgId, { allowMultipleGroups: false, expectedVersion: 1 })
        .then((value: unknown) => value, (error: unknown) => error)
      await blocked()
      await writer.query('COMMIT')
      expect(await outcome).toEqual({ orgId, allowMultipleGroups: false, version: 2 })
      await toggler.query('COMMIT')
      expect(await count(orgId)).toBe(2)
      await inTransaction(async client => {
        await add(client, orgId, groupA)
        await add(client, orgId, groupB)
      })
      await expect(inTransaction(client => add(client, orgId, groupC))).rejects.toMatchObject({ code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED' })
      await pool.query('DELETE FROM attendance_group_members WHERE org_id=$1 AND group_id=$2', [orgId, groupB])
      expect(await count(orgId)).toBe(1)
    } finally {
      await writer.query('ROLLBACK'); await toggler.query('ROLLBACK'); await outcome
      writer.release(); toggler.release()
    }
  })

  it('compare-and-set rejects a second concurrent policy transition', async () => {
    const orgId = randomUUID()
    const first = await pool.connect()
    const second = await pool.connect()
    let outcome: Promise<unknown> | undefined
    try {
      await first.query('BEGIN'); await second.query('BEGIN')
      await policy.setPolicy(first, orgId, { allowMultipleGroups: true, expectedVersion: 0 })
      const blocked = await waiting(second)
      outcome = policy.setPolicy(second, orgId, { allowMultipleGroups: false, expectedVersion: 0 })
        .then((value: unknown) => value, (error: unknown) => error)
      await blocked()
      await first.query('COMMIT')
      expect(await outcome).toMatchObject({ code: 'ATTENDANCE_GROUP_MEMBERSHIP_POLICY_VERSION_CONFLICT', status: 409 })
      await second.query('ROLLBACK')
      expect(await policy.readPolicy(pool, orgId)).toEqual({ orgId, allowMultipleGroups: true, version: 1 })
    } finally {
      await first.query('ROLLBACK'); await second.query('ROLLBACK'); await outcome
      first.release(); second.release()
    }
  })

  it('rejects a SERIALIZABLE old-enabled snapshot after disabling instead of admitting with stale policy', async () => {
    const orgId = randomUUID()
    await inTransaction(client => policy.setPolicy(client, orgId, { allowMultipleGroups: true, expectedVersion: 0 }))
    await inTransaction(client => add(client, orgId, groupA))
    const frozen = await pool.connect()
    try {
      await frozen.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      expect(await policy.readPolicy(frozen, orgId)).toEqual({ orgId, allowMultipleGroups: true, version: 1 })
      await inTransaction(client => policy.setPolicy(client, orgId, { allowMultipleGroups: false, expectedVersion: 1 }))
      await expect(policy.prepareAdmission(frozen, orgId, members(groupB))).rejects.toMatchObject({ code: '40001' })
      await frozen.query('ROLLBACK')
      expect(await count(orgId)).toBe(1)
      await expect(inTransaction(client => add(client, orgId, groupB))).rejects.toMatchObject({ code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED' })
    } finally { await frozen.query('ROLLBACK'); frozen.release() }
  })

  it('does not share policy or membership decisions across tenants and rolls back a rejected batch', async () => {
    const orgId = randomUUID()
    const other = randomUUID()
    await inTransaction(client => policy.setPolicy(client, orgId, { allowMultipleGroups: true, expectedVersion: 0 }))
    await inTransaction(client => add(client, orgId, groupA))
    await inTransaction(client => add(client, other, groupB))
    await expect(inTransaction(client => add(client, other, groupC))).rejects.toMatchObject({ code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED' })
    const batchOrg = randomUUID()
    await expect(inTransaction(async client => {
      await policy.assertCanAddMembers(client, batchOrg, [...members(groupA), ...members(groupB)])
      await add(client, batchOrg, groupA)
    })).rejects.toMatchObject({ code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED' })
    expect(await count(batchOrg)).toBe(0)
    expect(await count(other)).toBe(1)
  })
})
