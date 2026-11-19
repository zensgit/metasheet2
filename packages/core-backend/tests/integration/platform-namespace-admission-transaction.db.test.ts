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
  pids: [] as number[],
  poolSql: [] as string[],
  outOfRoot: [] as string[],
  events: [] as string[],
  cacheUserIds: [] as string[],
  active: 0,
  readsAtCache: -1,
  beforeSql: undefined as undefined | ((sql: string, params: unknown[] | undefined, pid: number) => Promise<void>),
  afterSql: undefined as undefined | ((sql: string, params: unknown[] | undefined, pid: number) => Promise<void>),
  injectBeforeQuery: undefined as undefined | ((sql: string, params: unknown[] | undefined) => Error | undefined),
  serverFault: undefined as undefined | ((sql: string, params: unknown[] | undefined, client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>),
  failCommitAck: false,
  failReadback: false,
  audit: vi.fn(async () => undefined),
}))

vi.mock('../../src/integration/db/connection-pool', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  let surface: ReturnType<typeof state.open> | undefined
  state.open = () => {
    if (surface) return surface
    const service = new actual.ConnectionPool({ connectionString: process.env.DATABASE_URL, max: 6, name: 'platform-namespace-admission-db' })
    const built = {
      getInternalPool: () => service.getInternalPool(),
      query: async (sql: string, params?: unknown[]) => {
        const compact = sql.replace(/\s+/g, ' ').trim()
        state.poolSql.push(compact)
        if (state.failReadback && state.events.includes('BUSINESS_COMMIT') && compact.includes('FROM user_namespace_admissions')) {
          state.failReadback = false
          throw Object.assign(new Error('SYNTHETIC_POST_COMMIT_READBACK'), { synthetic: 'readback' })
        }
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
            state.pids.push(trace.pid)
            trace.business = true
            if (state.live) throw new Error('UNEXPECTED_ADDITIONAL_TRANSACTION')
            state.live = trace
            return work({ __rawClient: client.__rawClient, query: async (sql: string, params?: unknown[]) => {
              const compact = sql.replace(/\s+/g, ' ').trim()
              trace.sql.push(compact)
              trace.params.push(params ?? [])
              const injected = state.injectBeforeQuery?.(compact, params)
              if (injected) throw injected
              if (state.serverFault) await state.serverFault(compact, params, client)
              await state.beforeSql?.(compact, params, trace.pid)
              const queryResult = await client.query(sql, params)
              await state.afterSql?.(compact, params, trace.pid)
              return queryResult
            } })
          })
          trace.committed = true
          if (trace.business) state.events.push('BUSINESS_COMMIT')
          if (state.failCommitAck) {
            state.failCommitAck = false
            throw Object.assign(new Error('SYNTHETIC_COMMIT_ACK_LOSS'), { synthetic: 'commit-ack' })
          }
          return result
        } finally {
          state.traces.push(trace)
          state.active -= 1
          if (state.live === trace) state.live = undefined
        }
      },
    }
    surface = built
    return built
  }
  return { ...actual, poolManager: { get: () => state.open() } }
})
vi.mock('../../src/middleware/auth', () => ({ authenticate: () => { throw new Error('HANDLER_SEAM_NOT_AUTH_E2E') } }))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))
vi.mock('../../src/audit/audit', () => ({ auditLog: (...args: unknown[]) => state.audit(...args) }))
vi.mock('../../src/rbac/service', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    invalidateUserPerms: (userId: string) => {
      state.readsAtCache = state.poolSql.filter(sql => sql.includes('FROM user_namespace_admissions')).length
      state.cacheUserIds.push(userId)
      state.events.push('cache')
      return actual.invalidateUserPerms(userId)
    },
  }
})

import { adminUsersRouter } from '../../src/routes/admin-users'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

const databaseUrl = process.env.DATABASE_URL
if (process.env.EXPECT_DB === '1' && !databaseUrl) throw new Error('EXPECT_DB=1 but DATABASE_URL is missing; module load refuses a skip-shaped green')
const describeWithDatabase = databaseUrl ? describe : describe.skip
const admissionPath = '/api/admin/users/:userId/namespaces/:namespace/admission'
const ROLE_SHARE = /SELECT id::text AS id FROM roles WHERE id = \$1::text FOR SHARE/
const ROLE_UPDATE = /SELECT id::text AS id FROM roles WHERE id = \$1::text FOR UPDATE/
const ADMISSION = /SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/
const USER_LOCK = /FROM users WHERE id = \$1::text FOR UPDATE/
const ADMIN_CHILD_READ = /SELECT role_id FROM user_roles WHERE user_id = \$1 AND role_id = 'admin'/
const ADMIN_SHARE = /SELECT role_id FROM user_roles WHERE user_id = \$1 AND role_id = 'admin' FOR SHARE/
const ADMISSION_INSERT = /INSERT INTO user_namespace_admissions\b/
const WORLD_SHARED = 'pg_advisory_xact_lock_shared(20261106, 1)'
const NAMESPACE = 'stock-prep'
const NEIGHBOR = 'attendance'
const releases: Array<() => void> = []

