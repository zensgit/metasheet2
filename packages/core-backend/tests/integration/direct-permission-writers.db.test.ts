import { randomUUID } from 'node:crypto'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import type { Request, Response } from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  service: undefined as unknown,
  afterSql: undefined as undefined | ((sql: string, params: unknown[] | undefined, client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, pid: number) => Promise<void>),
  pids: [] as number[],
  events: [] as string[],
  active: 0,
  invalidations: [] as string[],
  confirmedUserIds: new Set<string>(),
}))

vi.mock('../../src/integration/db/connection-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  const get = () => {
    const service = (state.service ??= new actual.ConnectionPool({ connectionString: process.env.DATABASE_URL, max: 6, name: 'direct-permission-writers-db' })) as InstanceType<typeof actual.ConnectionPool>
    return {
      getInternalPool: () => service.getInternalPool(),
      query: service.query.bind(service),
      transaction: async <Result>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown>; __rawClient: PoolClient }) => Promise<Result>) => {
        state.active += 1
        const writtenUsers = new Set<string>()
        try {
          const result = await service.transaction(async (client) => {
            const pid = Number((client.__rawClient as PoolClient & { processID: number }).processID)
            state.pids.push(pid)
            return work({
              __rawClient: client.__rawClient,
              query: async (sql, params) => {
                const result = await client.query(sql, params)
                if (/(?:INSERT INTO|DELETE FROM) user_permissions/.test(sql) && typeof params?.[0] === 'string') writtenUsers.add(params[0])
                state.events.push(sql.replace(/\s+/g, ' ').trim())
                await state.afterSql?.(sql, params, client, pid)
                return result
              },
            })
          })
          state.events.push('COMMIT_CONFIRMED')
          for (const userId of writtenUsers) state.confirmedUserIds.add(userId)
          return result
        } finally {
          state.active -= 1
        }
      },
    }
  }
  return { ...actual, poolManager: { get } }
})
vi.mock('../../src/middleware/auth', () => ({ authenticate: () => { throw new Error('HANDLER_SEAM_NOT_AUTH_E2E') } }))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))
vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return { ...actual, invalidateUserPerms: (userId: string) => {
    expect(state.confirmedUserIds.has(userId)).toBe(true)
    state.invalidations.push(userId)
    actual.invalidateUserPerms(userId)
  } }
})

import { permissionsRouter } from '../../src/routes/permissions'
import { writeLegacyAuthorizationException } from '../../src/admin/authorization-exception-compat'
import { ConnectionPool } from '../../src/integration/db/connection-pool'
import { withAuthorizationInputTransaction } from '../../src/rbac/authorization-input-lock'
import { lockSharedAccessSubjects } from '../../src/admin/platform-actor-authority'
import { unassignUserRoles } from '../../src/rbac/role-assignment'

const DATABASE_URL = process.env.DATABASE_URL
if (process.env.EXPECT_DB === '1') it('sentinel: direct permission writers require DATABASE_URL', () => expect(DATABASE_URL).toBeTruthy())
const describeWithDatabase = DATABASE_URL ? describe : describe.skip
type RouteKind = 'grant' | 'revoke' | 'template'
const paths = { grant: '/api/permissions/grant', revoke: '/api/permissions/revoke', template: '/api/admin/permission-templates/apply' }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function invoke(kind: RouteKind, actorId: string, userId: unknown, permission: string, templateId = 'attendance-employee') {
  const router = permissionsRouter()
  const route = router.stack.find((layer) => layer.route?.path === paths[kind] && layer.route.methods.post)
  const handler = route?.route?.stack.at(-1)?.handle
  if (!handler) throw new Error('DIRECT_PERMISSION_HANDLER_MISSING')
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  await handler({ user: { id: actorId }, body: { userId, permission, templateId } } as Request, response as unknown as Response, () => { throw new Error('UNEXPECTED_NEXT') })
  return response
}

