import { randomUUID } from 'node:crypto'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  open: (): {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>
    transaction: <Result>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown>; __rawClient: PoolClient }) => Promise<Result>) => Promise<Result>
    getInternalPool: () => { end: () => Promise<void> }
  } => { throw new Error('POOL_SURFACE_UNREADY') },
  traces: [] as Array<{ pid: number; sql: string[]; params: unknown[][]; business: boolean; committed: boolean }>,
  live: undefined as { pid: number; sql: string[]; params: unknown[][]; business: boolean; committed: boolean } | undefined,
  livePids: [] as number[],
  poolSql: [] as string[],
  poolParams: [] as unknown[][],
  outOfRoot: [] as string[],
  events: [] as string[],
  active: 0,
  afterSql: undefined as undefined | ((sql: string, params: unknown[] | undefined, pid: number) => Promise<void>),
  failCommitAck: false,
  failReadback: false,
  audit: vi.fn(async () => undefined),
  invalidate: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  let surface: ReturnType<typeof state.open> | undefined
  state.open = () => {
    if (surface) return surface
    const service = new actual.ConnectionPool({ connectionString: process.env.DATABASE_URL, max: 6, name: 'attendance-role-writers-db' })
    const built = {
      getInternalPool: () => service.getInternalPool(),
      query: async (sql: string, params?: unknown[]) => {
        const compact = sql.replace(/\s+/g, ' ').trim()
        state.poolSql.push(compact)
        state.poolParams.push(params ?? [])
        if (state.failReadback && state.events.includes('BUSINESS_COMMIT')) throw new Error('SYNTHETIC_READBACK_FAILURE')
        const queryResult = await service.query(sql, params)
        if (/\b(?:INSERT\s+INTO|UPDATE\s+[A-Za-z_]|DELETE\s+FROM)\b/i.test(compact)) state.outOfRoot.push(compact)
        return queryResult
      },
      transaction: async <Result>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown>; __rawClient: PoolClient }) => Promise<Result>) => {
        state.active += 1
        const trace = { pid: 0, sql: [] as string[], params: [] as unknown[][], business: false, committed: false }
        try {
          const result = await service.transaction(async client => {
            trace.pid = Number((client.__rawClient as PoolClient & { processID?: number }).processID)
            state.livePids.push(trace.pid)
            return work({ __rawClient: client.__rawClient, query: async (sql: string, params?: unknown[]) => {
              const compact = sql.replace(/\s+/g, ' ').trim()
              trace.sql.push(compact)
              trace.params.push(params ?? [])
              if (compact.includes('pg_advisory_xact_lock_shared(20261106, 1)') && !compact.includes('pg_try_advisory')) { trace.business = true; state.live = trace }
              const queryResult = await client.query(sql, params)
              await state.afterSql?.(compact, params, trace.pid)
              return queryResult
            } })
          })
          trace.committed = true
          state.events.push(trace.business ? 'BUSINESS_COMMIT' : 'OTHER_COMMIT')
          if (trace.business && state.failCommitAck) throw new Error('SYNTHETIC_COMMIT_ACK_LOSS')
          return result
        } finally {
          state.livePids = state.livePids.filter(pid => pid !== trace.pid)
          state.traces.push(trace)
          state.active -= 1
        }
      },
    }
    surface = built
    return built
  }
  return { ...actual, poolManager: { get: () => state.open() } }
})
vi.mock('../../src/db/pg', () => ({
  query: (sql: string, params?: unknown[]) => state.open().query(sql, params),
  transaction: <Result>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown>; __rawClient: PoolClient }) => Promise<Result>) => state.open().transaction(work),
  pool: { query: (sql: string, params?: unknown[]) => state.open().query(sql, params) },
}))
vi.mock('../../src/middleware/auth', () => ({ authenticate: () => { throw new Error('HANDLER_SEAM_NOT_AUTH_E2E') } }))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))
vi.mock('../../src/audit/audit', () => ({ auditLog: (...args: unknown[]) => state.audit(...args) }))
vi.mock('../../src/services/AttendanceScheduler', () => ({ getSharedAttendanceScheduler: () => null }))
vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({ redeliverFailedAttendanceNotification: () => undefined }))
vi.mock('../../src/rbac/service', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return { ...actual, invalidateUserPerms: state.invalidate }
})

import { attendanceAdminRouter } from '../../src/routes/attendance-admin'
import { lockNamespaceAdmissionWrites } from '../../src/rbac/namespace-admission'
import { withAuthorizationInputTransaction } from '../../src/rbac/authorization-input-lock'
import { discoverPrivilegeRolePlan, revalidatePrivilegeRolePlan } from '../../src/rbac/authorization-privilege-witness-plan'