type Handle = (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown
type Trace = { pid: number; sql: string[]; params: unknown[][]; business: boolean; committed: boolean }
type Life = 'live' | 'inactive' | 'pending' | 'deleted'
type ActorKind = 'raw' | 'member' | 'inactive' | 'pending' | 'deleted' | 'missing'
type AdmissionRow = { user_id: string; namespace: string; enabled: boolean; source: string; granted_by: string | null; updated_by: string | null }

function rewind() {
  state.traces = []
  state.live = undefined
  state.pids = []
  state.poolSql = []
  state.outOfRoot = []
  state.events = []
  state.cacheUserIds = []
  state.readsAtCache = -1
  state.beforeSql = undefined
  state.afterSql = undefined
  state.injectBeforeQuery = undefined
  state.serverFault = undefined
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
function pause(pattern: RegExp, param?: string) {
  const resume = gate()
  let entered = false
  let holder = 0
  state.afterSql = async (sql, params, pid) => {
    if (entered || !pattern.test(sql) || (param !== undefined && params?.[0] !== param)) return
    entered = true
    holder = pid
    await resume.promise
  }
  return { wait: () => until(() => entered, 'COMMAND_DID_NOT_REACH_PAUSE'), release: resume.release, holder: () => holder }
}
function beforeMatching(pattern: RegExp, effect: () => Promise<void>) {
  let used = false
  state.beforeSql = async sql => { if (used || !pattern.test(sql)) return; used = true; await effect() }
}
function worldShared(sql: string) {
  return sql.includes(WORLD_SHARED) && !sql.includes('pg_try_advisory')
}
function subjectLocks(trace: Trace) {
  const r3: string[] = []
  const r5: string[] = []
  trace.sql.forEach((sql, index) => {
    const param = String(trace.params[index]?.[0] ?? '')
    if (ADMISSION.test(sql)) r3.push(param)
    else if (USER_LOCK.test(sql)) r5.push(param)
  })
  return { r3, r5 }
}
function expectOneRoot() {
  expect(state.outOfRoot).toEqual([])
  expect(state.traces.map(trace => trace.business)).toEqual([true])
  const root = state.traces[0]
  expect(root?.committed).toBe(true)
  expect(state.pids).toEqual([root?.pid])
  expect(root?.sql.filter(worldShared)).toHaveLength(1)
  expect(root?.sql.some(sql => ROLE_SHARE.test(sql) || ROLE_UPDATE.test(sql) || sql.includes('user-recycle:platform-admin'))).toBe(false)
  return root
}
function rootPid() {
  const pid = state.pids[0]
  if (!pid) throw new Error('ROOT_PID_MISSING')
  return pid
}
function waitingStatement() {
  const live = state.live
  if (!live || live.sql.length === 0) throw new Error('WAITING_STATEMENT_MISSING')
  return { sql: live.sql[live.sql.length - 1] ?? '', params: live.params[live.params.length - 1] ?? [] }
}
function admissionWrites(trace: Trace | undefined) {
  return (trace?.sql ?? []).filter(sql => ADMISSION_INSERT.test(sql))
}
function test(name: string, fn: () => Promise<void>) {
  it(name, fn, 20_000)
}
function failure(code: string, message: string) {
  return { ok: false, error: { code, message } }
}
function busyBody() {
  return { ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } }
}
function serverFailure() {
  return failure('MEMBER_NAMESPACE_ADMISSION_FAILED', 'Failed to update namespace admission')
}
function syntheticSqlState(code: string, marker: boolean) {
  return Object.assign(new Error(marker ? RECOVERY_AUTHORITY_BUSY_MARKER : `SYNTHETIC_SQLSTATE_${code}`), {
    code,
    synthetic: 'not-a-physical-lock',
  })
}

describeWithDatabase('platform namespace admission on the real pool; registered handler excludes authentication', () => {
  let observer: PgPool
  let handler: Handle
  const userIds: string[] = []
  const controls: Array<{ close: () => Promise<void> }> = []

  beforeAll(async () => {
    observer = new PgPool({ connectionString: databaseUrl, max: 4 })
    state.open()
    await observer.query('SELECT 1')
    const router = adminUsersRouter() as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }> }
    const layer = router.stack.find(entry => entry.route?.path === admissionPath && entry.route.methods.patch)
    if (!layer?.route || layer.route.stack.length < 2) throw new Error('EXPECTED_REGISTERED_HANDLER')
    expect(() => layer.route?.stack[0].handle()).toThrow('HANDLER_SEAM_NOT_AUTH_E2E')
    handler = layer.route.stack[layer.route.stack.length - 1].handle
  })
  beforeEach(() => {
    expect(state.active).toBe(0)
    rewind()
    state.audit.mockReset().mockImplementation(async () => {
      expect(state.active).toBe(0)
      expect(state.events).toEqual(['BUSINESS_COMMIT', 'cache'])
      state.events.push('audit')
    })
  })
  afterEach(async () => {
    state.beforeSql = undefined
    state.afterSql = undefined
    state.injectBeforeQuery = undefined
    state.serverFault = undefined
    state.failCommitAck = false
    state.failReadback = false
    for (const release of releases.splice(0)) release()
    for (const handle of controls.splice(0)) await handle.close()
    const deadline = Date.now() + 2500
    while (state.active !== 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(state.active).toBe(0)
    await cleanupOwned()
  })
  afterAll(async () => {
    await cleanupOwned().catch(() => undefined)
    await state.open().getInternalPool().end().catch(() => undefined)
    await observer?.end()
  })

  async function cleanupOwned() {
    const cleanups: Array<[string, unknown[]]> = [
      ['DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [[...userIds]]],
      ['DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [[...userIds]]],
      ['DELETE FROM users WHERE id = ANY($1::text[])', [[...userIds]]],
    ]
    const cleaner = await observer.connect()
    const failures: unknown[] = []
    try {
      await cleaner.query("SET lock_timeout = '2s'")
      for (const [sql, params] of cleanups) {
        try { await cleaner.query(sql, params) } catch (error) { failures.push(error) }
      }
    } finally {
      await cleaner.query('RESET lock_timeout').catch(() => undefined)
      cleaner.release()
    }
    if (failures.length === 0) userIds.length = 0
    if (failures.length > 0) throw failures[0]
  }
  async function control() {
    const client = await observer.connect()
    await client.query('BEGIN')
    let closed = false
    const handle = {
      client,
      pid: Number((client as PoolClient & { processID?: number }).processID),
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
  async function blockedQuery(waiter: number, holder: number) {
    let seen = ''
    await until(async () => {
      const row = (await observer.query("SELECT query, wait_event_type = 'Lock' AND $2 = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1", [waiter, holder])).rows[0]
      seen = String(row?.query ?? '')
      return row?.blocked === true
    }, 'EXPECTED_PHYSICAL_LOCK_WAIT')
    return seen
  }
  async function insertUser(sort: 'a' | 'n' | 'z', rawRole: string, life: Life) {
    const userId = `p1h-${sort}-${randomUUID()}`
    userIds.push(userId)
    await observer.query(
      `INSERT INTO users (id, username, email, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set)
       VALUES ($1, $1, $2, 'Synthetic namespace admission fixture', 'synthetic-unused', $3, false, $4, '[]'::jsonb, $5, false)`,
      [userId, `${userId}@example.invalid`, life !== 'inactive', rawRole, life === 'pending' ? 'pending_activation' : 'activated'],
    )
    if (life === 'deleted') await observer.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [userId])
    return userId
  }
  async function world(actor: ActorKind, targetLife: Life = 'live') {
    const actorLife: Life = actor === 'inactive' || actor === 'pending' || actor === 'deleted' ? actor : 'live'
    const actorId = actor === 'missing' ? `p1h-z-${randomUUID()}` : await insertUser('z', actor === 'raw' ? 'admin' : 'user', actorLife)
    if (actor === 'member') await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    const targetId = await insertUser('a', 'user', targetLife)
    return { actorId, targetId }
  }
  async function seedAdmission(userId: string, namespace: string, enabled: boolean, grantedBy: string) {
    await observer.query(
      `INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source, granted_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'platform_admin', $4, $4, NOW(), NOW())`,
      [userId, namespace, enabled, grantedBy],
    )
  }
  async function storedAdmissions(ids: readonly string[]) {
    return (await observer.query(
      `SELECT user_id, namespace, enabled, source, granted_by, updated_by
       FROM user_namespace_admissions
       WHERE user_id = ANY($1::text[])
       ORDER BY user_id, namespace`,
      [[...ids]],
    )).rows as AdmissionRow[]
  }
  async function invoke(actorId: string, userId: unknown, namespace: unknown, enabled: unknown) {
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this },
      json(payload: unknown) { this.body = payload; return this },
    }
    await Promise.resolve(handler({
      method: 'PATCH', headers: {}, query: {}, params: { userId, namespace }, body: { enabled }, user: { id: actorId, role: 'admin' },
    }, response, (error?: unknown) => { if (error) throw error }))
    return response
  }
  function stableSnapshots(body: unknown) {
    const data = (body as { data?: { namespaceAdmissions?: Array<Record<string, unknown>> } }).data
    return (data?.namespaceAdmissions ?? []).map(row => ({
      namespace: row.namespace,
      enabled: row.enabled,
      effective: row.effective,
      hasRole: row.hasRole,
      source: row.source,
      grantedBy: row.grantedBy,
      updatedBy: row.updatedBy,
      hasCreatedAt: row.createdAt != null,
      hasUpdatedAt: row.updatedAt != null,
    }))
  }
  function expectGrantAudit(actorId: string, userId: string, namespace: string, enabled: boolean) {
    expect(state.cacheUserIds).toEqual([userId])
    expect(state.readsAtCache).toBeGreaterThan(0)
    expect(state.events).toEqual(['BUSINESS_COMMIT', 'cache', 'audit'])
    expect(state.audit).toHaveBeenCalledWith({
      actorId, actorType: 'user', action: enabled ? 'grant' : 'revoke', resourceType: 'user-namespace-admission',
      resourceId: `${userId}:${namespace}`,
      meta: { adminUserId: actorId, userId, namespace, enabled },
    })
  }
  function expectNoEffects() {
    expect(state.audit).not.toHaveBeenCalled()
    expect(state.cacheUserIds).toEqual([])
    expect(state.events).not.toContain('BUSINESS_COMMIT')
    expect(state.outOfRoot).toEqual([])
  }

  test('raw admin admission writes the enabled row, skips the child read, and invalidates cache before audit', async () => {
    const fixture = await world('raw')
    const neighborId = await insertUser('n', 'user', 'live')
    const priorGrant = `p1h-grant-${randomUUID()}`
    await seedAdmission(fixture.targetId, NEIGHBOR, false, priorGrant)
    await seedAdmission(neighborId, NAMESPACE, true, priorGrant)
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    const root = expectOneRoot()
    const subjects = [fixture.targetId, fixture.actorId].sort()
    expect(subjectLocks(root)).toEqual({
      r3: subjects.map(id => `namespace-admission:${id}`),
      r5: subjects,
    })
    const worldAt = root.sql.findIndex(worldShared)
    expect(root.sql.findIndex(sql => sql.includes('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'))).toBeLessThan(worldAt)
    expect(worldAt).toBeLessThan(root.sql.findIndex(sql => ADMISSION.test(sql)))
    expect(root.sql.findLastIndex(sql => ADMISSION.test(sql))).toBeLessThan(root.sql.findIndex(sql => USER_LOCK.test(sql)))
    expect(root.sql.some(sql => ADMIN_CHILD_READ.test(sql))).toBe(false)
    const inserted = root.sql.findIndex(sql => ADMISSION_INSERT.test(sql))
    expect(inserted).toBeGreaterThan(root.sql.findLastIndex(sql => USER_LOCK.test(sql)))
    expect(admissionWrites(root)).toHaveLength(1)
    expect(root.params[inserted]).toEqual([fixture.targetId, NAMESPACE, true, 'platform_admin', fixture.actorId, fixture.actorId])
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ actorId: fixture.actorId, userId: fixture.targetId }),
    }))
    expect(stableSnapshots(response.body)).toEqual([
      { namespace: NEIGHBOR, enabled: false, effective: false, hasRole: false, source: 'platform_admin', grantedBy: priorGrant, updatedBy: priorGrant, hasCreatedAt: true, hasUpdatedAt: true },
      { namespace: NAMESPACE, enabled: true, effective: false, hasRole: false, source: 'platform_admin', grantedBy: fixture.actorId, updatedBy: fixture.actorId, hasCreatedAt: true, hasUpdatedAt: true },
    ])
    expect(await storedAdmissions([fixture.targetId, neighborId])).toEqual([
      { user_id: fixture.targetId, namespace: NEIGHBOR, enabled: false, source: 'platform_admin', granted_by: priorGrant, updated_by: priorGrant },
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
      { user_id: neighborId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: priorGrant, updated_by: priorGrant },
    ])
    expectGrantAudit(fixture.actorId, fixture.targetId, NAMESPACE, true)
  })

  test('disabling preserves granted_by and leaves the neighboring admission unchanged', async () => {
    const fixture = await world('raw')
    const neighborId = await insertUser('n', 'user', 'live')
    const priorGrant = `p1h-grant-${randomUUID()}`
    await seedAdmission(fixture.targetId, NAMESPACE, true, priorGrant)
    await seedAdmission(fixture.targetId, NEIGHBOR, false, priorGrant)
    await seedAdmission(neighborId, NAMESPACE, false, priorGrant)
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, false)
    const root = expectOneRoot()
    const inserted = root.sql.findIndex(sql => ADMISSION_INSERT.test(sql))
    expect(root.params[inserted]).toEqual([fixture.targetId, NAMESPACE, false, 'platform_admin', null, fixture.actorId])
    expect(response.statusCode).toBe(200)
    expect(stableSnapshots(response.body)).toEqual([
      { namespace: NEIGHBOR, enabled: false, effective: false, hasRole: false, source: 'platform_admin', grantedBy: priorGrant, updatedBy: priorGrant, hasCreatedAt: true, hasUpdatedAt: true },
      { namespace: NAMESPACE, enabled: false, effective: false, hasRole: false, source: 'platform_admin', grantedBy: priorGrant, updatedBy: fixture.actorId, hasCreatedAt: true, hasUpdatedAt: true },
    ])
    expect(await storedAdmissions([fixture.targetId, neighborId])).toEqual([
      { user_id: fixture.targetId, namespace: NEIGHBOR, enabled: false, source: 'platform_admin', granted_by: priorGrant, updated_by: priorGrant },
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: false, source: 'platform_admin', granted_by: priorGrant, updated_by: fixture.actorId },
      { user_id: neighborId, namespace: NAMESPACE, enabled: false, source: 'platform_admin', granted_by: priorGrant, updated_by: priorGrant },
    ])
    expectGrantAudit(fixture.actorId, fixture.targetId, NAMESPACE, false)
  })

  test('membership admission takes R0, sorted R3, sorted R5, then one admin-child share inside 5000/10000', async () => {
    const fixture = await world('member')
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    const root = expectOneRoot()
    const subjects = [fixture.targetId, fixture.actorId].sort()
    expect(subjectLocks(root)).toEqual({
      r3: subjects.map(id => `namespace-admission:${id}`),
      r5: subjects,
    })
    const shareAt = root.sql.findIndex(sql => ADMIN_SHARE.test(sql))
    expect(root.sql.filter(sql => ADMIN_SHARE.test(sql))).toHaveLength(1)
    expect(root.params[shareAt]).toEqual([fixture.actorId])
    expect(root.sql[shareAt - 1]).toContain("set_config('lock_timeout'")
    expect(root.params[shareAt - 1]).toEqual(['5000', '10000'])
    expect(root.sql[shareAt + 1]).toContain("set_config('lock_timeout'")
    expect(shareAt).toBeGreaterThan(root.sql.findLastIndex(sql => USER_LOCK.test(sql)))
    expect(root.sql.findIndex(sql => ADMISSION_INSERT.test(sql))).toBeGreaterThan(shareAt)
    expect(response.statusCode).toBe(200)
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
  })

  test('actor and target are one sorted subject and the raw admin writes that admission', async () => {
    const actorId = await insertUser('a', 'admin', 'live')
    const response = await invoke(actorId, actorId, NAMESPACE, true)
    const root = expectOneRoot()
    expect(subjectLocks(root)).toEqual({ r3: [`namespace-admission:${actorId}`], r5: [actorId] })
    expect(root.sql.some(sql => ADMIN_CHILD_READ.test(sql))).toBe(false)
    expect(response.statusCode).toBe(200)
    expect((response.body as { data?: { userId?: string } }).data?.userId).toBe(actorId)
    expect(await storedAdmissions([actorId])).toEqual([
      { user_id: actorId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: actorId, updated_by: actorId },
    ])
  })

  test('trimmed user id and namespace keep the old route write', async () => {
    const fixture = await world('raw')
    const response = await invoke(fixture.actorId, `  ${fixture.targetId}  `, `  ${NAMESPACE}  `, true)
    expectOneRoot()
    expect(response.statusCode).toBe(200)
    expect((response.body as { data?: { userId?: string } }).data?.userId).toBe(fixture.targetId)
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
    expectGrantAudit(fixture.actorId, fixture.targetId, NAMESPACE, true)
  })

  test('a numeric target id is stringified and misses as 404, not a new 400', async () => {
    const fixture = await world('raw')
    const response = await invoke(fixture.actorId, 8675309, NAMESPACE, true)
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual(failure('NOT_FOUND', 'User not found'))
    expect(state.traces).toEqual([])
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
  })

  it.each(['inactive', 'pending'] as const)('keeps a %s target writable', async life => {
    const fixture = await world('raw', life)
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    expect(response.statusCode).toBe(200)
    expectOneRoot()
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
  }, 20_000)

  test('missing target is 404 before a missing actor is considered', async () => {
    const response = await invoke(`p1h-z-${randomUUID()}`, `p1h-a-${randomUUID()}`, NAMESPACE, true)
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual(failure('NOT_FOUND', 'User not found'))
    expect(state.traces).toEqual([])
    expectNoEffects()
  })

  it.each(['missing', 'inactive', 'pending', 'deleted'] as const)('refuses a %s actor with no admission write', async actor => {
    const fixture = await world(actor)
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual(failure('FORBIDDEN', 'Admin access required'))
    const root = state.traces[0]
    expect(state.traces).toHaveLength(1)
    expect(root?.business).toBe(true)
    expect(root?.committed).toBe(false)
    expect(root?.sql.some(sql => ADMIN_CHILD_READ.test(sql) || ADMISSION_INSERT.test(sql))).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
  }, 20_000)

  it.each(['deleted_at', 'purged_at'] as const)('setting %s after preflight is 409 before an inactive actor is 403', async column => {
    const fixture = await world('inactive')
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query(`UPDATE users SET ${column} = NOW() WHERE id = $1`, [fixture.targetId]).then(() => undefined))
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual(failure('USER_IN_RECYCLE_BIN', '账号在回收站中，请先恢复后再修改权限'))
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(admissionWrites(state.traces[0])).toEqual([])
    expect(state.traces[0]?.sql.some(sql => ADMIN_CHILD_READ.test(sql))).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
  }, 20_000)

  test('deleting the target row after preflight is 404 before an inactive actor is 403', async () => {
    const fixture = await world('inactive')
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query('DELETE FROM users WHERE id = $1', [fixture.targetId]).then(() => undefined))
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual(failure('NOT_FOUND', 'User not found'))
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(admissionWrites(state.traces[0])).toEqual([])
    expectNoEffects()
  })

  test('deleting the admin child before its share is 403 and writes nothing', async () => {
    const fixture = await world('member')
    beforeMatching(ADMIN_CHILD_READ, async () => {
      const client = await observer.connect()
      try {
        await client.query("SET lock_timeout = '400ms'")
        await client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])
      } finally {
        await client.query('RESET lock_timeout').catch(() => undefined)
        client.release()
      }
    })
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual(failure('FORBIDDEN', 'Admin access required'))
    const trace = state.traces[0]
    const shareAt = trace.sql.findIndex(sql => ADMIN_SHARE.test(sql))
    expect(trace.params[shareAt]).toEqual([fixture.actorId])
    expect(trace.params[shareAt - 1]).toEqual(['5000', '10000'])
    expect(trace.sql[shareAt + 1]).toContain("set_config('lock_timeout'")
    expect(trace.committed).toBe(false)
    expect(admissionWrites(trace)).toEqual([])
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
  })

  test('admin child share blocks deletion until the business commit', async () => {
    const fixture = await world('member')
    const paused = pause(ADMIN_CHILD_READ)
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, NAMESPACE, true))
    const editor = await control()
    let deleting: ReturnType<typeof outcome> | undefined
    try {
      await paused.wait()
      deleting = outcome(editor.client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId]))
      await blockedQuery(editor.pid, paused.holder())
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      expect(state.events).not.toContain('BUSINESS_COMMIT')
    } finally {
      paused.release()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
      if (deleting) expect((await deleting).ok).toBe(true)
      await editor.close()
    }
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
    expectOneRoot()
  })

  test('held world exclusive lock blocks R0 before R3 or R5', async () => {
    const fixture = await world('raw')
    const holder = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT pg_advisory_xact_lock(20261106, 1)')
      pending = outcome(invoke(fixture.actorId, fixture.targetId, NAMESPACE, true))
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(waiting.includes(WORLD_SHARED)).toBe(true)
      expect(waiting.includes('pg_try_advisory')).toBe(false)
      expect(statement.sql.includes(WORLD_SHARED)).toBe(true)
      expect(statement.params).toEqual([])
      expect(state.live?.sql.some(sql => ADMISSION.test(sql) || USER_LOCK.test(sql) || ADMIN_CHILD_READ.test(sql))).toBe(false)
      expect(admissionWrites(state.live)).toEqual([])
      await holder.close()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
    } finally {
      await holder.close()
      if (pending) await pending
    }
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
    expectOneRoot()
  })

  test('held target R3 blocks before any R5', async () => {
    const fixture = await world('raw')
    const holder = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`namespace-admission:${fixture.targetId}`])
      pending = outcome(invoke(fixture.actorId, fixture.targetId, NAMESPACE, true))
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(waiting.includes('hashtextextended')).toBe(true)
      expect(waiting.includes('FOR UPDATE')).toBe(false)
      expect(statement.params).toEqual([`namespace-admission:${fixture.targetId}`])
      expect(state.live?.sql.some(sql => USER_LOCK.test(sql) || ADMIN_CHILD_READ.test(sql))).toBe(false)
      expect(admissionWrites(state.live)).toEqual([])
      await holder.close()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
    } finally {
      await holder.close()
      if (pending) await pending
    }
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
    expectOneRoot()
  })

  test('held target user row blocks the first FOR UPDATE before the actor lock or a child read', async () => {
    const fixture = await world('member')
    const holder = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT id::text AS id FROM users WHERE id = $1::text FOR UPDATE', [fixture.targetId])
      pending = outcome(invoke(fixture.actorId, fixture.targetId, NAMESPACE, true))
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(waiting).toContain('FROM users')
      expect(waiting).toContain('FOR UPDATE')
      expect(waiting).not.toContain('FOR SHARE')
      expect(statement.params).toEqual([fixture.targetId])
      const locks = subjectLocks(state.live as Trace)
      expect(locks.r3).toEqual([fixture.targetId, fixture.actorId].sort().map(id => `namespace-admission:${id}`))
      expect(locks.r5).toEqual([fixture.targetId])
      expect(state.live?.sql.some(sql => ADMIN_CHILD_READ.test(sql) || ROLE_UPDATE.test(sql) || ROLE_SHARE.test(sql))).toBe(false)
      expect(admissionWrites(state.live)).toEqual([])
      await holder.close()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
    } finally {
      await holder.close()
      if (pending) await pending
    }
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
    expectOneRoot()
  })

  test('the writer user lock blocks a concurrent recycle update until commit', async () => {
    const fixture = await world('raw')
    const paused = pause(USER_LOCK, fixture.targetId)
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, NAMESPACE, true))
    const editor = await control()
    let recycling: ReturnType<typeof outcome> | undefined
    try {
      await paused.wait()
      recycling = outcome(editor.client.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [fixture.targetId]))
      const waiting = await blockedQuery(editor.pid, paused.holder())
      expect(waiting).toContain('deleted_at')
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
    } finally {
      paused.release()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
      if (recycling) expect((await recycling).ok).toBe(true)
      await editor.close()
    }
    expect((await observer.query('SELECT deleted_at IS NULL AS live FROM users WHERE id = $1', [fixture.targetId])).rows).toEqual([{ live: true }])
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
    expectOneRoot()
  })

  test('same-client synthetic XX000 on the admin-child share skips timeout restore and writes nothing', async () => {
    const fixture = await world('member')
    state.serverFault = async (sql, _params, client) => {
      if (!ADMIN_SHARE.test(sql)) return
      state.serverFault = undefined
      await client.query("DO $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_ABORTED_ADMIN_SHARE' USING ERRCODE = 'XX000'; END $$")
    }
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual(serverFailure())
    expect(state.traces).toHaveLength(1)
    const trace = state.traces[0]
    expect(trace?.committed).toBe(false)
    const shareAt = trace?.sql.findIndex(sql => ADMIN_SHARE.test(sql)) ?? -1
    expect(shareAt).toBeGreaterThan(0)
    expect(trace?.params[shareAt - 1]).toEqual(['5000', '10000'])
    expect(trace?.sql.slice(shareAt + 1).some(sql => sql.includes("set_config('lock_timeout'"))).toBe(false)
    expect(admissionWrites(trace)).toEqual([])
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
  })

  it.each([
    ['acquire', '55P03', false],
    ['acquire', '57014', false],
    ['acquire', '40P01', false],
    ['acquire', '40001', false],
    ['work', '55P03', false],
    ['work', '57014', false],
    ['work', '40P01', false],
    ['work', '40001', false],
    ['acquire', '40001', true],
    ['work', '40001', true],
    ['acquire', 'XX000', false],
    ['work', 'XX000', false],
  ] as const)('injected %s SQLSTATE %s marker %s is one uncommitted root and is not a physical lock', async (phase, code, marker) => {
    const fixture = await world('raw')
    const priorGrant = `p1h-grant-${randomUUID()}`
    await seedAdmission(fixture.targetId, NEIGHBOR, true, priorGrant)
    const matches = phase === 'acquire' ? worldShared : (sql: string) => ADMISSION_INSERT.test(sql)
    let used = false
    state.injectBeforeQuery = (sql) => {
      if (used || !matches(sql)) return undefined
      used = true
      return syntheticSqlState(code, marker)
    }
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    expect(used).toBe(true)
    if (marker || code === 'XX000') {
      expect(response.statusCode).toBe(500)
      expect(response.body).toEqual(serverFailure())
    } else {
      expect(response.statusCode).toBe(409)
      expect(response.body).toEqual(busyBody())
    }
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.business).toBe(true)
    expect(state.traces[0]?.committed).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NEIGHBOR, enabled: true, source: 'platform_admin', granted_by: priorGrant, updated_by: priorGrant },
    ])
    if (phase === 'acquire') {
      const worldAt = state.traces[0]?.sql.findIndex(worldShared) ?? -1
      expect(worldAt).toBeGreaterThanOrEqual(0)
      expect(state.traces[0]?.sql.slice(worldAt + 1).some(sql => sql.includes("set_config('lock_timeout'"))).toBe(false)
    }
  }, 20_000)

  test('commit acknowledgement loss is 500, keeps the row, and does not cache, audit, or replay', async () => {
    const fixture = await world('raw')
    state.failCommitAck = true
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual(serverFailure())
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(true)
    expect(state.events).toEqual(['BUSINESS_COMMIT'])
    expect(state.cacheUserIds).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
  })

  test('post-commit readback failure is 500, keeps the row, and does not cache, audit, or replay', async () => {
    const fixture = await world('raw')
    state.failReadback = true
    const response = await invoke(fixture.actorId, fixture.targetId, NAMESPACE, true)
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual(serverFailure())
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(true)
    expect(state.events).toEqual(['BUSINESS_COMMIT'])
    expect(state.readsAtCache).toBe(-1)
    expect(state.cacheUserIds).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
    expect(state.poolSql.some(sql => sql.includes('FROM user_namespace_admissions'))).toBe(true)
    expect(await storedAdmissions([fixture.targetId])).toEqual([
      { user_id: fixture.targetId, namespace: NAMESPACE, enabled: true, source: 'platform_admin', granted_by: fixture.actorId, updated_by: fixture.actorId },
    ])
  })

  it.each([
    ['blank user id', '', NAMESPACE, true, 'USER_ID_REQUIRED', 'userId is required'],
    ['whitespace user id', '   ', NAMESPACE, true, 'USER_ID_REQUIRED', 'userId is required'],
    ['blank namespace', 'present-user', '', true, 'NAMESPACE_REQUIRED', 'namespace is required'],
    ['whitespace namespace', 'present-user', '   ', true, 'NAMESPACE_REQUIRED', 'namespace is required'],
    ['excluded admin namespace', 'present-user', 'admin', true, 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
    ['trimmed excluded admin namespace', 'present-user', '  admin  ', true, 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
    ['excluded multitable namespace', 'present-user', 'multitable', true, 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
    ['excluded workflow namespace', 'present-user', 'workflow', true, 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
    ['excluded approvals namespace', 'present-user', 'approvals', true, 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
    ['star namespace', 'present-user', '*', true, 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
    ['missing enabled', 'present-user', NAMESPACE, undefined, 'ENABLED_REQUIRED', 'enabled boolean is required'],
    ['null enabled', 'present-user', NAMESPACE, null, 'ENABLED_REQUIRED', 'enabled boolean is required'],
    ['string enabled', 'present-user', NAMESPACE, 'true', 'ENABLED_REQUIRED', 'enabled boolean is required'],
    ['numeric enabled', 'present-user', NAMESPACE, 1, 'ENABLED_REQUIRED', 'enabled boolean is required'],
    ['empty-string enabled', 'present-user', NAMESPACE, '', 'ENABLED_REQUIRED', 'enabled boolean is required'],
  ] as const)('rejects %s before a root', async (_label, userId, namespace, enabled, code, message) => {
    const fixture = await world('raw')
    const response = await invoke(fixture.actorId, userId, namespace, enabled)
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual(failure(code, message))
    expect(state.traces).toEqual([])
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
  }, 20_000)
})