describeWithDatabase('direct permission writers (actual PostgreSQL commands and handler seam)', () => {
  let observer: PgPool
  let other: ConnectionPool
  const userIds: string[] = []
  const permissionCodes: string[] = []

  beforeAll(() => {
    observer = new PgPool({ connectionString: DATABASE_URL, max: 4 })
    other = new ConnectionPool({ connectionString: DATABASE_URL, max: 3, name: 'direct-permission-competing-writer' })
  })
  beforeEach(() => {
    state.afterSql = undefined
    state.pids = []
    state.events = []
    state.invalidations = []
    state.confirmedUserIds.clear()
    expect(state.active).toBe(0)
  })
  afterAll(async () => {
    state.afterSql = undefined
    try {
      await observer.query('DELETE FROM authorization_operation_audit WHERE actor_id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM authorization_operation_receipts WHERE actor_id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds])
      await observer.query('DELETE FROM permissions WHERE code = ANY($1::text[])', [permissionCodes])
    } finally {
      if (state.service) await (state.service as ConnectionPool).getInternalPool().end()
      await other.getInternalPool().end()
      await observer.end()
    }
  })

  async function seed(options: { missingTarget?: boolean; targetInactive?: boolean } = {}) {
    const actorId = `direct-actor-${randomUUID()}`
    const userId = `direct-target-${randomUUID()}`
    const permission = `direct:${randomUUID()}:read`
    userIds.push(actorId, userId)
    permissionCodes.push(permission)
    for (const id of options.missingTarget ? [actorId] : [actorId, userId]) {
      await observer.query("INSERT INTO users (id, username, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set) VALUES ($1, $1, 'Synthetic direct fixture', 'synthetic-unused', $2, false, 'user', '[]'::jsonb, $3, false)", [id, id === userId && options.targetInactive ? false : true, id === userId && options.targetInactive ? 'pending_activation' : 'activated'])
    }
    await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    await observer.query('INSERT INTO permissions (code, name) VALUES ($1, $2)', [permission, 'Synthetic direct fixture'])
    return { actorId, userId, permission }
  }

  async function auditCount(actorId: string) {
    return (await observer.query(
      `SELECT count(*)::int AS count FROM authorization_operation_audit a
         JOIN authorization_operation_receipts r USING (actor_id, client_operation_id) WHERE a.actor_id=$1`,
      [actorId],
    )).rows[0].count
  }

  async function count(userId: string, permission?: string) {
    return Number((await observer.query('SELECT count(*)::int AS count FROM user_permissions WHERE user_id = $1 AND ($2::text IS NULL OR permission_code = $2)', [userId, permission ?? null])).rows[0].count)
  }

  async function blockedBy(waiterPid: number, holderPid: number) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const row = (await observer.query("SELECT wait_event_type, $2 = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1", [waiterPid, holderPid])).rows[0]
      if (row?.wait_event_type === 'Lock' && row.blocked === true) return
      await new Promise((done) => setTimeout(done, 20))
    }
    throw new Error('EXPECTED_PHYSICAL_LOCK_WAIT_NOT_OBSERVED')
  }

  it.each(['grant', 'revoke', 'template'] as const)('commits the %s permission change, evidence generation and mandatory audit together', async (kind) => {
    const fixture = await seed()
    if (kind === 'revoke') await observer.query('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [fixture.userId, fixture.permission])
    const beforeGeneration = (await observer.query('SELECT access_generation FROM users WHERE id = $1', [fixture.userId])).rows[0]
    const response = await invoke(kind, fixture.actorId, fixture.userId, fixture.permission)
    expect(response.statusCode).toBe(200)
    if (kind !== 'template') expect(response.body).toEqual({ success: true, userId: fixture.userId, permission: fixture.permission })
    if (kind === 'template') expect(response.body).toEqual({
      success: true,
      userId: fixture.userId,
      template: {
        id: 'attendance-employee', name: '考勤员工', description: '适用于日常打卡与补卡申请。',
        productMode: 'attendance', permissions: ['attendance:read', 'attendance:write'],
        presetId: 'attendance-employee', roleId: 'attendance_employee',
      },
      permissions: [],
      isAdmin: false,
    })
    expect(await count(fixture.userId)).toBe(kind === 'revoke' ? 0 : kind === 'grant' ? 1 : 2)
    expect((await observer.query('SELECT access_generation FROM users WHERE id = $1', [fixture.userId])).rows[0]).toEqual({ access_generation: String(BigInt(beforeGeneration.access_generation) + 1n) })
    expect((await observer.query('SELECT role_id FROM user_roles WHERE user_id = $1', [fixture.userId])).rows).toEqual([])
    expect(state.invalidations).toEqual([fixture.userId])
    expect(await auditCount(fixture.actorId)).toBe(1)
  })

  it.each(['grant', 'revoke', 'template'] as const)('refuses malformed target values for %s without a permission write', async (kind) => {
    const fixture = await seed()
    for (const userId of [42, true, [fixture.userId], { id: fixture.userId }, ` ${fixture.userId}`, `${fixture.userId}\n`]) {
      const response = await invoke(kind, fixture.actorId, userId, fixture.permission)
      expect(response.statusCode).toBe(400)
      expect(response.body).toEqual({ error: 'userId must be a non-empty canonical string' })
    }
    expect(await count(fixture.userId)).toBe(0)
    expect(state.pids).toEqual([])
    expect(await auditCount(fixture.actorId)).toBe(0)
    expect(state.invalidations).toEqual([])
  })

  it.each(['grant', 'revoke', 'template'] as const)('refuses missing %s target and preserves the historical orphan row', async (kind) => {
    const fixture = await seed({ missingTarget: true })
    await observer.query('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [fixture.userId, fixture.permission])
    const response = await invoke(kind, fixture.actorId, fixture.userId, fixture.permission)
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: 'User not found', code: 'NOT_FOUND' })
    expect(await count(fixture.userId)).toBe(1)
    expect(await auditCount(fixture.actorId)).toBe(0)
    expect(state.invalidations).toEqual([])
  })

  it.each(['grant', 'revoke', 'template'] as const)('does not add an inactive or pending target restriction to %s', async (kind) => {
    const fixture = await seed({ targetInactive: true })
    if (kind === 'revoke') await observer.query('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [fixture.userId, fixture.permission])
    expect((await invoke(kind, fixture.actorId, fixture.userId, fixture.permission)).statusCode).toBe(200)
    expect((await observer.query('SELECT is_active, activation_status FROM users WHERE id = $1', [fixture.userId])).rows[0]).toEqual({ is_active: false, activation_status: 'pending_activation' })
  })

  it('deduplicates actor equals target and preserves duplicate grant and no-match revoke', async () => {
    const fixture = await seed()
    for (let index = 0; index < 2; index += 1) expect((await invoke('grant', fixture.actorId, fixture.actorId, fixture.permission)).statusCode).toBe(200)
    expect(await count(fixture.actorId, fixture.permission)).toBe(1)
    const response = await invoke('revoke', fixture.actorId, fixture.userId, fixture.permission)
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: 'Permission not found for user' })
    expect(state.invalidations).toEqual([fixture.actorId])
    expect(await auditCount(fixture.actorId)).toBe(1)
  })

  it('holds the actual positive membership against a naked DELETE until commit', async () => {
    const fixture = await seed()
    const held = deferred()
    const release = deferred()
    let writerPid = 0
    state.afterSql = async (sql, params, _client, pid) => {
      if (/FROM user_roles/.test(sql) && params?.[0] === fixture.actorId) { writerPid = pid; held.resolve(); await release.promise }
    }
    const writer = invoke('grant', fixture.actorId, fixture.userId, fixture.permission)
    const remover = await observer.connect()
    let deletion: Promise<unknown> | undefined
    try {
      expect(await Promise.race([held.promise.then(() => true), writer.then(() => false)])).toBe(true)
      await remover.query('BEGIN')
      const removerPid = Number((await remover.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      deletion = remover.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])
      await blockedBy(removerPid, writerPid)
      expect(await count(fixture.userId)).toBe(0)
      release.resolve()
      expect((await writer).statusCode).toBe(200)
      await deletion
      await remover.query('ROLLBACK')
      expect(await count(fixture.userId)).toBe(1)
    } finally {
      release.resolve()
      await writer.catch(() => undefined)
      await deletion?.catch(() => undefined)
      await remover.query('ROLLBACK')
      remover.release()
    }
  })

  it.each(['COMMIT', 'ROLLBACK'] as const)('rechecks a naked membership removal after waiting for its %s', async (finish) => {
    const fixture = await seed()
    const remover = await observer.connect()
    let writer: Promise<Awaited<ReturnType<typeof invoke>>> | undefined
    try {
      await remover.query('BEGIN')
      const removerPid = Number((await remover.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await remover.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])
      writer = invoke('grant', fixture.actorId, fixture.userId, fixture.permission)
      const deadline = Date.now() + 8000
      while (state.pids.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
      await blockedBy(state.pids[0], removerPid)
      await remover.query(finish)
      const response = await writer
      expect(response.statusCode).toBe(finish === 'COMMIT' ? 403 : 200)
      if (finish === 'COMMIT') expect(response.body).toEqual({ error: 'Admin access required', code: 'FORBIDDEN' })
      expect(await count(fixture.userId)).toBe(finish === 'COMMIT' ? 0 : 1)
    } finally {
      await remover.query('ROLLBACK')
      await writer?.catch(() => undefined)
      remover.release()
    }
  })

  it('serializes with the cooperative admin membership remover before its child write', async () => {
    const fixture = await seed()
    const removed = deferred()
    const release = deferred()
    let removerPid = 0
    const removal = other.transaction(async (client) => {
      removerPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await lockSharedAccessSubjects(client, [fixture.actorId])
      await unassignUserRoles({ userIds: [fixture.actorId], roleId: 'admin', scope: { kind: 'platform-admin' }, executor: client })
      removed.resolve()
      await release.promise
    })
    let writer: Promise<Awaited<ReturnType<typeof invoke>>> | undefined
    try {
      await removed.promise
      writer = invoke('grant', fixture.actorId, fixture.userId, fixture.permission)
      const deadline = Date.now() + 8000
      while (state.pids.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
      await blockedBy(state.pids[0], removerPid)
      release.resolve()
      await removal
      expect((await writer).statusCode).toBe(403)
      expect(await count(fixture.userId)).toBe(0)
    } finally {
      release.resolve()
      await Promise.allSettled([removal, ...(writer ? [writer] : [])])
    }
  })

  it('waits for a target consumer then commits a grant visible to the next consumer', async () => {
    const fixture = await seed()
    const held = deferred()
    const release = deferred()
    let holderPid = 0
    const consumer = withAuthorizationInputTransaction({ intent: 'CONSUME_CLASS_DECISION', userIds: [fixture.userId], admissionUserIds: [fixture.userId] }, async (tx) => {
      holderPid = Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      held.resolve()
      await release.promise
    })
    let writer: Promise<Awaited<ReturnType<typeof invoke>>> | undefined
    try {
      await held.promise
      writer = invoke('grant', fixture.actorId, fixture.userId, fixture.permission)
      const deadline = Date.now() + 8000
      while (state.pids.length < 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
      await blockedBy(state.pids[1], holderPid)
      expect(await count(fixture.userId)).toBe(0)
      release.resolve()
      await consumer
      expect((await writer).statusCode).toBe(200)
      const seen = await withAuthorizationInputTransaction({ intent: 'CONSUME_CLASS_DECISION', userIds: [fixture.userId], admissionUserIds: [fixture.userId] }, async (tx) => tx.query('SELECT permission_code FROM user_permissions WHERE user_id = $1', [fixture.userId]))
      expect(seen.rows).toEqual([{ permission_code: fixture.permission }])
    } finally {
      release.resolve()
      await Promise.allSettled([consumer, ...(writer ? [writer] : [])])
    }
  })

  it('completes crossed actor-target commands in canonical subject order', async () => {
    const fixture = await seed()
    await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [fixture.userId])
    await Promise.all([
      writeLegacyAuthorizationException({ actorId: fixture.actorId, userId: fixture.userId, action: { kind: 'direct.grant', code: fixture.permission } }),
      writeLegacyAuthorizationException({ actorId: fixture.userId, userId: fixture.actorId, action: { kind: 'direct.grant', code: fixture.permission } }),
    ])
    expect(await count(fixture.actorId, fixture.permission)).toBe(1)
    expect(await count(fixture.userId, fixture.permission)).toBe(1)
  })

  it.each(['R3', 'R5'] as const)('isolates actual target %s acquisition with no other blocker rank', async (rank) => {
    const fixture = await seed()
    const holder = await observer.connect()
    let writer: Promise<Awaited<ReturnType<typeof invoke>>> | undefined
    try {
      await holder.query('BEGIN')
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      if (rank === 'R3') await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`namespace-admission:${fixture.userId}`])
      else await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [fixture.userId])
      writer = invoke('grant', fixture.actorId, fixture.userId, fixture.permission)
      const deadline = Date.now() + 8000
      while (state.pids.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
      let observed = false
      try {
        await blockedBy(state.pids[0], holderPid)
        observed = true
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'EXPECTED_PHYSICAL_LOCK_WAIT_NOT_OBSERVED') throw error
      }
      expect({ blocked: observed, permissionRows: await count(fixture.userId) }).toEqual({ blocked: true, permissionRows: 0 })
      await holder.query('COMMIT')
      expect((await writer).statusCode).toBe(200)
      expect(await count(fixture.userId)).toBe(1)
    } finally {
      await holder.query('ROLLBACK')
      await writer?.catch(() => undefined)
      holder.release()
    }
  })

  it('blocks a later consumer until the actual direct command commits', async () => {
    const fixture = await seed()
    const held = deferred()
    const release = deferred()
    let writerPid = 0
    state.afterSql = async (sql, params, _client, pid) => {
      if (/FROM user_roles/.test(sql) && params?.[0] === fixture.actorId) { writerPid = pid; held.resolve(); await release.promise }
    }
    const writer = invoke('grant', fixture.actorId, fixture.userId, fixture.permission)
    let consumer: Promise<{ rows: Array<Record<string, unknown>> }> | undefined
    try {
      expect(await Promise.race([held.promise.then(() => true), writer.then(() => false)])).toBe(true)
      consumer = withAuthorizationInputTransaction({ intent: 'CONSUME_CLASS_DECISION', userIds: [fixture.userId], admissionUserIds: [fixture.userId] }, (tx) => tx.query('SELECT permission_code FROM user_permissions WHERE user_id=$1', [fixture.userId]))
      const deadline = Date.now() + 8000
      while (state.pids.length < 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
      await blockedBy(state.pids[1], writerPid)
      release.resolve()
      expect((await writer).statusCode).toBe(200)
      expect((await consumer).rows).toEqual([{ permission_code: fixture.permission }])
    } finally {
      release.resolve()
      await Promise.allSettled([writer, ...(consumer ? [consumer] : [])])
    }
  })

  it('refuses a missing actor row even when its old admin membership remains', async () => {
    const fixture = await seed()
    await observer.query('DELETE FROM users WHERE id=$1', [fixture.actorId])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id=$1 AND role_id='admin'", [fixture.actorId])).rows).toHaveLength(1)
    const response = await invoke('grant', fixture.actorId, fixture.userId, fixture.permission)
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ error: 'Admin access required', code: 'FORBIDDEN' })
    expect(await count(fixture.userId)).toBe(0)
  })

  it.each(['inactive', 'pending', 'disabled'] as const)('refuses the locked %s actor despite the same admin edge', async (kind) => {
    const fixture = await seed()
    if (kind === 'inactive') await observer.query('UPDATE users SET is_active=false WHERE id=$1', [fixture.actorId])
    if (kind === 'pending') await observer.query("UPDATE users SET activation_status='pending_activation' WHERE id=$1", [fixture.actorId])
    if (kind === 'disabled') await observer.query("UPDATE users SET role='disabled' WHERE id=$1", [fixture.actorId])
    const response = await invoke('grant', fixture.actorId, fixture.userId, fixture.permission)
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ error: 'Admin access required', code: 'FORBIDDEN' })
    expect(await count(fixture.userId)).toBe(0)
  })

  it('snapshots the template codes before any transaction await', async () => {
    const fixture = await seed()
    const permissions = [fixture.permission]
    const command = writeLegacyAuthorizationException({ actorId: fixture.actorId, userId: fixture.userId, action: { kind: 'template.apply', templateId: 'fixture', codes: permissions } })
    permissions[0] = `direct-missing-${randomUUID()}`
    await command
    expect(await count(fixture.userId, fixture.permission)).toBe(1)
  })

  it('refuses a template containing an unknown code without committing a partial grant', async () => {
    const fixture = await seed()
    await expect(writeLegacyAuthorizationException({ actorId: fixture.actorId, userId: fixture.userId, action: { kind: 'template.apply', templateId: 'fixture', codes: [fixture.permission, `direct-missing-${randomUUID()}`] } })).rejects.toMatchObject({ code: 'UNKNOWN_PERMISSION' })
    expect(await count(fixture.userId)).toBe(0)
    expect(state.events).not.toContain('COMMIT_CONFIRMED')
  })

  it('keeps empty template authorization and target checks without permission DML', async () => {
    const fixture = await seed()
    await writeLegacyAuthorizationException({ actorId: fixture.actorId, userId: fixture.userId, action: { kind: 'template.apply', templateId: 'fixture', codes: [] } })
    expect(state.events.some((sql) => /FROM user_roles/.test(sql) && /FOR SHARE/.test(sql))).toBe(true)
    expect(state.events.some((sql) => /INSERT INTO user_permissions/.test(sql))).toBe(false)
    expect(await count(fixture.userId)).toBe(0)
    expect(state.events.at(-1)).toBe('COMMIT_CONFIRMED')
  })

  it('bounds the new membership lock wait and returns busy without writes or leaked transaction', async () => {
    const fixture = await seed()
    const remover = await observer.connect()
    try {
      await remover.query('BEGIN')
      await remover.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])
      const response = await invoke('grant', fixture.actorId, fixture.userId, fixture.permission)
      expect(response.statusCode).toBe(409)
      expect(response.body).toEqual({ code: 'AUTHORIZATION_INPUT_BUSY', error: 'Authorization inputs are busy; retry this change.' })
      expect(await count(fixture.userId)).toBe(0)
      for (const pid of state.pids) expect((await observer.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1 AND state='idle in transaction'", [pid])).rows[0].count).toBe(0)
    } finally {
      await remover.query('ROLLBACK')
      remover.release()
    }
    expect((await invoke('grant', fixture.actorId, fixture.userId, fixture.permission)).statusCode).toBe(200)
  })
})