const databaseUrl = process.env.DATABASE_URL
if (process.env.EXPECT_DB === '1') it('sentinel: attendance role writers require DATABASE_URL', () => expect(databaseUrl).toBeTruthy())
const describeWithDatabase = databaseUrl ? describe : describe.skip
const templateRoleIds = ['attendance_admin', 'attendance_approver', 'attendance_employee', 'attendance_importer']
const assignOne = '/api/attendance-admin/users/:userId/roles/assign'
const revokeOne = '/api/attendance-admin/users/:userId/roles/unassign'
const assignMany = '/api/attendance-admin/users/batch/roles/assign'
const revokeMany = '/api/attendance-admin/users/batch/roles/unassign'
const handlerPaths = [assignOne, revokeOne, assignMany, revokeMany]
const releases: Array<() => void> = []

function rewind() {
  state.traces = []
  state.live = undefined
  state.poolSql = []
  state.poolParams = []
  state.outOfRoot = []
  state.events = []
  state.afterSql = undefined
  state.failCommitAck = false
  state.failReadback = false
}
function gate() {
  let settled = false
  let releaseGate = () => undefined
  const promise = new Promise<void>(done => { releaseGate = () => { if (settled) return; settled = true; done() } })
  releases.push(releaseGate)
  return { promise, release: releaseGate }
}
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}
function outcome<Result>(work: Promise<Result>) {
  return work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
}
function pause(pattern: RegExp) {
  const resume = gate()
  let entered = false
  let holder = 0
  state.afterSql = async (sql, _params, pid) => { if (!entered && pattern.test(sql)) { entered = true; holder = pid; await resume.promise } }
  return { wait: () => until(() => entered, 'COMMAND_DID_NOT_REACH_PAUSE'), release: resume.release, holder: () => holder }
}
function parentsOf(trace: { sql: string[]; params: unknown[][] }) {
  return trace.sql.flatMap((sql, index) => /FROM roles WHERE id = \$1(?:::text)? FOR SHARE/.test(sql) ? [String(trace.params[index]?.[0] ?? '')] : [])
}
function expectOneRoot(parents: string[]) {
  const business = state.traces.filter(trace => trace.business)
  const root = business[0]
  expect([state.traces.some(trace => !trace.business), business.length, root?.committed, root?.sql.some(sql => sql.includes('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')) ?? false, root?.sql.some(sql => sql.includes('pg_advisory_xact_lock_shared(20261106, 1)')) ?? false, state.outOfRoot.length, state.events.includes('OTHER_COMMIT'), state.events.includes('BUSINESS_COMMIT')]).toEqual([false, 1, true, true, true, 0, false, true])
  expect(parentsOf(root)).toEqual(parents)
  return root
}
async function invoke(routePath: string, actorId: string, claim: boolean, params: Record<string, string>, body: Record<string, unknown>) {
  const router = attendanceAdminRouter() as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown }> } }> }
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods.post)
  if (!layer?.route) throw new Error('Expected registered attendance handler')
  const response = { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this }, json(payload: unknown) { this.body = payload; return this } }
  await Promise.resolve(layer.route.stack[layer.route.stack.length - 1].handle({
    method: 'POST', headers: {}, query: {}, params, body, user: { id: actorId, role: claim ? 'admin' : 'user' },
  }, response, (error?: unknown) => { if (error) throw error }))
  return response
}

