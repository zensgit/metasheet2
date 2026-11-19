import { randomUUID } from 'node:crypto'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import type { Request, Response } from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  service: undefined as unknown,
  pids: [] as number[],
  events: [] as string[],
  active: 0,
  failCommitAck: false,
  failReadback: false,
  observeSettings: false,
  settings: [] as Array<{ phase: string; lock_timeout: string; statement_timeout: string }>,
  afterSql: undefined as undefined | ((sql: string, params: unknown[] | undefined, pid: number) => Promise<void>),
  audit: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  return { ...actual, poolManager: { get: () => {
    const service = (state.service ??= new actual.ConnectionPool({ connectionString: process.env.DATABASE_URL, max: 6, name: 'platform-role-assign-db' })) as InstanceType<typeof actual.ConnectionPool>
    return {
      getInternalPool: () => service.getInternalPool(),
      query: async (sql: string, params?: unknown[]) => {
        if (state.failReadback && state.events.includes('COMMIT_CONFIRMED')) throw new Error('SYNTHETIC_READBACK_FAILURE')
        return service.query(sql, params)
      },
      transaction: async <Result>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown>; __rawClient: PoolClient }) => Promise<Result>) => {
        state.active += 1
        try {
          const result = await service.transaction(async (client) => {
            const pid = Number((client.__rawClient as PoolClient & { processID: number }).processID)
            state.pids.push(pid)
            return work({ __rawClient: client.__rawClient, query: async (sql, params) => {
              const result = await client.query(sql, params)
              if (state.observeSettings) {
                if (sql.includes("current_setting('lock_timeout')")) state.settings.push({ phase: 'saved', ...result.rows[0] } as { phase: string; lock_timeout: string; statement_timeout: string })
                if (sql.includes("role_id = 'admin' FOR SHARE") || sql.includes('INSERT INTO user_roles')) {
                  const settings = await client.query("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")
                  state.settings.push({ phase: sql.includes('INSERT INTO') ? 'write' : 'member', ...settings.rows[0] } as { phase: string; lock_timeout: string; statement_timeout: string })
                }
              }
              state.events.push(sql.replace(/\s+/g, ' ').trim())
              await state.afterSql?.(sql, params, pid)
              return result
            } })
          })
          state.events.push('COMMIT_CONFIRMED')
          if (state.failCommitAck) throw new Error('SYNTHETIC_COMMIT_ACK_LOSS')
          return result
        } finally {
          state.active -= 1
        }
      },
    }
  } } }
})
vi.mock('../../src/middleware/auth', () => ({ authenticate: () => { throw new Error('HANDLER_SEAM_NOT_AUTH_E2E') } }))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))
vi.mock('../../src/audit/audit', () => ({ auditLog: state.audit }))
vi.mock('../../src/rbac/service', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/rbac/service')>(),
  invalidateUserPerms: state.invalidate,
}))

import { adminUsersRouter } from '../../src/routes/admin-users'
import { assignPlatformUserRoleCommand } from '../../src/admin/platform-role-assign-command'
import { ConnectionPool } from '../../src/integration/db/connection-pool'
import { withAuthorizationInputTransaction } from '../../src/rbac/authorization-input-lock'
import { discoverPrivilegeRolePlan, revalidatePrivilegeRolePlan } from '../../src/rbac/authorization-privilege-witness-plan'
import { lockSharedAccessSubjects } from '../../src/admin/platform-actor-authority'
import { unassignUserRoles } from '../../src/rbac/role-assignment'
import { lockNamespaceAdmissionWrites } from '../../src/rbac/namespace-admission'
import { lockRoleRowForShare } from '../../src/admin/role-row-contract'

const DATABASE_URL = process.env.DATABASE_URL
if (process.env.EXPECT_DB === '1') it('sentinel: platform role assignment requires DATABASE_URL', () => expect(DATABASE_URL).toBeTruthy())
const describeWithDatabase = DATABASE_URL ? describe : describe.skip

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, release: () => resolve() }
}

async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

function outcome<Result>(work: Promise<Result>) {
  return work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
}

