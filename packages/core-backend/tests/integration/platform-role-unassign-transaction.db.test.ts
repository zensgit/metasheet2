import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import type { Request, Response } from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  service: undefined as unknown, pids: [] as number[], events: [] as string[], active: 0,
  failCommitAck: false, failReadback: false, observeSettings: false,
  settings: [] as Array<{ phase: string; lock_timeout: string; statement_timeout: string }>,
  afterSql: undefined as undefined | ((sql: string, params: unknown[] | undefined, pid: number) => Promise<void>),
  audit: vi.fn(), invalidate: vi.fn(),
}))
vi.mock('../../src/integration/db/connection-pool', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  return { ...actual, poolManager: { get: () => {
    const service = (state.service ??= new actual.ConnectionPool({ connectionString: process.env.DATABASE_URL, max: 6, name: 'platform-role-unassign-db' })) as InstanceType<typeof actual.ConnectionPool>
    return {
      getInternalPool: () => service.getInternalPool(),
      query: async (sql: string, params?: unknown[]) => {
        if (state.failReadback && state.events.includes('COMMIT_CONFIRMED')) throw new Error('SYNTHETIC_READBACK_FAILURE')
        return service.query(sql, params)
      },
      transaction: async <Result>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown>; __rawClient: PoolClient }) => Promise<Result>) => {
        state.active += 1
        try {
          const result = await service.transaction(async client => {
            const pid = Number((client.__rawClient as PoolClient & { processID: number }).processID)
            state.pids.push(pid)
            return work({ __rawClient: client.__rawClient, query: async (sql, params) => {
              state.events.push(sql.replace(/\s+/g, ' ').trim())
              const result = await client.query(sql, params)
              if (state.observeSettings) {
                if (sql.includes("current_setting('lock_timeout')")) state.settings.push({ phase: 'saved', ...result.rows[0] } as { phase: string; lock_timeout: string; statement_timeout: string })
                if (sql.includes("role_id = 'admin' FOR SHARE") || /DELETE FROM user_roles/.test(sql)) {
                  const settings = await client.query("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")
                  state.settings.push({ phase: sql.includes('DELETE') ? 'write' : 'member', ...settings.rows[0] } as { phase: string; lock_timeout: string; statement_timeout: string })
                }
              }
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
vi.mock('../../src/rbac/service', async importOriginal => ({ ...await importOriginal<typeof import('../../src/rbac/service')>(), invalidateUserPerms: state.invalidate }))

import { writePlatformNamespaceAdmissionCommand } from '../../src/admin/platform-namespace-admission-command'
import { unassignPlatformUserRoleCommand } from '../../src/admin/platform-role-unassign-command'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { ConnectionPool } from '../../src/integration/db/connection-pool'
import { withAuthorizationInputTransaction } from '../../src/rbac/authorization-input-lock'
import { discoverPrivilegeRolePlan, revalidatePrivilegeRolePlan } from '../../src/rbac/authorization-privilege-witness-plan'
import { lockSharedAccessSubjects } from '../../src/admin/platform-actor-authority'
import { isLastSignInPlatformAdmin, lockPlatformAdminInvariant } from '../../src/admin/user-recycle'
import { lockNamespaceAdmissionWrites } from '../../src/rbac/namespace-admission'
import { unassignUserRoles } from '../../src/rbac/role-assignment'
import { lockRoleRowForShare } from '../../src/admin/role-row-contract'
import { syncLegacyAdminProfile } from '../../src/admin/legacy-admin-profile'

const DATABASE_URL = process.env.DATABASE_URL
if (process.env.EXPECT_DB === '1') it('sentinel: platform role unassignment requires DATABASE_URL', () => expect(DATABASE_URL).toBeTruthy())
const describeWithDatabase = DATABASE_URL ? describe : describe.skip
const busyBody = { ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } }
const ACCEPTED_PLATFORM_ADMIN_COUNT_SQL = `
  SELECT COUNT(*)::int AS c
  FROM users u
  WHERE COALESCE(u.is_active, FALSE) IS TRUE
    AND u.activation_status = 'activated'
    AND u.deleted_at IS NULL
    AND u.purged_at IS NULL
    AND (
      u.role = 'admin'
      OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin')
    )
`
const releases: Array<() => void> = []

function gate() {
  let settled = false
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = () => {
      if (settled) return
      settled = true
      done()
    }
  })
  releases.push(resolve)
  return { promise, release: resolve }
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
function pause(pattern: RegExp) {
  const resume = gate()
  let entered = false
  state.afterSql = async sql => { if (pattern.test(sql)) { entered = true; await resume.promise } }
  return { wait: () => until(() => entered, 'COMMAND_DID_NOT_REACH_PAUSE'), release: resume.release }
}
async function route(actorId: string, userId: string, roleId: string) {
  const layer = adminUsersRouter().stack.find(entry => entry.route?.path === '/api/admin/users/:userId/roles/unassign' && entry.route.methods.post)
  const response = {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  await layer!.route.stack.at(-1)!.handle({ user: { id: actorId, role: 'admin' }, params: { userId }, body: { roleId }, headers: {} } as unknown as Request, response as unknown as Response, () => { throw new Error('UNEXPECTED_NEXT') })
  return response
}

describeWithDatabase('unassign whole-file PostgreSQL proof; registered handler excludes authentication', () => {
  let observer: PgPool
  let other: ConnectionPool
  const userIds: string[] = []
  const roleIds: string[] = []
  const integrationIds: string[] = []
  const groupIds: string[] = []
  const controls: Array<{ close: () => Promise<void> }> = []

  beforeAll(async () => {
    observer = new PgPool({ connectionString: DATABASE_URL, max: 6 })
    other = new ConnectionPool({ connectionString: DATABASE_URL, max: 3, name: 'platform-role-unassign-competitor' })
    expect((await observer.query("SELECT id FROM roles WHERE id='admin'")).rows).toEqual([{ id: 'admin' }])
    expect((await observer.query(ACCEPTED_PLATFORM_ADMIN_COUNT_SQL)).rows).toEqual([{ c: 0 }])
    expect((await observer.query("SELECT count(*)::int AS total FROM pg_constraint WHERE conrelid='user_roles'::regclass AND contype='f'")).rows).toEqual([{ total: 0 }])
  })
  beforeEach(async () => {
    expect(state.active).toBe(0)
    expect((await observer.query(ACCEPTED_PLATFORM_ADMIN_COUNT_SQL)).rows).toEqual([{ c: 0 }])
    state.pids = []; state.events = []; state.settings = []
    state.afterSql = undefined; state.failCommitAck = false; state.failReadback = false; state.observeSettings = false
    state.audit.mockReset().mockImplementation(async () => {
      expect(state.active).toBe(0)
      expect(state.events).toContain('COMMIT_CONFIRMED')
      state.events.push('audit')
    })
    state.invalidate.mockReset().mockImplementation(() => {
      expect(state.active).toBe(0)
      expect(state.events).toContain('COMMIT_CONFIRMED')
      state.events.push('invalidate')
    })
  })
  afterEach(async () => {
    state.afterSql = undefined
    for (const release of releases.splice(0)) release()
    for (const handle of controls.splice(0)) await handle.close()
    const deadline = Date.now() + 1000
    while (state.active !== 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const ownedUsers = [...userIds]
    const ownedRoles = [...roleIds]
    const ownedIntegrations = [...integrationIds]
    const ownedGroups = [...groupIds]
    const cleanupErrors: unknown[] = []
    const cleanups: Array<[string, unknown[]]> = [
      ['DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[])', [ownedUsers]],
      ['DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = ANY($1::text[])', [ownedUsers]],
      ['DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ownedUsers]],
      ['DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [ownedUsers]],
      ['DELETE FROM directory_departments WHERE integration_id = ANY($1::uuid[])', [ownedIntegrations]],
      ['DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [ownedIntegrations]],
      ['DELETE FROM platform_member_groups WHERE id = ANY($1::uuid[])', [ownedGroups]],
      ['DELETE FROM users WHERE id = ANY($1::text[])', [ownedUsers]],
      ["DELETE FROM roles WHERE id = ANY($1::text[]) AND id <> 'admin'", [ownedRoles]],
    ]
    const cleaner = await observer.connect()
    try {
      await cleaner.query("SET lock_timeout = '2s'")
      for (const [sql, params] of cleanups) {
        try { await cleaner.query(sql, params) } catch (error) { cleanupErrors.push(error) }
      }
    } finally {
      await cleaner.query('RESET lock_timeout').catch(() => undefined)
      cleaner.release()
    }
    if (cleanupErrors.length === 0) {
      userIds.length = 0; roleIds.length = 0; integrationIds.length = 0; groupIds.length = 0
    }
    expect(state.active).toBe(0)
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
    expect((await observer.query(ACCEPTED_PLATFORM_ADMIN_COUNT_SQL)).rows).toEqual([{ c: 0 }])
    expect((await observer.query("SELECT id FROM roles WHERE id='admin'")).rows).toEqual([{ id: 'admin' }])
  })
  afterAll(async () => {
    if (state.service) await (state.service as ConnectionPool).getInternalPool().end()
    await other?.getInternalPool().end()
    await observer?.end()
  })

  async function seed(authority: 'raw' | 'member' | 'disabled-member' | 'none' = 'member') {
    const actorId = `p1e-actor-${randomUUID()}`
    const userId = `p1e-target-${randomUUID()}`
    const namespace = `p1e${randomUUID().replaceAll('-', '')}`
    const roleId = `${namespace}_admin`
    userIds.push(actorId, userId)
    roleIds.push(roleId)
    for (const id of [actorId, userId]) {
      const rawRole = id === actorId && authority === 'raw' ? 'admin' : id === actorId && authority === 'disabled-member' ? 'disabled' : 'user'
      await observer.query("INSERT INTO users(id,username,name,password_hash,is_active,is_admin,role,permissions,activation_status,local_password_set) VALUES($1,$1,'Synthetic unassign fixture','synthetic-unused',true,false,$2,'[]'::jsonb,'activated',false)", [id, rawRole])
    }
    if (authority === 'member' || authority === 'disabled-member') await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [actorId])
    await observer.query('INSERT INTO roles(id,name) VALUES($1,$1)', [roleId])
    await observer.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [userId, roleId])
    return { actorId, userId, roleId, namespace }
  }
  type Fixture = Awaited<ReturnType<typeof seed>>
  const input = (fixture: Fixture) => ({ actorId: fixture.actorId, userId: fixture.userId, roleId: fixture.roleId })
  async function count(fixture: Fixture) {
    return Number((await observer.query('SELECT count(*)::int AS total FROM user_roles WHERE user_id=$1 AND role_id=$2', [fixture.userId, fixture.roleId])).rows[0].total)
  }
  async function blockedBy(waiter: number, holder: number) {
    await until(async () => (await observer.query("SELECT wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1", [waiter, holder])).rows[0]?.blocked === true, 'EXPECTED_PHYSICAL_LOCK_WAIT')
  }
  async function control() {
    const client = await observer.connect()
    await client.query('BEGIN')
    const pid = Number((client as PoolClient & { processID: number }).processID)
    let closed = false
    const handle = {
      client,
      pid,
      close: async () => {
        if (closed) return
        closed = true
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      },
    }
    controls.push(handle)
    return handle
  }
  async function audiences(fixture: Fixture) {
    const integration = (await observer.query("INSERT INTO directory_integrations(org_id,provider,name,status,corp_id,config) VALUES($1,'dingtalk',$1,'active',$1,'{}'::jsonb) RETURNING id", [`p1e-${randomUUID()}`])).rows[0].id as string
    integrationIds.push(integration)
    const department = (await observer.query("INSERT INTO directory_departments(integration_id,provider,external_department_id,name,is_active,raw) VALUES($1,'dingtalk',$2,$2,true,'{}'::jsonb) RETURNING id", [integration, `p1e-${randomUUID()}`])).rows[0].id as string
    const group = (await observer.query('INSERT INTO platform_member_groups(name) VALUES($1) RETURNING id', [`p1e-${randomUUID()}`])).rows[0].id as string
    groupIds.push(group)
    await observer.query('INSERT INTO delegated_role_admin_scopes(admin_user_id,namespace,directory_department_id) VALUES($1,$2,$3)', [fixture.userId, fixture.namespace, department])
    await observer.query('INSERT INTO delegated_role_admin_member_groups(admin_user_id,namespace,group_id) VALUES($1,$2,$3)', [fixture.userId, fixture.namespace, group])
    await observer.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source) VALUES($1,$2,true,'synthetic')", [fixture.userId, fixture.namespace])
    return async () => (await observer.query('SELECT (SELECT count(*)::int FROM delegated_role_admin_scopes WHERE admin_user_id=$1) AS departments,(SELECT count(*)::int FROM delegated_role_admin_member_groups WHERE admin_user_id=$1) AS groups,(SELECT enabled FROM user_namespace_admissions WHERE user_id=$1 AND namespace=$2) AS enabled', [fixture.userId, fixture.namespace])).rows[0]
  }
  async function selfAdmin(rawRole: string = 'user') {
    const fixture = await seed('none')
    await observer.query('UPDATE users SET role=$2 WHERE id=$1', [fixture.actorId, rawRole])
    await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [fixture.actorId])
    return { ...fixture, userId: fixture.actorId, roleId: 'admin' }
  }

  it.each(['raw', 'member', 'disabled-member'] as const)('preserves %s actor authority, root effects and exact changed result', async authority => {
    const fixture = await seed(authority)
    const response = await route(fixture.actorId, fixture.userId, fixture.roleId)
    expect(response).toMatchObject({ statusCode: 200, body: { ok: true, data: { changedRoleId: fixture.roleId, actorId: fixture.actorId, roleHeld: false, membershipChanged: true } } })
    expect(await count(fixture)).toBe(0)
    expect(state.invalidate).toHaveBeenCalledWith(fixture.userId)
    expect(state.audit).toHaveBeenCalledTimes(1)
  })

  it.each(['inactive', 'pending', 'recycled', 'purged', 'is-admin-only'] as const)('rejects %s actor with a passing command baseline', async actorState => {
    const fixture = await seed()
    expect(await unassignPlatformUserRoleCommand(input(fixture))).toMatchObject({ blocked: false })
    await observer.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [fixture.userId, fixture.roleId])
    if (actorState === 'is-admin-only') {
      await observer.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.actorId])
      await observer.query('UPDATE users SET is_admin=true WHERE id=$1', [fixture.actorId])
    } else {
      await observer.query("UPDATE users SET is_active=$2,activation_status=$3,deleted_at=$4,purged_at=$5 WHERE id=$1", [fixture.actorId, actorState !== 'inactive', actorState === 'pending' ? 'pending_activation' : 'activated', actorState === 'recycled' ? new Date() : null, actorState === 'purged' ? new Date() : null])
    }
    state.events = []
    await expect(unassignPlatformUserRoleCommand(input(fixture))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await count(fixture)).toBe(1)
    expect(state.events.some(event => /DELETE FROM user_roles/.test(event))).toBe(false)
  })

  it.each(['inactive', 'pending'] as const)('still writes a %s target', async targetState => {
    const fixture = await seed()
    await observer.query('UPDATE users SET is_active=$2,activation_status=$3 WHERE id=$1', [fixture.userId, targetState !== 'inactive', targetState === 'pending' ? 'pending_activation' : 'activated'])
    expect(await unassignPlatformUserRoleCommand(input(fixture))).toMatchObject({ membership: { rowCount: 1 } })
  })

  it('retains missing and recycled target refusal before actor authority', async () => {
    const fixture = await seed('none')
    await observer.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [fixture.userId])
    await expect(unassignPlatformUserRoleCommand(input(fixture))).rejects.toMatchObject({ code: 'USER_IN_RECYCLE_BIN' })
    await observer.query('DELETE FROM users WHERE id=$1', [fixture.userId])
    await expect(unassignPlatformUserRoleCommand(input(fixture))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await count(fixture)).toBe(1)
  })

  it('preserves accepted raw disabled self and the stricter disabled-backup predicate', async () => {
    const fixture = await selfAdmin('disabled')
    expect(await unassignPlatformUserRoleCommand(input(fixture))).toEqual({ blocked: true })
    const backupId = userIds.find(id => id !== fixture.actorId)!
    await observer.query("UPDATE users SET role='disabled' WHERE id=$1", [backupId])
    await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [backupId])
    expect(await unassignPlatformUserRoleCommand(input(fixture))).toEqual({ blocked: true })
    await observer.query("UPDATE users SET role='user' WHERE id=$1", [backupId])
    expect(await unassignPlatformUserRoleCommand(input(fixture))).toMatchObject({ blocked: false, membership: { rowCount: 1 } })
    expect((await observer.query('SELECT role,is_admin FROM users WHERE id=$1', [fixture.userId])).rows).toEqual([{ role: 'disabled', is_admin: false }])
  })

  it('rejects SQL NULL storage in users.role on an owned fixture and keeps the prior role and membership', async () => {
    const fixture = await seed('none')
    await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [fixture.actorId])
    expect((await observer.query('SELECT role FROM users WHERE id=$1', [fixture.actorId])).rows).toEqual([{ role: 'user' }])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
    await expect(observer.query('UPDATE users SET role = NULL WHERE id=$1', [fixture.actorId])).rejects.toMatchObject({ code: '23502' })
    expect((await observer.query('SELECT role FROM users WHERE id=$1', [fixture.actorId])).rows).toEqual([{ role: 'user' }])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
  })

  it('allows only one concurrent two-admin self removal and upgrades its own child SHARE without deadlock', async () => {
    const fixture = await selfAdmin()
    const secondId = userIds.find(id => id !== fixture.actorId)!
    await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [secondId])
    const results = await Promise.all([
      unassignPlatformUserRoleCommand(input(fixture)),
      unassignPlatformUserRoleCommand({ actorId: secondId, userId: secondId, roleId: 'admin' }),
    ])
    expect(results.filter(result => result.blocked)).toEqual([{ blocked: true }])
    expect(results.filter(result => !result.blocked)).toHaveLength(1)
    expect((await observer.query("SELECT count(*)::int AS total FROM user_roles WHERE user_id=ANY($1::text[]) AND role_id='admin'", [userIds])).rows).toEqual([{ total: 1 }])
  })

  it('physically waits at R1 before acquiring any parent or actor/target subjects', async () => {
    const fixture = await selfAdmin()
    const blocker = await control()
    const probe = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await lockPlatformAdminInvariant(blocker.client)
      pending = outcome(unassignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], blocker.pid)
      await probe.client.query("SET LOCAL lock_timeout='300ms'")
      await probe.client.query("SELECT id FROM roles WHERE id='admin' FOR UPDATE")
      for (const id of [...userIds].sort()) {
        await lockNamespaceAdmissionWrites(probe.client, id)
        await probe.client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id])
      }
      expect(state.events.some(event => /FROM roles|FROM users/.test(event))).toBe(false)
      await probe.client.query('ROLLBACK')
      await blocker.client.query('ROLLBACK')
      expect(await pending).toEqual({ ok: true, value: { blocked: true } })
    } finally {
      await probe.close(); await blocker.close(); await pending
    }
  })

  it('returns exact BUSY before LAST under a controlled admin-parent blocker', async () => {
    const fixture = await selfAdmin()
    const blocker = await control()
    let pending: ReturnType<typeof route> | undefined
    try {
      const held = await blocker.client.query("SELECT id FROM roles WHERE id='admin' FOR UPDATE")
      expect(held.rows).toHaveLength(1)
      pending = route(fixture.actorId, fixture.userId, 'admin')
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], blocker.pid)
      expect(await pending).toMatchObject({ statusCode: 409, body: busyBody })
      expect(state.events.some(event => event.includes('AS is_sign_in_admin'))).toBe(false)
      expect(await count(fixture)).toBe(1)
      expect(state.audit).not.toHaveBeenCalled()
      expect(state.invalidate).not.toHaveBeenCalled()
    } finally {
      await blocker.close(); await pending
    }
    expect(await route(fixture.actorId, fixture.userId, 'admin')).toMatchObject({ statusCode: 409, body: { ok: false, error: { code: 'LAST_PLATFORM_ADMIN', message: '至少保留一名可登录的平台管理员' } } })
  })

  it('removes a missing-parent orphan while a committed new parent stays held FOR UPDATE', async () => {
    const fixture = await seed()
    await observer.query('DELETE FROM roles WHERE id=$1', [fixture.roleId])
    const paused = pause(/ORDER BY role_id ASC/)
    const pending = outcome(unassignPlatformUserRoleCommand(input(fixture)))
    const holder = await control()
    const probe = await control()
    try {
      await paused.wait()
      expect(state.events.filter(event => /FROM roles/.test(event))).toHaveLength(1)
      await observer.query('INSERT INTO roles(id,name) VALUES($1,$1)', [fixture.roleId])
      expect((await holder.client.query('SELECT id FROM roles WHERE id=$1 FOR UPDATE', [fixture.roleId])).rows).toHaveLength(1)
      paused.release()
      const result = await pending
      expect(result.ok).toBe(true)
      expect(await count(fixture)).toBe(0)
      expect(state.events.filter(event => /FROM roles/.test(event))).toHaveLength(1)
      await probe.client.query("SET LOCAL lock_timeout='300ms'")
      await expect(probe.client.query('SELECT id FROM roles WHERE id=$1 FOR SHARE', [fixture.roleId])).rejects.toMatchObject({ code: '55P03' })
    } finally {
      paused.release()
      await probe.close()
      await holder.close()
      await pending
    }
  })

  it.each(['parent', 'R3', 'R5'] as const)('physically blocks on the independently held target %s before business DELETE', async rank => {
    const fixture = await seed()
    const blocker = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      if (rank === 'parent') await blocker.client.query('SELECT id FROM roles WHERE id=$1 FOR UPDATE', [fixture.roleId])
      else if (rank === 'R3') await lockNamespaceAdmissionWrites(blocker.client, fixture.userId)
      else await blocker.client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [fixture.userId])
      pending = outcome(unassignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], blocker.pid)
      expect(await count(fixture)).toBe(1)
      expect(state.events.some(event => /DELETE FROM user_roles/.test(event))).toBe(false)
      if (rank === 'parent') {
        const probe = await control()
        try {
          await probe.client.query("SET LOCAL lock_timeout='300ms'")
          await lockNamespaceAdmissionWrites(probe.client, fixture.userId)
          await probe.client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [fixture.userId])
        } finally { await probe.close() }
      }
      await blocker.client.query('ROLLBACK')
      expect((await pending).ok).toBe(true)
    } finally { await blocker.close(); await pending }
  })

  it.each(['parent', 'child', 'raw-row'] as const)('keeps the positive %s lock until root COMMIT', async mode => {
    const fixture = await seed(mode === 'raw-row' ? 'raw' : 'member')
    const paused = pause(/DELETE FROM user_roles/)
    const pending = outcome(unassignPlatformUserRoleCommand(input(fixture)))
    const editor = await control()
    let editing: Promise<unknown> | undefined
    try {
      await paused.wait()
      editing = mode === 'parent'
        ? editor.client.query('UPDATE roles SET updated_at=NOW() WHERE id=$1', [fixture.roleId])
        : mode === 'child' ? editor.client.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.actorId])
          : editor.client.query("UPDATE users SET role='user' WHERE id=$1", [fixture.actorId])
      await blockedBy(editor.pid, state.pids[0])
      expect(await count(fixture)).toBe(1)
    } finally {
      paused.release(); expect((await pending).ok).toBe(true); await editing; await editor.close()
    }
    expect(await count(fixture)).toBe(0)
  })

  it.each(['COMMIT', 'ROLLBACK'] as const)('rereads the blocked member edge after prior naked deletion chooses %s', async decision => {
    const fixture = await seed()
    const remover = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await remover.client.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.actorId])
      pending = outcome(unassignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], remover.pid)
      await remover.client.query(decision)
      const result = await pending
      expect(result.ok).toBe(decision === 'ROLLBACK')
      if (!result.ok) expect(result.error).toMatchObject({ code: 'FORBIDDEN' })
      expect(await count(fixture)).toBe(decision === 'COMMIT' ? 1 : 0)
    } finally { await remover.close(); await pending }
  })

  it.each(['COMMIT', 'ROLLBACK'] as const)('rereads a prior raw-admin edit after %s', async decision => {
    const fixture = await seed('raw')
    const editor = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await editor.client.query("UPDATE users SET role='user' WHERE id=$1", [fixture.actorId])
      pending = outcome(unassignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], editor.pid)
      await editor.client.query(decision)
      const result = await pending
      expect(result.ok).toBe(decision === 'ROLLBACK')
      if (!result.ok) expect(result.error).toMatchObject({ code: 'FORBIDDEN' })
      expect(await count(fixture)).toBe(decision === 'COMMIT' ? 1 : 0)
    } finally { await editor.close(); await pending }
  })

  it('sets the 5s/10s child-only window and restores actual settings before DELETE', async () => {
    const fixture = await seed()
    state.observeSettings = true
    await unassignPlatformUserRoleCommand(input(fixture))
    const saved = state.settings.filter(entry => entry.phase === 'saved')
    expect(saved).toHaveLength(2)
    expect(saved[1]).toEqual(saved[0])
    expect(state.settings.filter(entry => entry.phase === 'member')).toEqual([{ phase: 'member', lock_timeout: '5s', statement_timeout: '10s' }])
    expect(state.settings.filter(entry => entry.phase === 'write')).toEqual([{ ...saved[1], phase: 'write' }])
  })

  it.each(['producer-first', 'consumer-first'] as const)('physically serializes the actual CONSUME reader %s', async order => {
    const fixture = await seed()
    const rolePlan = await discoverPrivilegeRolePlan({ query: (sql, params) => observer.query(sql, params) }, [fixture.userId])
    const resume = gate()
    let readerEntered = false
    let producer: ReturnType<typeof outcome> | undefined
    let consumer: ReturnType<typeof outcome> | undefined
    const paused = order === 'producer-first' ? pause(/DELETE FROM user_roles/) : undefined
    try {
      if (paused) {
        producer = outcome(unassignPlatformUserRoleCommand(input(fixture)))
        await paused.wait()
        consumer = outcome(withAuthorizationInputTransaction(rolePlan.lockPlan, tx => revalidatePrivilegeRolePlan(tx, rolePlan)))
      } else {
        consumer = outcome(withAuthorizationInputTransaction(rolePlan.lockPlan, async tx => { await revalidatePrivilegeRolePlan(tx, rolePlan); readerEntered = true; await resume.promise }))
        await until(() => readerEntered, 'CONSUMER_NOT_READY')
        producer = outcome(unassignPlatformUserRoleCommand(input(fixture)))
      }
      await until(() => state.pids.length > 1, 'SECOND_TRANSACTION_NOT_STARTED')
      await blockedBy(state.pids[1], state.pids[0])
      expect(await count(fixture)).toBe(1)
    } finally {
      paused?.release(); resume.release()
      if (producer) expect((await producer).ok).toBe(true)
      if (consumer) {
        const result = await consumer
        expect(result.ok).toBe(order === 'consumer-first')
        if (!result.ok) expect(result.error).toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_STALE' })
      }
    }
    expect(await count(fixture)).toBe(0)
  })

  it('atomically removes membership, both audience tables and admission before post-commit effects', async () => {
    const fixture = await seed()
    const snapshot = await audiences(fixture)
    const paused = pause(/INSERT INTO user_namespace_admissions/)
    const pending = outcome(route(fixture.actorId, fixture.userId, fixture.roleId))
    try {
      await paused.wait()
      expect(await count(fixture)).toBe(1)
      expect(await snapshot()).toEqual({ departments: 1, groups: 1, enabled: true })
      expect(state.audit).not.toHaveBeenCalled()
      expect(state.invalidate).not.toHaveBeenCalled()
    } finally { paused.release() }
    const result = await pending
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toMatchObject({ statusCode: 200 })
    expect(await count(fixture)).toBe(0)
    expect(await snapshot()).toEqual({ departments: 0, groups: 0, enabled: false })
    expect(state.events.filter(event => ['COMMIT_CONFIRMED', 'audit', 'invalidate'].includes(event))).toEqual(['COMMIT_CONFIRMED', 'audit', 'invalidate', 'audit'])
  })

  it.each(['DELETE FROM delegated_role_admin_member_groups', 'INSERT INTO user_namespace_admissions'])('rolls membership, both audiences and admission back after %s', async fail => {
    const fixture = await seed()
    const snapshot = await audiences(fixture)
    state.afterSql = async sql => { if (sql.includes(fail)) throw new Error('SYNTHETIC_ATOMIC_FAILURE') }
    await expect(unassignPlatformUserRoleCommand(input(fixture))).rejects.toThrow('SYNTHETIC_ATOMIC_FAILURE')
    expect(await count(fixture)).toBe(1)
    expect(await snapshot()).toEqual({ departments: 1, groups: 1, enabled: true })
    expect(state.events).not.toContain('COMMIT_CONFIRMED')
  })

  it('rolls membership and legacy demotion back together, then preserves zero-row legacy demotion', async () => {
    const fixture = await seed()
    await observer.query("UPDATE users SET role='admin',is_admin=true WHERE id=$1", [fixture.userId])
    await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [fixture.userId])
    fixture.roleId = 'admin'
    state.afterSql = async sql => { if (/UPDATE users/.test(sql)) throw new Error('SYNTHETIC_LEGACY_FAILURE') }
    await expect(unassignPlatformUserRoleCommand(input(fixture))).rejects.toThrow('SYNTHETIC_LEGACY_FAILURE')
    expect(await count(fixture)).toBe(1)
    expect((await observer.query('SELECT role,is_admin FROM users WHERE id=$1', [fixture.userId])).rows).toEqual([{ role: 'admin', is_admin: true }])
    state.afterSql = undefined
    await observer.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.userId])
    expect(await unassignPlatformUserRoleCommand(input(fixture))).toMatchObject({ blocked: false, membership: { rowCount: 0 } })
    expect((await observer.query('SELECT role,is_admin FROM users WHERE id=$1', [fixture.userId])).rows).toEqual([{ role: 'user', is_admin: false }])
  })

  it('records zero-row attendance opt-out while preserving existing enabled admission and false insertion', async () => {
    const fixture = await seed()
    await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'attendance_manager')", [fixture.userId])
    await observer.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source) VALUES($1,'attendance',true,'synthetic')", [fixture.userId])
    fixture.roleId = 'attendance_employee'
    const result = await unassignPlatformUserRoleCommand(input(fixture))
    expect(result).toEqual({ blocked: false, membership: { affectedUserIds: [], rowCount: 0, delegatedAdminScopeCleanup: [] }, disabledNamespaces: [] })
    expect((await observer.query("SELECT enabled,source FROM user_namespace_admissions WHERE user_id=$1 AND namespace='attendance'", [fixture.userId])).rows).toEqual([{ enabled: true, source: 'role_unassigned' }])
    await observer.query("DELETE FROM user_namespace_admissions WHERE user_id=$1 AND namespace='attendance'", [fixture.userId])
    await unassignPlatformUserRoleCommand(input(fixture))
    expect((await observer.query("SELECT enabled,source FROM user_namespace_admissions WHERE user_id=$1 AND namespace='attendance'", [fixture.userId])).rows).toEqual([{ enabled: false, source: 'role_unassigned' }])
  })

  it('waits for the platform namespace admission command to commit before revoking the role', async () => {
    const fixture = await seed('raw')
    const paused = pause(/INSERT INTO user_namespace_admissions/)
    const admission = outcome(writePlatformNamespaceAdmissionCommand({
      actorId: fixture.actorId,
      userId: fixture.userId,
      namespace: fixture.namespace,
      enabled: false,
    }))
    let revoke: ReturnType<typeof outcome> | undefined
    try {
      await paused.wait()
      revoke = outcome(unassignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 1, 'SECOND_TRANSACTION_NOT_STARTED')
      await blockedBy(state.pids[1], state.pids[0])
      expect(await count(fixture)).toBe(1)
    } finally {
      paused.release()
      expect((await admission).ok).toBe(true)
    }
    expect((await revoke!).ok).toBe(true)
    expect(await count(fixture)).toBe(0)
  })

  it.each(['status-disable', 'recycle-move', 'delegated-demotion', 'protected-role-delete'] as const)('waits behind source-pinned %s lock/write fragment, not a whole HTTP competitor', async mode => {
    const source = readFileSync(new URL(mode === 'recycle-move' ? '../../src/admin/user-recycle.ts' : mode === 'protected-role-delete' ? '../../src/routes/roles.ts' : '../../src/routes/admin-users.ts', import.meta.url), 'utf8')
    // The credential-revocation schema changes purge handling. Both source versions have the same recycle-move implementation.
    const expectedPins = mode === 'recycle-move' ? [
      'ab484e7a910dcadfd761468b32f9211fa307842cc0a07885ac34f285e9c6551d',
      'ee591b541b631d09161d528912ff068f4872848db9dd51fe4ca01b1509a222bf',
    ] : mode === 'protected-role-delete' ? ['144b83d990585cfdfbad609e0d55a305db65b1d3769c7da0347e94d89cf98ba1'] : undefined
    if (expectedPins) expect(expectedPins).toContain(createHash('sha256').update(source).digest('hex'))
    else expect(source).toContain(mode === 'status-disable' ? 'if (isActive === false) await lockPlatformAdminInvariant(client)' : "if (action === 'unassign' && roleId === PLATFORM_ADMIN_ROLE_ID)")
    const fixture = await seed('raw')
    if (mode === 'status-disable' || mode === 'recycle-move' || mode === 'delegated-demotion') {
      await observer.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [fixture.userId])
      fixture.roleId = 'admin'
    }
    const entered = gate()
    const resume = gate()
    let holder = 0
    let acquired = false
    const competitor = outcome(other.transaction(async client => {
      holder = Number((client.__rawClient as PoolClient & { processID: number }).processID)
      if (mode === 'protected-role-delete') {
        await client.query('SELECT id FROM roles WHERE id=$1 FOR UPDATE', [fixture.roleId])
        await lockNamespaceAdmissionWrites(client, fixture.userId)

      } else {
        await lockPlatformAdminInvariant(client)
        if (mode === 'delegated-demotion') {
          expect(await isLastSignInPlatformAdmin(client, fixture.userId)).toBe(false)
          await lockRoleRowForShare(client, fixture.roleId)
        }
        await lockSharedAccessSubjects(client, mode === 'recycle-move' ? [fixture.userId] : [fixture.actorId, fixture.userId])
        if (mode !== 'delegated-demotion') expect(await isLastSignInPlatformAdmin(client, fixture.userId)).toBe(false)
      }
      acquired = true; entered.release()
      await resume.promise
      if (mode === 'status-disable') await client.query('UPDATE users SET is_active=false WHERE id=$1', [fixture.userId])
      else if (mode === 'recycle-move') await client.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [fixture.userId])
      else {
        await unassignUserRoles({ userIds: [fixture.userId], roleId: fixture.roleId, scope: { kind: 'platform-admin' }, executor: client })
        if (mode === 'delegated-demotion') await syncLegacyAdminProfile(fixture.userId, false, (sql, params) => client.query(sql, params))
        else { await client.query('DELETE FROM role_permissions WHERE role_id=$1', [fixture.roleId]); await client.query('DELETE FROM roles WHERE id=$1', [fixture.roleId]) }
      }
    }))
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await until(() => acquired, 'COMPETITOR_NOT_READY')
      await entered.promise
      pending = outcome(unassignPlatformUserRoleCommand(input(fixture)))
      await until(() => state.pids.length > 0, 'COMMAND_NOT_STARTED')
      await blockedBy(state.pids[0], holder)
    } finally { resume.release(); expect((await competitor).ok).toBe(true) }
    const result = await pending!
    expect(result.ok).toBe(mode !== 'recycle-move')
    if (!result.ok) expect(result.error).toMatchObject({ code: 'USER_IN_RECYCLE_BIN' })
    expect(await count(fixture)).toBe(mode === 'recycle-move' ? 1 : 0)
  })

  it.each(['acknowledgement', 'readback'] as const)('keeps committed revoke after %s failure without replay', async mode => {
    const fixture = await seed()
    state.failCommitAck = mode === 'acknowledgement'
    state.failReadback = mode === 'readback'
    expect(await route(fixture.actorId, fixture.userId, fixture.roleId)).toMatchObject({ statusCode: 500, body: { ok: false, error: { code: 'ROLE_UNASSIGN_FAILED', message: 'Failed to unassign role' } } })
    expect(await count(fixture)).toBe(0)
    expect(state.pids).toHaveLength(1)
    expect(state.audit).toHaveBeenCalledTimes(mode === 'acknowledgement' ? 0 : 1)
    expect(state.invalidate).toHaveBeenCalledTimes(mode === 'acknowledgement' ? 0 : 1)
  })
})
