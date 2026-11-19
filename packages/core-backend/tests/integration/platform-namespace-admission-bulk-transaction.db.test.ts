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
  poolParams: [] as unknown[][],
  outOfRoot: [] as string[],
  events: [] as string[],
  cacheUserIds: [] as string[],
  active: 0,
  readsAtCache: -1,
  auditSeen: 0,
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
    const service = new actual.ConnectionPool({ connectionString: process.env.DATABASE_URL, max: 6, name: 'platform-namespace-admission-bulk-db' })
    const built = {
      getInternalPool: () => service.getInternalPool(),
      query: async (sql: string, params?: unknown[]) => {
        const compact = sql.replace(/\s+/g, ' ').trim()
        state.poolSql.push(compact)
        state.poolParams.push(params ?? [])
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
      const reads = state.poolSql.filter(sql => sql.includes('FROM user_namespace_admissions')).length
      if (state.readsAtCache < 0) state.readsAtCache = reads
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
const admissionPath = '/api/admin/users/namespaces/:namespace/admission/bulk'
const ROLE_SHARE = /SELECT id::text AS id FROM roles WHERE id = \$1::text FOR SHARE/
const ROLE_UPDATE = /SELECT id::text AS id FROM roles WHERE id = \$1::text FOR UPDATE/
const ADMISSION = /SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/
const USER_LOCK = /FROM users WHERE id = \$1::text FOR UPDATE/
const ADMIN_CHILD_READ = /SELECT role_id FROM user_roles WHERE user_id = \$1 AND role_id = 'admin'/
const SUBJECT_VERSION_BUMP = /^INSERT INTO subject_authorization_versions /
const ADMIN_SHARE = /SELECT role_id FROM user_roles WHERE user_id = \$1 AND role_id = 'admin' FOR SHARE/
const ADMISSION_INSERT = /INSERT INTO user_namespace_admissions\b/
const WORLD_SHARED = 'pg_advisory_xact_lock_shared(20261106, 1)'
const EXISTENCE = 'SELECT id FROM users WHERE id = ANY($1::text[])'
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
  state.poolParams = []
  state.outOfRoot = []
  state.events = []
  state.cacheUserIds = []
  state.readsAtCache = -1
  state.auditSeen = 0
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
  expect(root?.sql.some(sql => sql.includes('FROM user_namespace_admissions'))).toBe(false)
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
  return (trace?.sql ?? []).flatMap((sql, index) => ADMISSION_INSERT.test(sql) ? [index] : [])
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
  return failure('MEMBER_NAMESPACE_ADMISSION_BULK_FAILED', 'Failed to update namespace admission in bulk')
}
function syntheticSqlState(code: string, marker: boolean) {
  return Object.assign(new Error(marker ? RECOVERY_AUTHORITY_BUSY_MARKER : `SYNTHETIC_SQLSTATE_${code}`), {
    code,
    synthetic: 'not-a-physical-lock',
  })
}
function requestIds(laterId: string, earlierId: string) {
  return [laterId, earlierId, laterId, `  ${laterId}  `, '   ', 8675309]
}
function row(userId: string, namespace: string, enabled: boolean, grantedBy: string | null, updatedBy: string | null): AdmissionRow {
  return { user_id: userId, namespace, enabled, source: 'platform_admin', granted_by: grantedBy, updated_by: updatedBy }
}
function auditEntry(actorId: string, userId: string, namespace: string, enabled: boolean, selectionSize: number) {
  return {
    actorId,
    actorType: 'user',
    action: enabled ? 'grant' : 'revoke',
    resourceType: 'user-namespace-admission',
    resourceId: `${userId}:${namespace}`,
    meta: { adminUserId: actorId, userId, namespace, enabled, mode: 'bulk', selectionSize },
  }
}

const preflightCases: Array<[string, unknown, unknown, unknown, string, string]> = [
  ['blank namespace', '', true, ['present-user'], 'NAMESPACE_REQUIRED', 'namespace is required'],
  ['whitespace namespace', '   ', true, ['present-user'], 'NAMESPACE_REQUIRED', 'namespace is required'],
  ['missing enabled', NAMESPACE, undefined, ['present-user'], 'ENABLED_REQUIRED', 'enabled boolean is required'],
  ['null enabled', NAMESPACE, null, ['present-user'], 'ENABLED_REQUIRED', 'enabled boolean is required'],
  ['string enabled', NAMESPACE, 'true', ['present-user'], 'ENABLED_REQUIRED', 'enabled boolean is required'],
  ['numeric enabled', NAMESPACE, 1, ['present-user'], 'ENABLED_REQUIRED', 'enabled boolean is required'],
  ['empty-string enabled', NAMESPACE, '', ['present-user'], 'ENABLED_REQUIRED', 'enabled boolean is required'],
  ['missing userIds', NAMESPACE, true, undefined, 'USER_IDS_REQUIRED', 'userIds array is required'],
  ['empty userIds', NAMESPACE, true, [], 'USER_IDS_REQUIRED', 'userIds array is required'],
  ['string userIds', NAMESPACE, true, 'present-user', 'USER_IDS_REQUIRED', 'userIds array is required'],
  ['object userIds', NAMESPACE, true, { id: 'present-user' }, 'USER_IDS_REQUIRED', 'userIds array is required'],
  ['numeric-only userIds', NAMESPACE, true, [8675309], 'USER_IDS_REQUIRED', 'userIds array is required'],
  ['whitespace-only userIds', NAMESPACE, true, ['   ', ''], 'USER_IDS_REQUIRED', 'userIds array is required'],
  ['excluded admin namespace', 'admin', true, ['present-user'], 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
  ['trimmed excluded admin namespace', '  admin  ', true, ['present-user'], 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
  ['excluded multitable namespace', 'multitable', true, ['present-user'], 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
  ['excluded workflow namespace', 'workflow', true, ['present-user'], 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
  ['excluded approvals namespace', 'approvals', true, ['present-user'], 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
  ['star namespace', '*', true, ['present-user'], 'NAMESPACE_NOT_SUPPORTED', 'namespace is not managed by plugin admission controls'],
]
const busyCases: Array<['acquire' | 'work', string, boolean]> = [
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
]

describeWithDatabase('platform namespace admission bulk on the real pool; registered handler excludes authentication', () => {
  let observer: PgPool
  let handler: Handle
  const userIds: string[] = []
  const controls: Array<{ close: () => Promise<void> }> = []

  beforeAll(async () => {
    observer = new PgPool({ connectionString: databaseUrl, max: 4 })
    state.open()
    await observer.query('SELECT 1')
    const router = adminUsersRouter() as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }> }
    const layer = router.stack.find(entry => entry.route?.path === admissionPath && entry.route.methods.post)
    if (!layer?.route || layer.route.stack.length < 2) throw new Error('EXPECTED_REGISTERED_HANDLER')
    expect(() => layer.route?.stack[0].handle()).toThrow('HANDLER_SEAM_NOT_AUTH_E2E')
    handler = layer.route.stack[layer.route.stack.length - 1].handle
  })
  beforeEach(() => {
    expect(state.active).toBe(0)
    rewind()
    state.audit.mockReset().mockImplementation(() => {
      expect(state.active).toBe(0)
      expect(state.events[0]).toBe('BUSINESS_COMMIT')
      expect(state.cacheUserIds.length).toBeGreaterThan(0)
      expect(state.events.filter(event => event === 'cache')).toHaveLength(state.cacheUserIds.length)
      expect(state.events.filter(event => event === 'audit')).toHaveLength(state.auditSeen)
      state.auditSeen += 1
      state.events.push('audit')
      return Promise.resolve()
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
  async function insertUser(sort: 'a' | 'b' | 'n' | 'z', rawRole: string, life: Life) {
    const userId = `p1i-${sort}-${randomUUID()}`
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
    const actorId = actor === 'missing' ? `p1i-z-${randomUUID()}` : await insertUser('z', actor === 'raw' ? 'admin' : 'user', actorLife)
    if (actor === 'member') await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    const earlierId = await insertUser('a', 'user', targetLife)
    const laterId = await insertUser('b', 'user', targetLife)
    const neighborId = await insertUser('n', 'user', 'live')
    return { actorId, earlierId, laterId, neighborId }
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
  async function invoke(actorId: string, namespace: unknown, body: Record<string, unknown>) {
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this },
      json(payload: unknown) { this.body = JSON.parse(JSON.stringify(payload)); return this },
    }
    await Promise.resolve(handler({
      method: 'POST', headers: {}, query: {}, params: { namespace }, body, user: { id: actorId, role: 'admin' },
    }, response, (error?: unknown) => { if (error) throw error }))
    return response
  }
  function expectBulkEffects(actorId: string, namespace: string, enabled: boolean, orderedIds: string[]) {
    expect(state.cacheUserIds).toEqual(orderedIds)
    expect(state.readsAtCache).toBe(0)
    expect(state.events).toEqual(['BUSINESS_COMMIT', ...orderedIds.map(() => 'cache'), ...orderedIds.map(() => 'audit')])
    expect(state.audit.mock.calls.map(call => call[0])).toEqual(orderedIds.map(userId => auditEntry(actorId, userId, namespace, enabled, orderedIds.length)))
  }
  function expectNoEffects() {
    expect(state.audit).not.toHaveBeenCalled()
    expect(state.cacheUserIds).toEqual([])
    expect(state.events).not.toContain('BUSINESS_COMMIT')
    expect(state.outOfRoot).toEqual([])
  }
  function expectRolledBack() {
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.business).toBe(true)
    expect(state.traces[0]?.committed).toBe(false)
    expectNoEffects()
  }
  function lockOrder(ids: string[]) {
    const subjects = [...ids].sort()
    return { r3: subjects.map(id => `namespace-admission:${id}`), r5: subjects }
  }

  it.each(preflightCases)('rejects %s before a root', async (_label, namespace, enabled, userIdsBody, code, message) => {
    const fixture = await world('raw')
    const response = await invoke(fixture.actorId, namespace, { enabled, userIds: userIdsBody })
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual(failure(code, message))
    expect(state.traces).toEqual([])
    expect(state.poolSql).toEqual([])
    expectNoEffects()
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId])).toEqual([])
  }, 20_000)

  test('missing ids keep request order and open no root', async () => {
    const fixture = await world('raw')
    const missingLater = `p1i-b-${randomUUID()}`
    const missingEarlier = `p1i-a-${randomUUID()}`
    const response = await invoke(fixture.actorId, NAMESPACE, {
      enabled: true,
      userIds: [missingLater, fixture.earlierId, missingEarlier, '   ', 8675309, `  ${fixture.earlierId}  `],
    })
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'USERS_NOT_FOUND',
        message: 'One or more users were not found',
        details: { missingUserIds: [missingLater, missingEarlier] },
      },
    })
    expect(state.traces).toEqual([])
    expect(state.poolSql).toEqual([EXISTENCE])
    expect(state.poolParams).toEqual([[[missingLater, fixture.earlierId, missingEarlier]]])
    expectNoEffects()
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId])).toEqual([])
  })

  test('raw admin writes sorted targets, keeps request order, and leaves the neighbor unchanged', async () => {
    const fixture = await world('raw')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const ordered = [fixture.laterId, fixture.earlierId]
    const response = await invoke(fixture.actorId, `  ${NAMESPACE}  `, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    const root = expectOneRoot()
    expect(subjectLocks(root)).toEqual(lockOrder([fixture.earlierId, fixture.laterId, fixture.actorId]))
    const worldAt = root.sql.findIndex(worldShared)
    expect(root.sql.findIndex(sql => sql.includes('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'))).toBeLessThan(worldAt)
    expect(worldAt).toBeLessThan(root.sql.findIndex(sql => ADMISSION.test(sql)))
    expect(root.sql.findLastIndex(sql => ADMISSION.test(sql))).toBeLessThan(root.sql.findIndex(sql => USER_LOCK.test(sql)))
    expect(root.sql.findLastIndex(sql => USER_LOCK.test(sql))).toBeLessThan(admissionWrites(root)[0] ?? -1)
    expect(root.sql.some(sql => ADMIN_CHILD_READ.test(sql))).toBe(false)
    const inserts = admissionWrites(root)
    expect(inserts).toHaveLength(2)
    expect(root.params[inserts[0] ?? -1]).toEqual([fixture.earlierId, NAMESPACE, true, 'platform_admin', fixture.actorId, fixture.actorId])
    expect(root.params[inserts[1] ?? -1]).toEqual([fixture.laterId, NAMESPACE, true, 'platform_admin', fixture.actorId, fixture.actorId])
    expect(state.poolSql[0]).toBe(EXISTENCE)
    expect(state.poolParams[0]).toEqual([ordered])
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: { actorId: fixture.actorId, namespace: NAMESPACE, enabled: true, updatedCount: 2, userIds: ordered },
    })
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expectBulkEffects(fixture.actorId, NAMESPACE, true, ordered)
  })

  test('disabling preserves granted_by on both targets and leaves the neighbor unchanged', async () => {
    const fixture = await world('raw')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.earlierId, NAMESPACE, true, priorGrant)
    await seedAdmission(fixture.laterId, NAMESPACE, true, priorGrant)
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const ordered = [fixture.laterId, fixture.earlierId]
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: false, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    const root = expectOneRoot()
    const inserts = admissionWrites(root)
    expect(root.params[inserts[0] ?? -1]).toEqual([fixture.earlierId, NAMESPACE, false, 'platform_admin', null, fixture.actorId])
    expect(root.params[inserts[1] ?? -1]).toEqual([fixture.laterId, NAMESPACE, false, 'platform_admin', null, fixture.actorId])
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: { actorId: fixture.actorId, namespace: NAMESPACE, enabled: false, updatedCount: 2, userIds: ordered },
    })
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, false, priorGrant, fixture.actorId),
      row(fixture.laterId, NAMESPACE, false, priorGrant, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expectBulkEffects(fixture.actorId, NAMESPACE, false, ordered)
  })

  test('membership admission takes R0, all R3, all R5, then one admin-child share inside 5000/10000', async () => {
    const fixture = await world('member')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, true, priorGrant)
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    const root = expectOneRoot()
    expect(subjectLocks(root)).toEqual(lockOrder([fixture.earlierId, fixture.laterId, fixture.actorId]))
    const shareAt = root.sql.findIndex(sql => ADMIN_SHARE.test(sql))
    expect(root.sql.filter(sql => ADMIN_SHARE.test(sql))).toHaveLength(1)
    expect(root.params[shareAt]).toEqual([fixture.actorId])
    expect(root.sql[shareAt - 1]).toContain("set_config('lock_timeout'")
    expect(root.params[shareAt - 1]).toEqual(['5000', '10000'])
    expect(root.sql[shareAt + 1]).toContain("set_config('lock_timeout'")
    expect(shareAt).toBeGreaterThan(root.sql.findLastIndex(sql => USER_LOCK.test(sql)))
    expect(admissionWrites(root)[0] ?? -1).toBeGreaterThan(shareAt)
    expect(response.statusCode).toBe(200)
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, true, priorGrant, priorGrant),
    ])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
    expectBulkEffects(fixture.actorId, NAMESPACE, true, [fixture.laterId, fixture.earlierId])
  })

  test('actor and one target are one subject and one write', async () => {
    const actorId = await insertUser('a', 'admin', 'live')
    const neighborId = await insertUser('n', 'user', 'live')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(neighborId, NEIGHBOR, false, priorGrant)
    const response = await invoke(actorId, NAMESPACE, { enabled: true, userIds: [actorId, actorId, `  ${actorId}  `, '   ', 8675309] })
    const root = expectOneRoot()
    expect(subjectLocks(root)).toEqual(lockOrder([actorId]))
    expect(root.sql.some(sql => ADMIN_CHILD_READ.test(sql))).toBe(false)
    const inserts = admissionWrites(root)
    expect(inserts).toHaveLength(1)
    expect(root.params[inserts[0] ?? -1]).toEqual([actorId, NAMESPACE, true, 'platform_admin', actorId, actorId])
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: { actorId, namespace: NAMESPACE, enabled: true, updatedCount: 1, userIds: [actorId] },
    })
    expect(await storedAdmissions([actorId, neighborId])).toEqual([
      row(actorId, NAMESPACE, true, actorId, actorId),
      row(neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expectBulkEffects(actorId, NAMESPACE, true, [actorId])
  })

  it.each(['inactive', 'pending'] as const)('keeps a %s target writable', async life => {
    const fixture = await world('raw', life)
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    expect(response.statusCode).toBe(200)
    expectOneRoot()
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
  }, 20_000)

  it.each(['inactive', 'pending', 'deleted', 'missing'] as const)('a %s actor is 403 before a recycled later target is 409', async actor => {
    const fixture = await world(actor)
    const priorGrant = `p1i-grant-${randomUUID()}`
    await observer.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [fixture.laterId])
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual(failure('FORBIDDEN', 'Admin access required'))
    expectRolledBack()
    expect(state.traces[0]?.sql.some(sql => ADMIN_CHILD_READ.test(sql))).toBe(false)
    expect(admissionWrites(state.traces[0])).toEqual([])
    expect(state.poolSql[0]).toBe(EXISTENCE)
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId])).toEqual([
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
  }, 20_000)

  it.each(['deleted_at', 'purged_at'] as const)('setting %s on the later target after preflight is 409 and inserts nothing', async column => {
    const fixture = await world('member')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query(`UPDATE users SET ${column} = NOW() WHERE id = $1`, [fixture.laterId]).then(() => undefined))
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual(failure('USER_IN_RECYCLE_BIN', '账号在回收站中，请先恢复后再修改权限'))
    expectRolledBack()
    expect(state.traces[0]?.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(true)
    expect(admissionWrites(state.traces[0])).toEqual([])
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId])).toEqual([
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
  }, 20_000)

  test('deleting the later target after preflight is 404 and inserts nothing', async () => {
    const fixture = await world('member')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query('DELETE FROM users WHERE id = $1', [fixture.laterId]).then(() => undefined))
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual(failure('NOT_FOUND', 'User not found'))
    expectRolledBack()
    expect(state.traces[0]?.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(true)
    expect(admissionWrites(state.traces[0])).toEqual([])
    expect(await storedAdmissions([fixture.earlierId, fixture.neighborId])).toEqual([
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
  })

  test('a failure on the second helper rolls both targets back', async () => {
    const fixture = await world('raw')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    let seen = 0
    state.injectBeforeQuery = (sql) => {
      if (!ADMISSION_INSERT.test(sql)) return undefined
      seen += 1
      if (seen < 2) return undefined
      return new Error('SYNTHETIC_SECOND_HELPER')
    }
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    expect(seen).toBe(2)
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual(serverFailure())
    expectRolledBack()
    const inserts = admissionWrites(state.traces[0])
    expect(state.traces[0]?.params[inserts[0] ?? -1]).toEqual([fixture.earlierId, NAMESPACE, true, 'platform_admin', fixture.actorId, fixture.actorId])
    expect(state.traces[0]?.params[inserts[1] ?? -1]?.[0]).toBe(fixture.laterId)
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId])).toEqual([
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
  })

  test('deleting the admin child before its share is 403 and writes nothing', async () => {
    const fixture = await world('member')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    // D21 (Y5a): the access-graph mutex takes the actor's subject version row before the users rows and
    // holds it to commit, and the membership DELETE's trigger needs that row, so a revocation can no
    // longer land between the mutex and the admin-child share; it commits just before the mutex.
    beforeMatching(SUBJECT_VERSION_BUMP, async () => {
      const client = await observer.connect()
      try {
        await client.query("SET lock_timeout = '400ms'")
        await client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])
      } finally {
        await client.query('RESET lock_timeout').catch(() => undefined)
        client.release()
      }
    })
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
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
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId])).toEqual([
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([])
  })

  test('admin child share blocks deletion until the business commit', async () => {
    const fixture = await world('member')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const paused = pause(ADMIN_CHILD_READ)
    const pending = outcome(invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) }))
    const editor = await control()
    let deleting: ReturnType<typeof outcome> | undefined
    try {
      await paused.wait()
      deleting = outcome(editor.client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId]))
      await blockedQuery(editor.pid, paused.holder())
      expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId])).toEqual([
        row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
      ])
      expect(state.events).not.toContain('BUSINESS_COMMIT')
    } finally {
      paused.release()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
      if (deleting) expect((await deleting).ok).toBe(true)
      await editor.close()
    }
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
    expectOneRoot()
  })

  test('held world exclusive lock blocks R0 before any R3 or R5', async () => {
    const fixture = await world('raw')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const holder = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT pg_advisory_xact_lock(20261106, 1)')
      pending = outcome(invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) }))
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
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expectOneRoot()
  })

  test('held first target R3 blocks before any R5', async () => {
    const fixture = await world('raw')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const holder = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`namespace-admission:${fixture.earlierId}`])
      pending = outcome(invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) }))
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(waiting.includes('hashtextextended')).toBe(true)
      expect(waiting.includes('FOR UPDATE')).toBe(false)
      expect(statement.params).toEqual([`namespace-admission:${fixture.earlierId}`])
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
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expectOneRoot()
  })

  test('held first target user row blocks the first FOR UPDATE after all R3 and before a child read', async () => {
    const fixture = await world('member')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const holder = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT id::text AS id FROM users WHERE id = $1::text FOR UPDATE', [fixture.earlierId])
      pending = outcome(invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) }))
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(waiting).toContain('FROM users')
      expect(waiting).toContain('FOR UPDATE')
      expect(waiting).not.toContain('FOR SHARE')
      expect(statement.params).toEqual([fixture.earlierId])
      expect(subjectLocks(state.live as Trace)).toEqual({
        r3: [fixture.earlierId, fixture.laterId, fixture.actorId].sort().map(id => `namespace-admission:${id}`),
        r5: [fixture.earlierId],
      })
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
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expectOneRoot()
  })

  test('the writer user lock blocks a concurrent recycle update until commit', async () => {
    const fixture = await world('raw')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const paused = pause(USER_LOCK, fixture.earlierId)
    const pending = outcome(invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) }))
    const editor = await control()
    let recycling: ReturnType<typeof outcome> | undefined
    try {
      await paused.wait()
      recycling = outcome(editor.client.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [fixture.earlierId]))
      const waiting = await blockedQuery(editor.pid, paused.holder())
      expect(waiting).toContain('deleted_at')
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.earlierId, fixture.laterId])).toEqual([])
    } finally {
      paused.release()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
      if (recycling) expect((await recycling).ok).toBe(true)
      await editor.close()
    }
    expect((await observer.query('SELECT deleted_at IS NULL AS live FROM users WHERE id = $1', [fixture.earlierId])).rows).toEqual([{ live: true }])
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expectOneRoot()
  })

  test('same-client synthetic XX000 on the admin-child share skips timeout restore and writes nothing', async () => {
    const fixture = await world('member')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    state.serverFault = async (sql, _params, client) => {
      if (!ADMIN_SHARE.test(sql)) return
      state.serverFault = undefined
      await client.query("DO $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_ABORTED_ADMIN_SHARE' USING ERRCODE = 'XX000'; END $$")
    }
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual(serverFailure())
    expectRolledBack()
    const trace = state.traces[0]
    const shareAt = trace?.sql.findIndex(sql => ADMIN_SHARE.test(sql)) ?? -1
    expect(shareAt).toBeGreaterThan(0)
    expect(trace?.params[shareAt - 1]).toEqual(['5000', '10000'])
    expect(trace?.sql.slice(shareAt + 1).some(sql => sql.includes("set_config('lock_timeout'"))).toBe(false)
    expect(admissionWrites(trace)).toEqual([])
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId])).toEqual([
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
  })

  it.each(busyCases)('injected %s SQLSTATE %s marker %s is one uncommitted root and is not a physical lock', async (phase, code, marker) => {
    const fixture = await world('raw')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, true, priorGrant)
    let seen = 0
    let used = false
    state.injectBeforeQuery = (sql) => {
      if (phase === 'acquire') {
        if (used || !worldShared(sql)) return undefined
        used = true
        return syntheticSqlState(code, marker)
      }
      if (!ADMISSION_INSERT.test(sql)) return undefined
      seen += 1
      if (seen < 2) return undefined
      used = true
      return syntheticSqlState(code, marker)
    }
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    expect(used).toBe(true)
    if (marker || code === 'XX000') {
      expect(response.statusCode).toBe(500)
      expect(response.body).toEqual(serverFailure())
    } else {
      expect(response.statusCode).toBe(409)
      expect(response.body).toEqual(busyBody())
    }
    expectRolledBack()
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId])).toEqual([
      row(fixture.neighborId, NEIGHBOR, true, priorGrant, priorGrant),
    ])
    if (phase === 'acquire') {
      expect(admissionWrites(state.traces[0])).toEqual([])
      const worldAt = state.traces[0]?.sql.findIndex(worldShared) ?? -1
      expect(worldAt).toBeGreaterThanOrEqual(0)
      expect(state.traces[0]?.sql.slice(worldAt + 1).some(sql => sql.includes("set_config('lock_timeout'"))).toBe(false)
    } else {
      const inserts = admissionWrites(state.traces[0])
      expect(state.traces[0]?.params[inserts[0] ?? -1]?.[0]).toBe(fixture.earlierId)
      expect(state.traces[0]?.params[inserts[1] ?? -1]?.[0]).toBe(fixture.laterId)
    }
  }, 20_000)

  test('commit acknowledgement loss is 500, keeps both rows, and does not cache, audit, or replay', async () => {
    const fixture = await world('raw')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    state.failCommitAck = true
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual(serverFailure())
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(true)
    expect(state.pids).toEqual([state.traces[0]?.pid])
    expect(state.events).toEqual(['BUSINESS_COMMIT'])
    expect(state.cacheUserIds).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
  })

  test('post-commit audit failure is 500, keeps both rows, applies cache, and does not replay', async () => {
    const fixture = await world('raw')
    const priorGrant = `p1i-grant-${randomUUID()}`
    await seedAdmission(fixture.neighborId, NEIGHBOR, false, priorGrant)
    const ordered = [fixture.laterId, fixture.earlierId]
    state.audit.mockReset().mockImplementation(() => Promise.reject(new Error('SYNTHETIC_POST_COMMIT_AUDIT')))
    const response = await invoke(fixture.actorId, NAMESPACE, { enabled: true, userIds: requestIds(fixture.laterId, fixture.earlierId) })
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual(serverFailure())
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(true)
    expect(state.events.filter(event => event === 'BUSINESS_COMMIT')).toEqual(['BUSINESS_COMMIT'])
    expect(state.cacheUserIds).toEqual(ordered)
    expect(state.readsAtCache).toBe(0)
    expect(state.audit.mock.calls.map(call => call[0])).toEqual(ordered.map(userId => auditEntry(fixture.actorId, userId, NAMESPACE, true, ordered.length)))
    expect(state.events).toEqual(['BUSINESS_COMMIT', 'cache', 'cache'])
    expect(await storedAdmissions([fixture.earlierId, fixture.laterId, fixture.neighborId, fixture.actorId])).toEqual([
      row(fixture.earlierId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.laterId, NAMESPACE, true, fixture.actorId, fixture.actorId),
      row(fixture.neighborId, NEIGHBOR, false, priorGrant, priorGrant),
    ])
  })
})