describeWithDatabase('attendance role writers on the real pool; registered handlers exclude authentication', () => {
  let observer: PgPool
  const userIds: string[] = []
  const roleIds: string[] = []
  const integrationIds: string[] = []
  const groupIds: string[] = []
  const controls: Array<{ close: () => Promise<void> }> = []

  beforeAll(async () => {
    observer = new PgPool({ connectionString: databaseUrl, max: 4 })
    state.open()
    const router = attendanceAdminRouter() as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }
    for (const path of handlerPaths) expect(router.stack.some(entry => entry.route?.path === path && entry.route.methods.post)).toBe(true)
    expect((await observer.query('SELECT id FROM roles WHERE id = ANY($1::text[]) ORDER BY id', [templateRoleIds])).rows.map(row => row.id)).toEqual(templateRoleIds)
    expect((await observer.query("SELECT id FROM roles WHERE id = 'admin'")).rows).toEqual([{ id: 'admin' }])
    expect((await observer.query("SELECT count(*)::int AS total FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND contype = 'f'")).rows).toEqual([{ total: 0 }])
  })
  beforeEach(() => {
    expect(state.active).toBe(0)
    rewind()
    const afterCommit = (label: string) => {
      expect(state.active).toBe(0)
      expect(state.events).toContain('BUSINESS_COMMIT')
      state.events.push(label)
    }
    state.audit.mockReset().mockImplementation(async () => afterCommit('audit'))
    state.invalidate.mockReset().mockImplementation(() => afterCommit('invalidate'))
  })
  afterEach(async () => {
    state.afterSql = undefined
    state.failCommitAck = false
    state.failReadback = false
    for (const release of releases.splice(0)) release()
    for (const handle of controls.splice(0)) await handle.close()
    const deadline = Date.now() + 1000
    while (state.active !== 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const ownedUsers = [...userIds]
    const ownedRoles = [...roleIds]
    const cleanupErrors: unknown[] = []
    const cleanups: Array<[string, unknown[]]> = [
      ['DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [ownedRoles]],
      ['DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[])', [ownedUsers]],
      ['DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = ANY($1::text[])', [ownedUsers]],
      ['DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ownedUsers]],
      ['DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [ownedUsers]],
      ['DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [ownedUsers]],
      ['DELETE FROM directory_departments WHERE integration_id = ANY($1::uuid[])', [[...integrationIds]]],
      ['DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [[...integrationIds]]],
      ['DELETE FROM platform_member_groups WHERE id = ANY($1::uuid[])', [[...groupIds]]],
      ['DELETE FROM users WHERE id = ANY($1::text[])', [ownedUsers]],
      ["DELETE FROM roles WHERE id = ANY($1::text[]) AND id <> 'admin' AND NOT (id = ANY($2::text[]))", [ownedRoles, templateRoleIds]],
    ]
    const cleaner = await observer.connect()
    try {
      await cleaner.query("SET lock_timeout = '2s'")
      for (const [sql, params] of cleanups) { try { await cleaner.query(sql, params) } catch (error) { cleanupErrors.push(error) } }
    } finally { await cleaner.query('RESET lock_timeout').catch(() => undefined); cleaner.release() }
    if (cleanupErrors.length === 0) { userIds.length = 0; roleIds.length = 0; integrationIds.length = 0; groupIds.length = 0 }
    expect(state.active).toBe(0)
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
    expect((await observer.query("SELECT id FROM roles WHERE id = 'admin'")).rows).toEqual([{ id: 'admin' }])
  })
  afterAll(async () => {
    await state.open().getInternalPool().end()
    await observer?.end()
  })

  async function insertUser(rawRole: string) {
    const userId = randomUUID()
    userIds.push(userId)
    await observer.query(
      `INSERT INTO users (id, username, email, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set)
       VALUES ($1, $2, $3, 'p1f synthetic', 'synthetic-unused', true, false, $4, '[]'::jsonb, 'activated', false)`,
      [userId, `p1f-${userId}`, `p1f-${userId}@example.invalid`, rawRole],
    )
    return userId
  }
  async function seedActor(kind: 'raw' | 'member' | 'disabled-edge' | 'plain') {
    const actorId = await insertUser(kind === 'raw' ? 'admin' : kind === 'disabled-edge' ? 'disabled' : 'user')
    if (kind === 'member' || kind === 'disabled-edge') await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    return actorId
  }
  async function insertCustom() {
    const roleId = `attendance_p1f_${randomUUID().replaceAll('-', '')}`
    roleIds.push(roleId)
    await observer.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [roleId, roleId])
    await observer.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'attendance:read')", [roleId])
    return roleId
  }
  async function membership(userId: string, roleId: string) {
    return (await observer.query('SELECT user_id FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, roleId])).rows.length
  }
  async function blockedBy(waiter: number, holder: number) {
    await until(async () => (await observer.query("SELECT wait_event_type = 'Lock' AND $2 = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1", [waiter, holder])).rows[0]?.blocked === true, 'EXPECTED_PHYSICAL_LOCK_WAIT')
  }
  async function control() {
    const client = await observer.connect()
    await client.query('BEGIN')
    const pid = Number((client as PoolClient & { processID?: number }).processID)
    let closed = false
    const handle = { client, pid, close: async () => { if (closed) return; closed = true; await client.query('ROLLBACK').catch(() => undefined); client.release() } }
    controls.push(handle)
    return handle
  }
  async function rootPid() {
    await until(() => state.live?.business === true, 'BUSINESS_ROOT_NOT_OPEN')
    const pid = state.live?.pid
    if (pid === undefined) throw new Error('BUSINESS_PID_MISSING')
    return pid
  }
  async function plantAudience(userId: string) {
    const integration = (await observer.query("INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config) VALUES ($1, 'dingtalk', $1, 'active', $1, '{}'::jsonb) RETURNING id", [`p1f-${randomUUID()}`])).rows[0].id as string
    integrationIds.push(integration)
    const department = (await observer.query("INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw) VALUES ($1, 'dingtalk', $2, $2, true, '{}'::jsonb) RETURNING id", [integration, `p1f-${randomUUID()}`])).rows[0].id as string
    const group = (await observer.query('INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id', [`p1f-${randomUUID()}`])).rows[0].id as string
    groupIds.push(group)
    await observer.query('INSERT INTO delegated_role_admin_scopes (admin_user_id, namespace, directory_department_id) VALUES ($1, $2, $3)', [userId, 'attendance', department])
    await observer.query('INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id) VALUES ($1, $2, $3)', [userId, 'attendance', group])
    return () => observer.query('SELECT (SELECT count(*)::int FROM delegated_role_admin_scopes WHERE admin_user_id = $1) AS departments, (SELECT count(*)::int FROM delegated_role_admin_member_groups WHERE admin_user_id = $1) AS groups', [userId]).then(result => result.rows[0])
  }

  it('runs all four handlers once against a missing custom parent', async () => {
    const actorId = await seedActor('raw')
    const targets = [await insertUser('user'), await insertUser('user')].sort().reverse()
    const roleId = `attendance_p1f_${randomUUID().replaceAll('-', '')}`
    expect((await observer.query('SELECT id FROM roles WHERE id = $1', [roleId])).rows).toEqual([])
    const fullProfile = (await observer.query('SELECT id, email, name, employee_no AS "employeeNo", department, role, is_active, is_admin, last_login_at, created_at FROM users WHERE id = $1', [targets[0]])).rows[0]
    const profiles = (await observer.query('SELECT id, email, name, employee_no AS "employeeNo", department, is_active FROM users WHERE id = ANY($1::text[])', [targets])).rows
    const orderedProfiles = targets.map(userId => profiles.find(row => row.id === userId))
    const declared = [...templateRoleIds, roleId].sort()
    const steps: Array<{ action: 'assign' | 'unassign'; batch: boolean; parents: string[]; members: string[] }> = [
      { action: 'assign', batch: false, parents: declared, members: [targets[0]] },
      { action: 'assign', batch: true, parents: declared, members: [...targets].sort() },
      { action: 'unassign', batch: false, parents: [roleId], members: [targets[1]] },
      { action: 'unassign', batch: true, parents: [roleId], members: [] },
    ]
    expect(steps).toHaveLength(4)
    for (const step of steps) {
      rewind()
      const response = await invoke(step.batch ? `/api/attendance-admin/users/batch/roles/${step.action}` : `/api/attendance-admin/users/:userId/roles/${step.action}`, actorId, true, step.batch ? {} : { userId: targets[0] }, { roleId, scope: 'global', ...(step.batch ? { userIds: targets } : {}) })
      expect(response.statusCode).toBe(200)
      const batchBody = { roleId, requested: 2, eligible: 2, updated: 1, affectedUserIds: [targets[1]], affectedUserIdsTruncated: false, unchangedUserIds: [targets[0]], unchangedUserIdsTruncated: false, missingUserIds: [], inactiveUserIds: [], items: orderedProfiles }
      expect(response.body).toEqual(step.batch ? { ok: true, data: batchBody, meta: undefined } : { ok: true, data: { user: fullProfile, roles: step.action === 'assign' ? [roleId] : [], permissions: [], isAdmin: false }, meta: undefined })
      expect((await observer.query('SELECT user_id, role_id FROM user_roles WHERE user_id = ANY($1::text[]) AND role_id = $2 ORDER BY user_id', [targets, roleId])).rows)
        .toEqual(step.members.map(userId => ({ user_id: userId, role_id: roleId })))
      expectOneRoot(step.parents)
      expect((await observer.query('SELECT id FROM roles WHERE id = $1', [roleId])).rows).toEqual([])
      expect(state.audit).not.toHaveBeenCalled()
      expect(state.invalidate).not.toHaveBeenCalled()
    }
    expect((await observer.query('SELECT user_id FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [targets])).rows).toEqual([])
    expect((await observer.query('SELECT admin_user_id FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[])', [targets])).rows).toEqual([])
    expect((await observer.query('SELECT admin_user_id FROM delegated_role_admin_member_groups WHERE admin_user_id = ANY($1::text[])', [targets])).rows).toEqual([])
  })

  it('separates raw-admin, live edge, false claim, and missing S0', async () => {
    const roleId = await insertCustom()
    const declared = [...templateRoleIds, roleId].sort()
    const rawId = await seedActor('raw')
    const self = await invoke(assignOne, rawId, true, { userId: rawId }, { roleId, scope: 'global' })
    expect(self.statusCode).toBe(200)
    expect(expectOneRoot(declared).sql.some(sql => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(false)
    expect(await membership(rawId, roleId)).toBe(1)
    const memberId = await seedActor('member')
    const memberTarget = await insertUser('user')
    rewind()
    expect((await invoke(assignOne, memberId, true, { userId: memberTarget }, { roleId, scope: 'global' })).statusCode).toBe(200)
    expect(expectOneRoot(declared).sql.some(sql => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(true)
    const falseClaimId = await seedActor('raw')
    await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [falseClaimId])
    const falseTarget = await insertUser('user')
    rewind()
    expect((await invoke(assignOne, falseClaimId, false, { userId: falseTarget }, { roleId, scope: 'global' })).statusCode).toBe(200)
    expect(expectOneRoot(declared).sql.some(sql => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(true)
    const disabledId = await seedActor('disabled-edge')
    const disabledTarget = await insertUser('user')
    rewind()
    expect((await invoke(assignOne, disabledId, true, { userId: disabledTarget }, { roleId, scope: 'global' })).statusCode).toBe(200)
    expect(expectOneRoot(declared).sql.some(sql => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(true)
    const nakedId = await seedActor('raw')
    rewind()
    const naked = await invoke(assignOne, nakedId, false, { userId: await insertUser('user') }, { roleId, scope: 'global' })
    expect(naked).toMatchObject({ statusCode: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Platform admin access required for global user scope' } } })
    expect(state.traces).toEqual([])
    expect(state.poolSql.some((sql, index) => sql.includes('FROM user_roles') && state.poolParams[index]?.[1] === 'admin')).toBe(true)
    expect(state.poolSql.some(sql => sql.includes('FOR SHARE') || sql.includes('FOR UPDATE') || sql.includes('hashtextextended'))).toBe(false)
    expect(state.outOfRoot).toEqual([])
    const fakeId = await seedActor('plain')
    const fakeTarget = await insertUser('user')
    rewind()
    const fake = await invoke(assignOne, fakeId, true, { userId: fakeTarget }, { roleId, scope: 'global' })
    expect(fake).toMatchObject({ statusCode: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } } })
    const failed = state.traces.filter(trace => trace.business)
    expect(failed).toHaveLength(1)
    expect(failed[0].committed).toBe(false)
    expect(failed[0].sql.some(sql => sql.includes('pg_advisory_xact_lock_shared(20261106, 1)'))).toBe(true)
    expect(failed[0].sql.some(sql => sql.includes("role_id = 'admin' FOR SHARE") || sql.includes('INSERT INTO user_roles'))).toBe(false)
    expect(await membership(fakeTarget, roleId)).toBe(0)
  })

  it('keeps actor refusal and pending-target acceptance on the existing baseline', async () => {
    const updates = ['UPDATE users SET is_active = false WHERE id = $1', "UPDATE users SET activation_status = 'pending_activation' WHERE id = $1", 'UPDATE users SET deleted_at = NOW() WHERE id = $1', 'UPDATE users SET deleted_at = NOW(), purged_at = NOW() WHERE id = $1']
    for (const sql of updates) {
      const actorId = await seedActor('raw')
      await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
      const targetId = await insertUser('user')
      await observer.query(sql, [actorId])
      rewind()
      const response = await invoke(assignOne, actorId, true, { userId: targetId }, { template: 'employee', scope: 'global' })
      expect(response).toMatchObject({ statusCode: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } } })
      expect(state.traces.some(trace => trace.sql.some(statement => statement.includes('INSERT INTO user_roles')))).toBe(false)
      expect(state.outOfRoot).toEqual([])
      expect(await membership(targetId, 'attendance_employee')).toBe(0)
    }
    const actorId = await seedActor('raw')
    const pendingTarget = await insertUser('user')
    await observer.query("UPDATE users SET activation_status = 'pending_activation' WHERE id = $1", [pendingTarget])
    rewind()
    expect((await invoke(assignOne, actorId, true, { userId: pendingTarget }, { template: 'employee', scope: 'global' })).statusCode).toBe(200)
    expect(await membership(pendingTarget, 'attendance_employee')).toBe(1)
    expectOneRoot(templateRoleIds)
  })

  it('refuses bad targets and non-global scope before any root or DML', async () => {
    const actorId = await seedActor('raw')
    const inactiveId = await insertUser('user')
    await observer.query('UPDATE users SET is_active = false WHERE id = $1', [inactiveId])
    const recycledId = await insertUser('user')
    await observer.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [recycledId])
    const purgedId = await insertUser('user')
    await observer.query('UPDATE users SET deleted_at = NOW(), purged_at = NOW() WHERE id = $1', [purgedId])
    for (const userId of [inactiveId, randomUUID(), recycledId, purgedId]) {
      rewind()
      const response = await invoke(assignOne, actorId, true, { userId }, { template: 'employee', scope: 'global' })
      expect(response).toMatchObject({ statusCode: 404, body: { ok: false, error: { code: 'USER_TARGET_NOT_FOUND' } } })
      expect(state.traces).toEqual([])
      expect(state.outOfRoot).toEqual([])
    }
    rewind()
    const invalid = await invoke(assignOne, actorId, true, { userId: inactiveId }, { template: 'employee', scope: 'local' })
    expect(invalid).toMatchObject({ statusCode: 400, body: { ok: false, error: { code: 'USER_SCOPE_INVALID' } } })
    expect(state.traces).toEqual([])
    expect(state.outOfRoot).toEqual([])
    const orgId = randomUUID()
    await observer.query('INSERT INTO user_orgs (user_id, org_id) VALUES ($1, $2)', [actorId, orgId])
    rewind()
    const orgWrite = await invoke(assignOne, actorId, true, { userId: inactiveId }, { template: 'employee', scope: 'org', orgId })
    expect(orgWrite).toMatchObject({ statusCode: 403, body: { ok: false, error: { code: 'ORG_SCOPED_ROLE_WRITE_UNAVAILABLE' } } })
    expect(state.traces).toEqual([])
    expect(state.outOfRoot).toEqual([])
    expect(await membership(inactiveId, 'attendance_employee')).toBe(0)
  })

  it('keeps batch request order, duplicate collapse, and a no-op second assign', async () => {
    const actorId = await seedActor('raw')
    const requestIds = [await insertUser('user'), await insertUser('user')].sort().reverse()
    const found = (await observer.query('SELECT id, email, name, employee_no AS "employeeNo", department, is_active FROM users WHERE id = ANY($1::text[])', [requestIds])).rows
    const items = requestIds.map(userId => found.find(row => row.id === userId))
    const first = await invoke(assignMany, actorId, true, {}, { template: 'employee', scope: 'global', userIds: [...requestIds, requestIds[0]] })
    expect(first.statusCode).toBe(200)
    expect(first.body).toEqual({ ok: true, data: { roleId: 'attendance_employee', requested: 2, eligible: 2, updated: 2, affectedUserIds: requestIds, affectedUserIdsTruncated: false, unchangedUserIds: [], unchangedUserIdsTruncated: false, missingUserIds: [], inactiveUserIds: [], items }, meta: undefined })
    expectOneRoot(templateRoleIds)
    rewind()
    const second = await invoke(assignMany, actorId, true, {}, { template: 'employee', scope: 'global', userIds: requestIds })
    expect(second.body).toMatchObject({ ok: true, data: { requested: 2, updated: 0, affectedUserIds: [], unchangedUserIds: requestIds } })
    expectOneRoot(templateRoleIds)
  })

  it('waits on the world lock before parent, admission, or user rows', async () => {
    const actorId = await seedActor('raw')
    const targetId = await insertUser('user')
    const roleId = await insertCustom()
    const blocker = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await blocker.client.query('SELECT pg_advisory_xact_lock(20261106, 1)')
      pending = outcome(invoke(assignOne, actorId, true, { userId: targetId }, { roleId, scope: 'global' }))
      await blockedBy(await rootPid(), blocker.pid)
      expect(state.live?.sql.some(sql => /FROM roles\b.*FOR SHARE|hashtextextended|FROM users\b.*FOR UPDATE/i.test(sql))).toBe(false)
      expect(await membership(targetId, roleId)).toBe(0)
    } finally {
      await blocker.close()
      const result = await pending
      expect(result?.ok).toBe(true)
      if (result?.ok) expect(result.value.statusCode).toBe(200)
    }
    expectOneRoot([...templateRoleIds, roleId].sort())
    expect(await membership(targetId, roleId)).toBe(1)
  })

  it('blocks on the custom parent before admission and user locks, leaving those probes free', async () => {
    const actorId = await seedActor('raw')
    const targetId = await insertUser('user')
    const roleId = await insertCustom()
    const blocker = await control()
    const probe = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await blocker.client.query('SELECT id FROM roles WHERE id = $1 FOR UPDATE', [roleId])
      pending = outcome(invoke(assignOne, actorId, true, { userId: targetId }, { roleId, scope: 'global' }))
      await until(() => Boolean(state.live?.sql.some((sql, index) => /FROM roles\b.*FOR SHARE/i.test(sql) && state.live?.params[index]?.[0] === roleId)), 'PARENT_SHARE_NOT_STARTED')
      await blockedBy(await rootPid(), blocker.pid)
      expect(state.live?.sql.some(sql => sql.includes('hashtextextended') || (sql.includes('FROM users') && sql.includes('FOR UPDATE')))).toBe(false)
      expect(await membership(targetId, roleId)).toBe(0)
      await probe.client.query("SET LOCAL lock_timeout = '300ms'")
      await lockNamespaceAdmissionWrites(probe.client, targetId)
      await probe.client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [targetId])
      await probe.close()
      await blocker.client.query('ROLLBACK')
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
    } finally {
      await probe.close()
      await blocker.close()
      await pending
    }
    expectOneRoot([...templateRoleIds, roleId].sort())
    expect(await membership(targetId, roleId)).toBe(1)
  })

  it.each(['actor-admission', 'target-admission', 'actor-user', 'target-user'] as const)('blocks on an independent %s lock before membership DML', async mode => {
    const actorId = await seedActor('raw')
    const targetId = await insertUser('user')
    const roleId = await insertCustom()
    const blocker = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      const subjectId = mode.startsWith('actor') ? actorId : targetId
      if (mode.endsWith('admission')) await lockNamespaceAdmissionWrites(blocker.client, subjectId)
      else await blocker.client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [subjectId])
      pending = outcome(invoke(assignOne, actorId, true, { userId: targetId }, { roleId, scope: 'global' }))
      await blockedBy(await rootPid(), blocker.pid)
      expect(state.live?.sql.some(sql => sql.includes('INSERT INTO user_roles'))).toBe(false)
      if (mode.endsWith('admission')) expect(state.live?.sql.some(sql => sql.includes('FROM users') && sql.includes('FOR UPDATE'))).toBe(false)
      else {
        expect(state.live?.sql.some((sql, index) => sql.includes('FROM users') && sql.includes('FOR UPDATE') && state.live?.params[index]?.[0] === subjectId)).toBe(true)
        expect(state.live?.sql.some(sql => sql.includes('FOR SHARE OF u'))).toBe(false)
      }
      expect(await membership(targetId, roleId)).toBe(0)
      await blocker.client.query('ROLLBACK')
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
    } finally {
      await blocker.close()
      await pending
    }
    expect(await membership(targetId, roleId)).toBe(1)
  })

  it('holds false-claim raw-admin edge SHARE until the business commit', async () => {
    const actorId = await seedActor('raw')
    await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    const targetId = await insertUser('user')
    const paused = pause(/role_id = 'admin' FOR SHARE/)
    const pending = outcome(invoke(assignOne, actorId, false, { userId: targetId }, { template: 'employee', scope: 'global' }))
    const editor = await control()
    let deleting: Promise<unknown> | undefined
    try {
      await paused.wait()
      expect(state.events.includes('BUSINESS_COMMIT') || state.audit.mock.calls.length > 0 || state.invalidate.mock.calls.length > 0).toBe(false)
      deleting = editor.client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [actorId])
      await blockedBy(editor.pid, paused.holder())
      expect(await membership(targetId, 'attendance_employee')).toBe(0)
    } finally {
      paused.release()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
      await deleting
      await editor.close()
    }
    expect(await membership(targetId, 'attendance_employee')).toBe(1)
    expect(state.events.indexOf('BUSINESS_COMMIT')).toBeGreaterThanOrEqual(0)
  })

  it.each(['COMMIT', 'ROLLBACK'] as const)('rereads a prior raw-admin edge delete after %s', async decision => {
    const actorId = await seedActor('raw')
    await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    const targetId = await insertUser('user')
    const remover = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await remover.client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [actorId])
      pending = outcome(invoke(assignOne, actorId, false, { userId: targetId }, { template: 'employee', scope: 'global' }))
      await blockedBy(await rootPid(), remover.pid)
      await remover.client.query(decision)
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.statusCode).toBe(decision === 'ROLLBACK' ? 200 : 403)
        if (decision === 'COMMIT') expect(result.value.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', message: 'Platform admin access required for global user scope' } })
      }
    } finally {
      await remover.close()
      await pending
    }
    expect(await membership(targetId, 'attendance_employee')).toBe(decision === 'ROLLBACK' ? 1 : 0)
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [actorId])).rows).toHaveLength(decision === 'ROLLBACK' ? 1 : 0)
  })

  it.each(['producer-first', 'consumer-first'] as const)('serializes the existing CONSUME reader %s and does not claim a full B2 consumer', async order => {
    const actorId = await seedActor('raw')
    const targetId = await insertUser('user')
    await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'attendance_employee')", [targetId])
    const rolePlan = await discoverPrivilegeRolePlan({ query: (sql, params) => observer.query(sql, params) }, [targetId])
    const resume = gate()
    let readerEntered = false
    const unassign = () => outcome(invoke(revokeOne, actorId, true, { userId: targetId }, { roleId: 'attendance_employee', scope: 'global' }))
    let producer: ReturnType<typeof outcome> | undefined
    let consumer: ReturnType<typeof outcome> | undefined
    const paused = order === 'producer-first' ? pause(/DELETE FROM user_roles/) : undefined
    try {
      if (paused) {
        producer = unassign()
        await paused.wait()
        consumer = outcome(withAuthorizationInputTransaction(rolePlan.lockPlan, tx => revalidatePrivilegeRolePlan(tx, rolePlan)))
        await until(() => state.livePids.some(pid => pid !== paused.holder()), 'CONSUME_NOT_STARTED')
        const readerPid = state.livePids.find(pid => pid !== paused.holder())
        if (readerPid === undefined) throw new Error('CONSUME_PID_MISSING')
        await blockedBy(readerPid, paused.holder())
      } else {
        consumer = outcome(withAuthorizationInputTransaction(rolePlan.lockPlan, async tx => { await revalidatePrivilegeRolePlan(tx, rolePlan); readerEntered = true; await resume.promise }))
        await until(() => readerEntered, 'CONSUMER_NOT_READY')
        const readerPid = state.livePids[state.livePids.length - 1]
        producer = unassign()
        await until(() => state.livePids.some(pid => pid !== readerPid), 'WRITER_NOT_STARTED')
        const writerPid = state.livePids.find(pid => pid !== readerPid)
        if (writerPid === undefined) throw new Error('WRITER_PID_MISSING')
        await blockedBy(writerPid, readerPid)
      }
      expect(await membership(targetId, 'attendance_employee')).toBe(1)
    } finally {
      paused?.release(); resume.release()
      if (producer) expect((await producer).ok).toBe(true)
      if (consumer) { const result = await consumer; expect(result.ok).toBe(order === 'consumer-first'); if (!result.ok) expect(result.error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_STALE' }) }
    }
    expect(await membership(targetId, 'attendance_employee')).toBe(0)
  })

  it('clears attendance_admin audience once, skips duplicate cleanup, and opt-out is employee-only', async () => {
    const actorId = await seedActor('raw')
    const targetId = await insertUser('user')
    const readAudience = await plantAudience(targetId)
    const paused = pause(/DELETE FROM delegated_role_admin_scopes/)
    const pending = outcome(invoke(assignOne, actorId, true, { userId: targetId }, { roleId: 'attendance_admin', scope: 'global' }))
    try {
      await paused.wait()
      expect(state.events.includes('BUSINESS_COMMIT') || state.audit.mock.calls.length > 0 || state.invalidate.mock.calls.length > 0).toBe(false)
      expect(await readAudience()).toEqual({ departments: 1, groups: 1 })
    } finally { paused.release() }
    expect((await pending).ok).toBe(true)
    expect(await readAudience()).toEqual({ departments: 0, groups: 0 })
    expect(state.events.filter(event => event === 'BUSINESS_COMMIT' || event === 'audit')).toEqual(['BUSINESS_COMMIT', 'audit'])
    await plantAudience(targetId)
    rewind()
    state.audit.mockClear()
    expect((await invoke(assignOne, actorId, true, { userId: targetId }, { roleId: 'attendance_admin', scope: 'global' })).statusCode).toBe(200)
    expect(await readAudience()).toEqual({ departments: 1, groups: 1 })
    expect(state.audit).not.toHaveBeenCalled()
    const employeeId = await insertUser('user')
    await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'attendance_employee')", [employeeId])
    rewind()
    expect((await invoke(revokeOne, actorId, true, { userId: employeeId }, { roleId: 'attendance_employee', scope: 'global' })).statusCode).toBe(200)
    expect(await membership(employeeId, 'attendance_employee')).toBe(0)
    expect((await observer.query("SELECT enabled, source FROM user_namespace_admissions WHERE user_id = $1 AND namespace = 'attendance'", [employeeId])).rows).toEqual([{ enabled: false, source: 'role_unassigned' }])
    expect(state.audit).not.toHaveBeenCalled()
  })

  it('rolls both employee revokes back when the second admission write throws', async () => {
    const actorId = await seedActor('raw')
    const targetIds = [await insertUser('user'), await insertUser('user')].sort()
    for (const targetId of targetIds) await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'attendance_employee')", [targetId])
    let admissionWrites = 0
    state.afterSql = async sql => {
      if (!sql.includes('INSERT INTO user_namespace_admissions')) return
      admissionWrites += 1
      if (admissionWrites === 2) throw new Error('SYNTHETIC_ATOMIC_FAILURE')
    }
    const response = await invoke(revokeMany, actorId, true, {}, { roleId: 'attendance_employee', scope: 'global', userIds: targetIds })
    expect(response.statusCode).toBe(500)
    expect(admissionWrites).toBe(2)
    for (const targetId of targetIds) expect(await membership(targetId, 'attendance_employee')).toBe(1)
    expect((await observer.query('SELECT user_id FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [targetIds])).rows).toEqual([])
    expect(state.events).not.toContain('BUSINESS_COMMIT')
  })

  it('rolls back after a real membership insert and does not replay', async () => {
    const actorId = await seedActor('raw')
    const targetId = await insertUser('user')
    const roleId = await insertCustom()
    state.afterSql = async sql => { if (sql.includes('INSERT INTO user_roles')) throw new Error('SYNTHETIC_ATOMIC_FAILURE') }
    expect((await invoke(assignOne, actorId, true, { userId: targetId }, { roleId, scope: 'global' })).statusCode).toBe(500)
    expect(await membership(targetId, roleId)).toBe(0)
    expect(state.events).not.toContain('BUSINESS_COMMIT')
    expect(state.traces.filter(trace => trace.business && trace.sql.some(sql => sql.includes('INSERT INTO user_roles')))).toHaveLength(1)
  })

  it('keeps persisted membership after commit-ack loss and after post-commit read failure', async () => {
    const actorId = await seedActor('raw')
    const lostId = await insertUser('user')
    state.failCommitAck = true
    expect((await invoke(assignOne, actorId, true, { userId: lostId }, { template: 'employee', scope: 'global' })).statusCode).toBe(500)
    expect(await membership(lostId, 'attendance_employee')).toBe(1)
    expect(state.traces.filter(trace => trace.business && trace.committed)).toHaveLength(1)
    expect(state.audit).not.toHaveBeenCalled()
    const readId = await insertUser('user'); rewind()
    state.failReadback = true
    expect((await invoke(assignOne, actorId, true, { userId: readId }, { template: 'approver', scope: 'global' })).statusCode).toBe(500)
    expect(await membership(readId, 'attendance_approver')).toBe(1)
    expect(state.traces.filter(trace => trace.business && trace.committed)).toHaveLength(1)
    expect(state.events.filter(event => event === 'BUSINESS_COMMIT')).toHaveLength(1)
  })
})