async function route(actorId: string, userId: string, roleId: string, extra: Record<string, unknown> = {}) {
  const layer = adminUsersRouter().stack.find(entry => entry.route?.path === '/api/admin/users/:userId/roles/assign')
  const handler = layer!.route.stack.at(-1)!.handle
  const response = {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  await handler({ user: { id: actorId, role: 'admin' }, params: { userId }, body: { roleId, ...extra }, headers: {} } as unknown as Request, response as unknown as Response, () => { throw new Error('UNEXPECTED_NEXT') })
  return response
}

describeWithDatabase('platform role assign command (actual PostgreSQL; handler seam excludes authentication)', () => {
  let observer: PgPool
  let other: ConnectionPool
  const userIds: string[] = []
  const roleIds: string[] = []
  const integrationIds: string[] = []
  const groupIds: string[] = []

  beforeAll(() => {
    observer = new PgPool({ connectionString: DATABASE_URL, max: 5 })
    other = new ConnectionPool({ connectionString: DATABASE_URL, max: 3, name: 'platform-role-assign-competitor' })
  })
  beforeEach(() => {
    expect(state.active).toBe(0)
    state.pids = []
    state.events = []
    state.afterSql = undefined
    state.failCommitAck = false
    state.failReadback = false
    state.observeSettings = false
    state.settings = []
    state.audit.mockReset().mockImplementation(async () => {
      expect(state.active).toBe(0)
      expect(state.events).toContain('COMMIT_CONFIRMED')
    })
    state.invalidate.mockReset().mockImplementation(() => {
      expect(state.active).toBe(0)
      expect(state.events).toContain('COMMIT_CONFIRMED')
    })
  })
  afterAll(async () => {
    state.afterSql = undefined
    try {
      await observer.query('DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM directory_departments WHERE integration_id = ANY($1::uuid[])', [integrationIds])
      await observer.query('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [integrationIds])
      await observer.query('DELETE FROM platform_member_groups WHERE id = ANY($1::uuid[])', [groupIds])
      await observer.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM roles WHERE id = ANY($1::text[])', [roleIds])
    } finally {
      if (state.service) await (state.service as ConnectionPool).getInternalPool().end()
      await other.getInternalPool().end()
      await observer.end()
    }
  })

  async function seed(authority: 'raw' | 'member' | 'none' | 'disabled-member' = 'member', mainAdmin = false) {
    const actorId = `role-actor-${randomUUID()}`
    const userId = `role-target-${randomUUID()}`
    const namespace = `role${randomUUID().replaceAll('-', '')}`
    const roleId = mainAdmin ? `${namespace}_admin` : `role-${randomUUID()}`
    userIds.push(actorId, userId)
    roleIds.push(roleId)
    for (const id of [actorId, userId]) {
      const role = id === actorId && authority === 'raw' ? 'admin' : id === actorId && authority === 'disabled-member' ? 'disabled' : 'user'
      await observer.query("INSERT INTO users (id, username, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set) VALUES ($1, $1, 'Synthetic role fixture', 'synthetic-unused', true, false, $2, '[]'::jsonb, 'activated', false)", [id, role])
    }
    if (authority === 'member' || authority === 'disabled-member') await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [actorId])
    await observer.query('INSERT INTO roles(id,name) VALUES($1,$1)', [roleId])
    return { actorId, userId, roleId, namespace }
  }

  type Fixture = Awaited<ReturnType<typeof seed>>
  const input = (fixture: Fixture) => ({ actorId: fixture.actorId, userId: fixture.userId, roleId: fixture.roleId, expectedUpdatedAt: null })
  async function count(fixture: Fixture) {
    return Number((await observer.query('SELECT count(*)::integer AS total FROM user_roles WHERE user_id=$1 AND role_id=$2', [fixture.userId, fixture.roleId])).rows[0].total)
  }
  async function blockedBy(waiter: number, holder: number) {
    await until(async () => (await observer.query("SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1", [waiter, holder])).rows[0]?.blocked === true, 'EXPECTED_PHYSICAL_LOCK_WAIT')
  }
  async function control() {
    const client = await observer.connect()
    await client.query('BEGIN')
    const pid = Number((client as PoolClient & { processID: number }).processID)
    return { client, pid, close: async () => { await client.query('ROLLBACK'); client.release() } }
  }
  async function audiences(fixture: Fixture) {
    const integration = (await observer.query("INSERT INTO directory_integrations(org_id,provider,name,status,corp_id,config) VALUES($1,'dingtalk',$1,'active',$1,'{}'::jsonb) RETURNING id", [`role-fixture-${randomUUID()}`])).rows[0].id as string
    integrationIds.push(integration)
    const department = (await observer.query("INSERT INTO directory_departments(integration_id,provider,external_department_id,name,is_active,raw) VALUES($1,'dingtalk',$2,$2,true,'{}'::jsonb) RETURNING id", [integration, `role-fixture-${randomUUID()}`])).rows[0].id as string
    const group = (await observer.query('INSERT INTO platform_member_groups(name) VALUES($1) RETURNING id', [`role-fixture-${randomUUID()}`])).rows[0].id as string
    groupIds.push(group)
    await observer.query('INSERT INTO delegated_role_admin_scopes(admin_user_id,namespace,directory_department_id) VALUES($1,$2,$3)', [fixture.userId, fixture.namespace, department])
    await observer.query('INSERT INTO delegated_role_admin_member_groups(admin_user_id,namespace,group_id) VALUES($1,$2,$3)', [fixture.userId, fixture.namespace, group])
    return async () => (await observer.query('SELECT (SELECT count(*)::integer FROM delegated_role_admin_scopes WHERE admin_user_id=$1) AS departments,(SELECT count(*)::integer FROM delegated_role_admin_member_groups WHERE admin_user_id=$1) AS groups', [fixture.userId])).rows[0]
  }

  it.each(['raw', 'member', 'disabled-member'] as const)('preserves %s actor authority and the registered handler', async (authority) => {
    const fixture = await seed(authority)
    const response = await route(fixture.actorId, fixture.userId, fixture.roleId)
    expect(response.statusCode).toBe(200)
    expect(await count(fixture)).toBe(1)
    expect(state.invalidate).toHaveBeenCalledWith(fixture.userId)
    expect(state.audit).toHaveBeenCalledTimes(1)
  })

  it('refuses an is_admin-only actor without granting a role', async () => {
    const fixture = await seed('none')
    await observer.query('UPDATE users SET is_admin=true WHERE id=$1', [fixture.actorId])
    const response = await route(fixture.actorId, fixture.userId, fixture.roleId)
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } })
    expect(await count(fixture)).toBe(0)
    expect(state.audit).not.toHaveBeenCalled()
    expect(state.invalidate).not.toHaveBeenCalled()
  })

  it.each(['inactive', 'pending'] as const)('keeps %s targets assignable', async (targetState) => {
    const fixture = await seed()
    await observer.query("UPDATE users SET is_active=$2,activation_status=$3 WHERE id=$1", [fixture.userId, targetState !== 'inactive', targetState === 'pending' ? 'pending_activation' : 'activated'])
    expect((await route(fixture.actorId, fixture.userId, fixture.roleId)).statusCode).toBe(200)
    expect(await count(fixture)).toBe(1)
  })

  it('deduplicates actor=target and keeps duplicate assignment a no-op', async () => {
    const fixture = await seed()
    fixture.userId = fixture.actorId
    const first = await assignPlatformUserRoleCommand(input(fixture))
    const second = await assignPlatformUserRoleCommand(input(fixture))
    expect(first).toEqual({ affectedUserIds: [fixture.actorId], rowCount: 1, delegatedAdminScopeCleanup: [] })
    expect(second).toEqual({ affectedUserIds: [], rowCount: 0, delegatedAdminScopeCleanup: [] })
    expect(await count(fixture)).toBe(1)
  })

  it('refuses stale role versions without persisting membership', async () => {
    const fixture = await seed()
    const response = await route(fixture.actorId, fixture.userId, fixture.roleId, { expectedUpdatedAt: '2001-01-01T00:00:00.000Z' })
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({ ok: false, error: { code: 'ROLE_MODIFIED', message: 'This role changed since it was loaded; reload it and re-apply the change', details: { retryable: true } } })
    expect(await count(fixture)).toBe(0)
  })

  it.each(['inactive', 'pending'] as const)('refuses a subsequently %s actor despite the request claim', async (actorState) => {
    const fixture = await seed()
    await observer.query('UPDATE users SET is_active=$2,activation_status=$3 WHERE id=$1', [fixture.actorId, actorState !== 'inactive', actorState === 'pending' ? 'pending_activation' : 'activated'])
    const response = await route(fixture.actorId, fixture.userId, fixture.roleId)
    expect(response.statusCode).toBe(403)
    expect(await count(fixture)).toBe(0)
    expect(state.audit).not.toHaveBeenCalled()
  })

  it('keeps missing and recycled target refusals separate', async () => {
    const fixture = await seed()
    await observer.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [fixture.userId])
    await expect(assignPlatformUserRoleCommand(input(fixture))).rejects.toMatchObject({ code: 'USER_IN_RECYCLE_BIN' })
    await observer.query('DELETE FROM users WHERE id=$1', [fixture.userId])
    await expect(assignPlatformUserRoleCommand(input(fixture))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await count(fixture)).toBe(0)
  })

  it('refuses a deleted action parent even without a membership FK', async () => {
    const fixture = await seed()
    await observer.query('DELETE FROM roles WHERE id=$1', [fixture.roleId])
    await expect(assignPlatformUserRoleCommand(input(fixture))).rejects.toMatchObject({ code: 'ROLE_NOT_FOUND' })
    expect(await count(fixture)).toBe(0)
  })

  it('updates the legacy admin profile even for a duplicate admin appointment', async () => {
    const fixture = await seed()
    await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [fixture.userId])
    const result = await assignPlatformUserRoleCommand({ ...input(fixture), roleId: 'admin' })
    expect(result.rowCount).toBe(0)
    expect((await observer.query('SELECT role,is_admin FROM users WHERE id=$1', [fixture.userId])).rows).toEqual([{ role: 'admin', is_admin: true }])
  })

  it('rolls membership and the legacy profile back together on a post-update SQL-seam failure', async () => {
    const fixture = await seed()
    state.afterSql = async (sql) => { if (/UPDATE users/.test(sql)) throw new Error('SYNTHETIC_PROFILE_FAILURE') }
    await expect(assignPlatformUserRoleCommand({ ...input(fixture), roleId: 'admin' })).rejects.toThrow('SYNTHETIC_PROFILE_FAILURE')
    expect((await observer.query("SELECT role,is_admin,(SELECT count(*)::integer FROM user_roles WHERE user_id=$1 AND role_id='admin') AS memberships FROM users WHERE id=$1", [fixture.userId])).rows).toEqual([{ role: 'user', is_admin: false, memberships: 0 }])
    expect(state.events).not.toContain('COMMIT_CONFIRMED')
  })

  it('clears both stale audiences only on a fresh main-admin appointment', async () => {
    const fixture = await seed('member', true)
    const snapshot = await audiences(fixture)
    const result = await assignPlatformUserRoleCommand(input(fixture))
    expect(result.delegatedAdminScopeCleanup).toEqual([{ userId: fixture.userId, namespace: fixture.namespace, scopeRows: 1, groupScopeRows: 1 }])
    expect(await snapshot()).toEqual({ departments: 0, groups: 0 })
    await audiences(fixture)
    expect((await assignPlatformUserRoleCommand(input(fixture))).rowCount).toBe(0)
    expect(await snapshot()).toEqual({ departments: 1, groups: 1 })
  })

  it('rolls fresh membership and both cleanup tables back after cleanup failure', async () => {
    const fixture = await seed('member', true)
    const snapshot = await audiences(fixture)
    state.afterSql = async (sql) => { if (/DELETE FROM delegated_role_admin_member_groups/.test(sql)) throw new Error('SYNTHETIC_CLEANUP_FAILURE') }
    await expect(assignPlatformUserRoleCommand(input(fixture))).rejects.toThrow('SYNTHETIC_CLEANUP_FAILURE')
    expect(await count(fixture)).toBe(0)
    expect(await snapshot()).toEqual({ departments: 1, groups: 1 })
  })

  it('holds the positive admin child edge until root COMMIT', async () => {
    const fixture = await seed()
    const entered = gate()
    const resume = gate()
    state.afterSql = async (sql) => { if (sql.includes("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'")) { entered.release(); await resume.promise } }
    const pending = outcome(assignPlatformUserRoleCommand(input(fixture)))
    const remover = await control()
    let removal: Promise<unknown> | undefined
    try {
      await entered.promise
      removal = remover.client.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.actorId])
      await blockedBy(remover.pid, state.pids[0])
      expect(await count(fixture)).toBe(0)
    } finally {
      resume.release()
      expect((await pending).ok).toBe(true)
      await removal
      await remover.close()
    }
    expect(await count(fixture)).toBe(1)
  })

  it.each(['COMMIT', 'ROLLBACK'] as const)('rechecks a prior naked actor-edge deletion after %s', async (decision) => {
    const fixture = await seed()
    const remover = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await remover.client.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.actorId])
      pending = outcome(assignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], remover.pid)
      await remover.client.query(decision)
      const result = await pending
      expect(result.ok).toBe(decision === 'ROLLBACK')
      if (!result.ok) expect(result.error).toMatchObject({ code: 'FORBIDDEN' })
      expect(await count(fixture)).toBe(decision === 'ROLLBACK' ? 1 : 0)
    } finally {
      await remover.close()
      await pending
    }
  })

  it('bounds the new member SHARE wait, rolls back, and releases the connection for a later command', async () => {
    const fixture = await seed()
    const remover = await control()
    try {
      await remover.client.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.actorId])
      const pending = route(fixture.actorId, fixture.userId, fixture.roleId)
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], remover.pid)
      const response = await pending
      expect(response.statusCode).toBe(409)
      expect(response.body).toEqual({ ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } })
      expect(state.active).toBe(0)
      expect(await count(fixture)).toBe(0)
      expect(state.audit).not.toHaveBeenCalled()
      await remover.client.query('ROLLBACK')
    } finally {
      await remover.close()
    }
    expect((await assignPlatformUserRoleCommand(input(fixture))).rowCount).toBe(1)
  })

  it('uses the new member window only for that read and restores settings before business writes', async () => {
    const fixture = await seed()
    state.observeSettings = true
    expect((await assignPlatformUserRoleCommand(input(fixture))).rowCount).toBe(1)
    const saved = state.settings.filter(entry => entry.phase === 'saved')
    expect(saved).toHaveLength(2)
    expect(saved[1]).toEqual(saved[0])
    expect(state.settings.filter(entry => entry.phase === 'member')).toEqual([{ phase: 'member', lock_timeout: '5s', statement_timeout: '10s' }])
    expect(state.settings.filter(entry => entry.phase === 'write')).toEqual([{ ...saved[1], phase: 'write' }])
  })

  it.each(['COMMIT', 'ROLLBACK'] as const)('rechecks the raw-admin row after a preceding editor chooses %s', async (decision) => {
    const fixture = await seed('raw')
    const editor = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await editor.client.query("UPDATE users SET role='user' WHERE id=$1", [fixture.actorId])
      pending = outcome(assignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], editor.pid)
      await editor.client.query(decision)
      const result = await pending
      expect(result.ok).toBe(decision === 'ROLLBACK')
      if (!result.ok) expect(result.error).toMatchObject({ code: 'FORBIDDEN' })
      expect(await count(fixture)).toBe(decision === 'ROLLBACK' ? 1 : 0)
    } finally {
      await editor.close()
      await pending
    }
  })

  it('holds a raw-admin row against a later editor until the grant commits', async () => {
    const fixture = await seed('raw')
    const entered = gate()
    const resume = gate()
    state.afterSql = async (sql) => { if (sql.includes('INSERT INTO user_roles')) { entered.release(); await resume.promise } }
    const pending = outcome(assignPlatformUserRoleCommand(input(fixture)))
    const editor = await control()
    let editing: Promise<unknown> | undefined
    try {
      await entered.promise
      editing = editor.client.query("UPDATE users SET role='user' WHERE id=$1", [fixture.actorId])
      await blockedBy(editor.pid, state.pids[0])
      expect(await count(fixture)).toBe(0)
    } finally {
      resume.release()
      expect((await pending).ok).toBe(true)
      await editing
      await editor.close()
    }
    expect(await count(fixture)).toBe(1)
  })

  it('acquires the action parent before either target lock, not only the repeated helper SHARE', async () => {
    const fixture = await seed()
    const parent = await control()
    const probe = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await parent.client.query('SELECT id FROM roles WHERE id=$1 FOR UPDATE', [fixture.roleId])
      pending = outcome(assignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], parent.pid)
      await probe.client.query("SET LOCAL lock_timeout='300ms'")
      await lockNamespaceAdmissionWrites(probe.client, fixture.userId)
      await probe.client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [fixture.userId])
      expect(await count(fixture)).toBe(0)
      await probe.client.query('ROLLBACK')
      await parent.client.query('COMMIT')
      expect((await pending).ok).toBe(true)
    } finally {
      await probe.close()
      await parent.close()
      await pending
    }
  })

  it('keeps an action parent stable against a later editor until COMMIT', async () => {
    const fixture = await seed()
    const entered = gate()
    const resume = gate()
    state.afterSql = async (sql) => { if (sql.includes("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'")) { entered.release(); await resume.promise } }
    const pending = outcome(assignPlatformUserRoleCommand(input(fixture)))
    const editor = await control()
    let editing: Promise<unknown> | undefined
    try {
      await entered.promise
      editing = editor.client.query('UPDATE roles SET updated_at=NOW() WHERE id=$1', [fixture.roleId])
      await blockedBy(editor.pid, state.pids[0])
    } finally {
      resume.release()
      expect((await pending).ok).toBe(true)
      await editing
      await editor.close()
    }
  })

  it.each(['R3', 'R5'] as const)('physically waits on a separately held target %s without writing', async (rank) => {
    const fixture = await seed()
    const blocker = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      if (rank === 'R3') await lockNamespaceAdmissionWrites(blocker.client, fixture.userId)
      else await blocker.client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [fixture.userId])
      pending = outcome(assignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      const observed = await blockedBy(state.pids[0], blocker.pid).then(() => true, () => false)
      expect({ blocked: observed, memberships: await count(fixture) }).toEqual({ blocked: true, memberships: 0 })
      await blocker.client.query('ROLLBACK')
      expect((await pending).ok).toBe(true)
    } finally {
      await blocker.close()
      await pending
    }
  })

  it('serializes reciprocal actor-target commands with complete subject ordering', async () => {
    const first = await seed('raw')
    await observer.query("UPDATE users SET role='admin' WHERE id=$1", [first.userId])
    const results = await Promise.all([
      assignPlatformUserRoleCommand(input(first)),
      assignPlatformUserRoleCommand({ ...input(first), actorId: first.userId, userId: first.actorId }),
    ])
    expect(results.map(result => result.rowCount)).toEqual([1, 1])
    expect((await observer.query('SELECT count(*)::integer AS total FROM user_roles WHERE user_id=ANY($1::text[]) AND role_id=$2', [[first.actorId, first.userId], first.roleId])).rows).toEqual([{ total: 2 }])
  })

  it('makes the real CONSUME role-plan reader wait for the producer and then revalidate', async () => {
    const fixture = await seed()
    const rolePlan = await discoverPrivilegeRolePlan({ query: (sql, params) => observer.query(sql, params) }, [fixture.userId])
    const entered = gate()
    const resume = gate()
    state.afterSql = async (sql) => { if (sql.includes("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'")) { entered.release(); await resume.promise } }
    const writer = outcome(assignPlatformUserRoleCommand(input(fixture)))
    let reader: ReturnType<typeof outcome> | undefined
    try {
      await entered.promise
      reader = outcome(withAuthorizationInputTransaction(rolePlan.lockPlan, tx => revalidatePrivilegeRolePlan(tx, rolePlan)))
      await until(() => state.pids.length > 1, 'READER_NOT_STARTED')
      await blockedBy(state.pids[1], state.pids[0])
    } finally {
      resume.release()
      expect((await writer).ok).toBe(true)
    }
    const result = await reader!
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_STALE' })
    expect(await count(fixture)).toBe(1)
  })

  it('waits for a real CONSUME reader before changing its subject membership', async () => {
    const fixture = await seed()
    const rolePlan = await discoverPrivilegeRolePlan({ query: (sql, params) => observer.query(sql, params) }, [fixture.userId])
    const entered = gate()
    const resume = gate()
    const reader = outcome(withAuthorizationInputTransaction(rolePlan.lockPlan, async tx => {
      await revalidatePrivilegeRolePlan(tx, rolePlan)
      entered.release()
      await resume.promise
    }))
    let writer: ReturnType<typeof outcome> | undefined
    try {
      await entered.promise
      writer = outcome(assignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 1, 'WRITER_NOT_STARTED')
      await blockedBy(state.pids[1], state.pids[0])
      expect(await count(fixture)).toBe(0)
    } finally {
      resume.release()
      expect((await reader).ok).toBe(true)
    }
    expect((await writer!).ok).toBe(true)
  })

  it.each(['unassign', 'batch-update', 'purge', 'protected-role-delete'] as const)('interoperates with the existing %s lock/write fragment, not its full HTTP workflow', async (mode) => {
    const fixture = await seed('member', true)
    const entered = gate()
    const resume = gate()
    let removerPid = 0
    const remover = outcome(other.transaction(async client => {
      removerPid = Number((client.__rawClient as PoolClient & { processID: number }).processID)
      if (mode === 'protected-role-delete') {
        await client.query('SELECT id FROM roles WHERE id=$1 FOR UPDATE', [fixture.roleId])
        await lockNamespaceAdmissionWrites(client, fixture.userId)
      } else {
        if (mode === 'unassign' || mode === 'batch-update') await lockRoleRowForShare(client, fixture.roleId)
        await lockSharedAccessSubjects(client, mode === 'unassign' ? [fixture.actorId, fixture.userId] : [fixture.userId])
      }
      entered.release()
      await resume.promise
      await unassignUserRoles({ userIds: [fixture.userId], roleId: fixture.roleId, scope: { kind: 'platform-admin' }, executor: client })
      if (mode === 'protected-role-delete') {
        await client.query('DELETE FROM role_permissions WHERE role_id=$1', [fixture.roleId])
        await client.query('DELETE FROM roles WHERE id=$1', [fixture.roleId])
      }
    }))
    let writer: ReturnType<typeof outcome> | undefined
    try {
      await entered.promise
      writer = outcome(assignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'WRITER_NOT_STARTED')
      expect(removerPid).toBeGreaterThan(0)
      await blockedBy(state.pids[0], removerPid)
    } finally {
      resume.release()
      expect((await remover).ok).toBe(true)
    }
    const result = await writer!
    expect(result.ok).toBe(mode !== 'protected-role-delete')
    if (!result.ok) expect(result.error).toMatchObject({ code: 'ROLE_NOT_FOUND' })
    expect(await count(fixture)).toBe(mode === 'protected-role-delete' ? 0 : 1)
  })

  it('does not replay a committed write after an injected acknowledgement loss', async () => {
    const fixture = await seed()
    state.failCommitAck = true
    const response = await route(fixture.actorId, fixture.userId, fixture.roleId)
    expect(response.statusCode).toBe(500)
    expect(await count(fixture)).toBe(1)
    expect(state.pids).toHaveLength(1)
    expect(state.audit).not.toHaveBeenCalled()
    expect(state.invalidate).not.toHaveBeenCalled()
  })

  it('does not claim rollback when post-commit readback fails', async () => {
    const fixture = await seed()
    state.failReadback = true
    const response = await route(fixture.actorId, fixture.userId, fixture.roleId)
    expect(response.statusCode).toBe(500)
    expect(await count(fixture)).toBe(1)
    expect(state.audit).toHaveBeenCalledTimes(1)
    expect(state.invalidate).toHaveBeenCalledWith(fixture.userId)
  })
})
