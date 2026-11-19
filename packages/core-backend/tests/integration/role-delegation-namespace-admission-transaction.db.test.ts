import { randomUUID } from 'node:crypto'
import { SUBJECT_AUTHORIZATION_VERSIONS_BUMP_SQL } from '../../src/multitable/authz-version-protocol'
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
  outOfRoot: [] as string[],
  events: [] as string[],
  cacheUserIds: [] as string[],
  sqlStates: [] as string[],
  active: 0,
  beforeSql: undefined as undefined | ((sql: string, params: unknown[] | undefined, pid: number) => Promise<void>),
  afterSql: undefined as undefined | ((sql: string, params: unknown[] | undefined, pid: number, nativeResult: unknown) => Promise<void>),
  audit: vi.fn(async (..._args: unknown[]) => undefined),
}))

vi.mock('../../src/integration/db/connection-pool', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  let surface: ReturnType<typeof state.open> | undefined
  state.open = () => {
    if (surface) return surface
    const service = new actual.ConnectionPool({ connectionString: process.env.DATABASE_URL, max: 6, name: 'role-delegation-namespace-admission-db' })
    const built = {
      getInternalPool: () => service.getInternalPool(),
      query: async (sql: string, params?: unknown[]) => {
        const compact = sql.replace(/\s+/g, ' ').trim()
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
              await state.beforeSql?.(compact, params, trace.pid)
              try {
                const queryResult = await client.query(sql, params)
                await state.afterSql?.(compact, params, trace.pid, queryResult)
                return queryResult
              } catch (error) {
                const code = (error as { code?: unknown })?.code
                if (typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code)) {
                  state.sqlStates.push(code)
                  console.log(JSON.stringify({ phase: 'p1k-native-query-failure', code }))
                }
                throw error
              }
            } })
          })
          trace.committed = true
          if (trace.business) state.events.push('BUSINESS_COMMIT')
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
      state.cacheUserIds.push(userId)
      state.events.push('cache')
      return actual.invalidateUserPerms(userId)
    },
  }
})

import { adminUsersRouter } from '../../src/routes/admin-users'
import { isUserWithinDelegatedScope } from '../../src/admin/delegated-authority'

const databaseUrl = process.env.DATABASE_URL
if (process.env.EXPECT_DB !== '1' || !databaseUrl) throw new Error('P1k requires EXPECT_DB=1 and DATABASE_URL; module load refuses a skip-shaped green')
const describeWithDatabase = describe
const admissionPath = '/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission'
const ROLE_SHARE = /SELECT id::text AS id FROM roles WHERE id = \$1::text FOR SHARE/
const ROLE_UPDATE = /SELECT id::text AS id FROM roles WHERE id = \$1::text FOR UPDATE/
const ADMISSION_LOCK = /SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/
const USER_LOCK = /FROM users WHERE id = \$1::text FOR UPDATE/
const ADMIN_CHILD_READ = /SELECT role_id FROM user_roles WHERE user_id = \$1 AND role_id = 'admin'/
const ADMIN_SHARE = /SELECT role_id FROM user_roles WHERE user_id = \$1 AND role_id = 'admin' FOR SHARE/
const DERIVING_SHARE = /SELECT role_id FROM user_roles WHERE user_id = \$1 AND role_id = ANY\(\$2::text\[\]\) ORDER BY role_id FOR SHARE/
const CHILD_ENUM = /child\.integration_id = ANY\(\$1::uuid\[\]\)/
const CHILD_ENUM_TEXT = /integration_id = ANY\(\$1::text\[\]\)/
const DEPARTMENT_SHARE = /SELECT id FROM directory_departments WHERE id = \$1 FOR SHARE/
const MEMBERSHIP_SHARE = /SELECT group_id, user_id FROM platform_member_group_members WHERE group_id = \$1 AND user_id = \$2 FOR SHARE/
const ADMISSION_INSERT = /INSERT INTO user_namespace_admissions\b/
const WORLD_SHARED = 'pg_advisory_xact_lock_shared(20261106, 1)'
const ARCHIVE_SQL = 'UPDATE directory_departments SET is_active = false, updated_at = NOW() WHERE id = $1'
const REPARENT_SQL = `UPDATE directory_departments
          SET name = $1, external_parent_department_id = $2, order_index = $3, updated_at = NOW()
        WHERE id = $4`
const PROJECTION_MEMBER_DELETE_SQL = `DELETE FROM platform_member_group_members
         WHERE group_id = $1
           AND user_id = ANY($2::text[])`
const DEPARTMENT_UPSERT_SQL = `INSERT INTO directory_departments (
             integration_id, provider, external_department_id, external_parent_department_id, name,
             full_path, order_index, is_active, raw, last_seen_at, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb, $9, NOW(), NOW())
           ON CONFLICT (integration_id, external_department_id)
           DO UPDATE SET
             external_parent_department_id = EXCLUDED.external_parent_department_id,
             name = EXCLUDED.name,
             full_path = EXCLUDED.full_path,
             order_index = EXCLUDED.order_index,
             is_active = true,
             raw = EXCLUDED.raw,
             last_seen_at = EXCLUDED.last_seen_at,
             updated_at = NOW()
           RETURNING (xmax = 0) AS created`
const ADMIN_CHILD_DELETE = "DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'"
const releases: Array<() => void> = []

type Handle = (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown
type Trace = { pid: number; sql: string[]; params: unknown[][]; business: boolean; committed: boolean }
type Life = 'live' | 'inactive' | 'pending'
type AdmissionRow = { user_id: string; namespace: string; enabled: boolean; source: string; granted_by: string | null; updated_by: string | null }
type Claim = 'platform' | 'delegated'

function rewind() {
  state.traces = []
  state.live = undefined
  state.pids = []
  state.outOfRoot = []
  state.events = []
  state.cacheUserIds = []
  state.sqlStates = []
  state.beforeSql = undefined
  state.afterSql = undefined
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
function parkBefore(pattern: RegExp) {
  const resume = gate()
  let entered = false
  let holder = 0
  state.beforeSql = async (sql, _params, pid) => {
    if (entered || !pattern.test(sql)) return
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
function byCodeUnit(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}
function subjectsOf(actorId: string, targetId: string) {
  return [actorId, targetId].sort(byCodeUnit)
}
function ownedNamespace() {
  return `p1k${randomUUID().replaceAll('-', '')}`
}
function matches(trace: Trace | undefined, pattern: RegExp) {
  return (trace?.sql ?? []).flatMap((sql, index) => pattern.test(sql) ? [index] : [])
}
function expectCommittedRoot() {
  expect(state.outOfRoot).toEqual([])
  expect(state.traces.map(trace => trace.business)).toEqual([true])
  const root = state.traces[0]
  expect(root?.committed).toBe(true)
  expect(state.pids).toEqual([root?.pid])
  expect(root?.sql.filter(worldShared)).toHaveLength(1)
  expect(root?.sql.some(sql => ROLE_UPDATE.test(sql) || sql.includes('user-recycle:platform-admin'))).toBe(false)
  if (!root) throw new Error('ROOT_TRACE_MISSING')
  return root
}
function expectRootOrder(trace: Trace, roleIds: readonly string[], subjects: readonly string[]) {
  const worldAt = trace.sql.findIndex(worldShared)
  const isolationAt = trace.sql.findIndex(sql => sql.includes('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'))
  const roleIndexes = matches(trace, ROLE_SHARE)
  const admissionIndexes = matches(trace, ADMISSION_LOCK)
  const userIndexes = matches(trace, USER_LOCK)
  expect(isolationAt).toBeGreaterThanOrEqual(0)
  expect(worldAt).toBeGreaterThan(isolationAt)
  expect(roleIndexes.map(index => trace.params[index]?.[0])).toEqual([...roleIds])
  expect(worldAt).toBeLessThan(roleIds.length === 0 ? admissionIndexes[0] ?? -1 : roleIndexes[0] ?? -1)
  if (roleIds.length > 0) expect(roleIndexes[roleIndexes.length - 1] ?? -1).toBeLessThan(admissionIndexes[0] ?? -1)
  expect(admissionIndexes.map(index => trace.params[index]?.[0])).toEqual(subjects.map(id => `namespace-admission:${id}`))
  expect(userIndexes.map(index => trace.params[index]?.[0])).toEqual([...subjects])
  expect(admissionIndexes[admissionIndexes.length - 1] ?? -1).toBeLessThan(userIndexes[0] ?? -1)
  expect(trace.sql.some(sql => CHILD_ENUM_TEXT.test(sql))).toBe(false)
}
function childEnumParams(trace: Trace | undefined) {
  expect(trace?.sql.some(sql => CHILD_ENUM_TEXT.test(sql))).toBe(false)
  return matches(trace, CHILD_ENUM).map(index => trace?.params[index]?.[0])
}
function statementParams(trace: Trace | undefined, pattern: RegExp) {
  return matches(trace, pattern).map(index => trace?.params[index])
}
function rootPid() {
  const pid = state.pids[0]
  if (!pid) throw new Error('ROOT_PID_MISSING')
  return pid
}
/**
 * D21 (Y5a): a revoker's uncommitted DELETE on user_roles / platform_member_group_members took the
 * subject's version row through its BEFORE trigger, and the command's access-graph mutex bumps the
 * sorted subjects' version rows first, so the command queues there — before any child or membership
 * share — and reads the committed state after the revoker commits.
 */
function expectQueuedOnSubjectVersions(waiting: string, subjects: readonly string[]) {
  expect(waiting).toContain('INSERT INTO subject_authorization_versions')
  const statement = waitingStatement()
  expect(statement.sql).toBe(SUBJECT_AUTHORIZATION_VERSIONS_BUMP_SQL.replace(/\s+/g, ' ').trim())
  expect(statement.params).toEqual([[...subjects].sort()])
}
function waitingStatement() {
  const live = state.live
  if (!live || live.sql.length === 0) throw new Error('WAITING_STATEMENT_MISSING')
  return { sql: live.sql[live.sql.length - 1] ?? '', params: live.params[live.params.length - 1] ?? [] }
}
function expectAdmissionInsert(trace: Trace, userId: string, namespace: string, actorId: string, source: string) {
  const inserted = trace.sql.findIndex(sql => ADMISSION_INSERT.test(sql))
  expect(inserted).toBeGreaterThan(matches(trace, USER_LOCK).at(-1) ?? Number.MAX_SAFE_INTEGER)
  expect(trace.sql.filter(sql => ADMISSION_INSERT.test(sql))).toHaveLength(1)
  expect(trace.params[inserted]).toEqual([userId, namespace, true, source, actorId, actorId])
}
function test(name: string, fn: () => Promise<void>) {
  it(name, fn, 20_000)
}
function failure(code: string, message: string) {
  return { ok: false, error: { code, message, details: undefined } }
}
function sqlState(error: unknown): string {
  const code = (typeof error === 'object' && error !== null) ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : ''
}
function busyBody() {
  return {
    ok: false,
    error: {
      code: 'AUTHORIZATION_INPUT_BUSY',
      message: 'Authorization inputs are busy; retry this change.',
      details: { retryable: true },
    },
  }
}
function departmentUpsertParams(integrationId: string, externalId: string, parentExternalId: string | null, sentinel: string) {
  return [integrationId, 'dingtalk', externalId, parentExternalId, sentinel, null, 0, '{}', new Date().toISOString()]
}
function nativeRows(nativeResult: unknown): Array<Record<string, unknown>> {
  if (typeof nativeResult !== 'object' || nativeResult === null) throw new Error('NATIVE_RESULT_SHAPE')
  const rows = (nativeResult as { rows?: unknown }).rows
  if (!Array.isArray(rows)) throw new Error('NATIVE_ROWS_SHAPE')
  return rows.map(row => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('NATIVE_ROW_SHAPE')
    return row as Record<string, unknown>
  })
}
function nativeCount(nativeResult: unknown): number {
  if (typeof nativeResult !== 'object' || nativeResult === null) throw new Error('NATIVE_RESULT_SHAPE')
  const rowCount = (nativeResult as { rowCount?: unknown }).rowCount
  if (typeof rowCount !== 'number') throw new Error('NATIVE_ROWCOUNT_SHAPE')
  return rowCount
}
function expectNoEffects() {
  expect(state.audit).not.toHaveBeenCalled()
  expect(state.cacheUserIds).toEqual([])
  expect(state.events).not.toContain('BUSINESS_COMMIT')
  expect(state.outOfRoot).toEqual([])
}
function expectGrantAudit(actorId: string, userId: string, namespace: string, delegated: boolean, delegableNamespaces: string[]) {
  expect(state.cacheUserIds).toEqual([userId])
  expect(state.events).toEqual(['BUSINESS_COMMIT', 'cache', 'audit'])
  expect(state.audit).toHaveBeenCalledWith({
    actorId,
    actorType: 'user',
    action: 'grant',
    resourceType: 'user-namespace-admission',
    resourceId: `${userId}:${namespace}`,
    meta: { adminUserId: actorId, userId, namespace, enabled: true, delegated, delegableNamespaces },
  })
}

describeWithDatabase('role delegation namespace admission on the real pool; registered handler excludes authentication', () => {
  let observer: PgPool
  let handler: Handle
  const userIds: string[] = []
  const roleIds: string[] = []
  const integrationIds: string[] = []
  const accountIds: string[] = []
  const groupIds: string[] = []
  const controls: Array<{ close: () => Promise<void> }> = []

  beforeAll(async () => {
    observer = new PgPool({ connectionString: databaseUrl, max: 4 })
    state.open()
    await observer.query('SELECT 1')
    const router = adminUsersRouter() as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }> }
    const layer = router.stack.find(entry => entry.route?.path === admissionPath && entry.route.methods.patch)
    if (!layer?.route || layer.route.stack.length < 2) throw new Error('EXPECTED_REGISTERED_HANDLER')
    expect(() => layer.route?.stack[0].handle(undefined, undefined, () => undefined)).toThrow('HANDLER_SEAM_NOT_AUTH_E2E')
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
      ['DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[])', [[...userIds]]],
      ['DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = ANY($1::text[])', [[...userIds]]],
      ['DELETE FROM platform_member_group_members WHERE group_id = ANY($1::uuid[])', [[...groupIds]]],
      ['DELETE FROM directory_account_departments WHERE directory_account_id = ANY($1::uuid[])', [[...accountIds]]],
      ['DELETE FROM directory_account_links WHERE directory_account_id = ANY($1::uuid[])', [[...accountIds]]],
      ['DELETE FROM directory_accounts WHERE id = ANY($1::uuid[])', [[...accountIds]]],
      ['DELETE FROM directory_departments WHERE integration_id = ANY($1::uuid[])', [[...integrationIds]]],
      ['DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [[...integrationIds]]],
      ['DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [[...userIds]]],
      ['DELETE FROM platform_member_groups WHERE id = ANY($1::uuid[])', [[...groupIds]]],
      ['DELETE FROM users WHERE id = ANY($1::text[])', [[...userIds]]],
      ["DELETE FROM roles WHERE id = ANY($1::text[]) AND id <> 'admin' AND id <> 'attendance_admin'", [[...roleIds]]],
    ]
    const cleaner = await observer.connect()
    const failures: unknown[] = []
    try {
      await cleaner.query("SET lock_timeout = '2s'")
      for (const [sql, params] of cleanups) {
        const ids = params[0]
        if (!Array.isArray(ids) || ids.length === 0) continue
        try { await cleaner.query(sql, params) } catch (error) { failures.push(error) }
      }
    } finally {
      await cleaner.query('RESET lock_timeout').catch(() => undefined)
      cleaner.release()
    }
    if (failures.length === 0) {
      userIds.length = 0
      roleIds.length = 0
      integrationIds.length = 0
      accountIds.length = 0
      groupIds.length = 0
    }
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
    let seenPid = 0
    await until(async () => {
      const row = (await observer.query(
        "SELECT pid, query, wait_event_type = 'Lock' AND $2 = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1",
        [waiter, holder],
      )).rows[0]
      seen = String(row?.query ?? '')
      seenPid = Number(row?.pid ?? 0)
      return row?.blocked === true && seenPid === waiter
    }, 'EXPECTED_PHYSICAL_LOCK_WAIT')
    expect(seenPid).toBe(waiter)
    return seen
  }
  async function insertUser(sort: 'a' | 'z', rawRole: string, life: Life) {
    const userId = `p1k-${sort}-${randomUUID()}`
    userIds.push(userId)
    await observer.query(
      `INSERT INTO users (id, username, email, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set)
       VALUES ($1, $1, $2, 'Synthetic role delegation admission fixture', 'synthetic-unused', $3, false, $4, '[]'::jsonb, $5, false)`,
      [userId, `${userId}@example.invalid`, life !== 'inactive', rawRole, life === 'pending' ? 'pending_activation' : 'activated'],
    )
    return userId
  }
  async function insertRole(roleId: string) {
    roleIds.push(roleId)
    await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
  }
  async function platformPair(actor: 'raw' | 'member' | 'inactive', targetLife: Life = 'live') {
    const actorId = await insertUser('z', actor === 'raw' ? 'admin' : 'user', actor === 'inactive' ? 'inactive' : 'live')
    if (actor === 'member') await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    const targetId = await insertUser('a', 'user', targetLife)
    return { actorId, targetId, namespace: ownedNamespace() }
  }
  async function delegatedPair() {
    const namespace = ownedNamespace()
    const roleId = `${namespace}_admin`
    await insertRole(roleId)
    const actorId = await insertUser('z', 'user', 'live')
    const targetId = await insertUser('a', 'user', 'live')
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [actorId, roleId])
    return { actorId, targetId, namespace, roleId }
  }
  async function insertIntegration() {
    const label = `p1k-${randomUUID()}`
    const integrationId = (await observer.query(
      'INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $1) RETURNING id',
      [label],
    )).rows[0].id as string
    integrationIds.push(integrationId)
    return integrationId
  }
  async function insertDepartment(integrationId: string, externalId: string, parentExternalId: string | null) {
    const departmentId = (await observer.query(
      `INSERT INTO directory_departments
         (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, $3, $2, true, '{}'::jsonb)
       RETURNING id`,
      [integrationId, externalId, parentExternalId],
    )).rows[0].id as string
    return departmentId
  }
  async function assertIntegrationUuid(departmentId: string) {
    expect((await observer.query(
      'SELECT pg_typeof(integration_id)::text AS type FROM directory_departments WHERE id = $1',
      [departmentId],
    )).rows).toEqual([{ type: 'uuid' }])
  }
  async function linkLeaf(integrationId: string, userId: string, departmentId: string) {
    const externalUserId = `p1k-account-${randomUUID()}`
    const accountId = (await observer.query(
      `INSERT INTO directory_accounts
         (integration_id, external_user_id, external_key, name, is_active, raw)
       VALUES ($1, $2, $2, 'Synthetic p1k account', true, '{}'::jsonb)
       RETURNING id`,
      [integrationId, externalUserId],
    )).rows[0].id as string
    accountIds.push(accountId)
    await observer.query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual')`,
      [accountId, userId],
    )
    await observer.query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true)`,
      [accountId, departmentId],
    )
  }
  async function insertGroup() {
    const groupId = (await observer.query(
      'INSERT INTO platform_member_groups(name) VALUES ($1) RETURNING id',
      [`p1k-${randomUUID()}`],
    )).rows[0].id as string
    groupIds.push(groupId)
    return groupId
  }
  async function seedScope(actorId: string, namespace: string, departmentId: string, includeChildren = true) {
    await observer.query(
      `INSERT INTO delegated_role_admin_scopes (admin_user_id, namespace, directory_department_id, include_children, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $1, NOW(), NOW())`,
      [actorId, namespace, departmentId, includeChildren],
    )
  }
  async function seedGroup(actorId: string, namespace: string, groupId: string, targetId: string) {
    await observer.query('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2)', [groupId, targetId])
    await observer.query(
      `INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $1, NOW(), NOW())`,
      [actorId, namespace, groupId],
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
  async function invoke(actorId: string, userId: string, namespace: string, enabled: boolean, claim: Claim) {
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this },
      json(payload: unknown) { this.body = payload; return this },
    }
    await Promise.resolve(handler({
      method: 'PATCH',
      headers: {},
      query: {},
      params: { userId, namespace },
      body: { enabled },
      user: { id: actorId, role: claim === 'platform' ? 'admin' : 'user' },
    }, response, (error?: unknown) => { if (error) throw error }))
    return response
  }
  function expectSnapshot(body: unknown, actorId: string, namespace: string, platform: boolean, source: string) {
    const data = (body as { ok?: boolean; data?: { actorId?: string; isPlatformAdmin?: boolean; delegableNamespaces?: string[]; namespaceAdmissions?: Array<Record<string, unknown>> } }).data
    expect((body as { ok?: boolean }).ok).toBe(true)
    expect(data?.actorId).toBe(actorId)
    expect(data?.isPlatformAdmin).toBe(platform)
    expect(data?.delegableNamespaces).toEqual(platform ? [] : [namespace])
    expect(data?.namespaceAdmissions).toEqual([
      expect.objectContaining({ namespace, enabled: true, source, grantedBy: actorId, updatedBy: actorId }),
    ])
  }
  async function expectPersisted(userId: string, namespace: string, actorId: string, source: string) {
    expect(await storedAdmissions([userId])).toEqual([
      { user_id: userId, namespace, enabled: true, source, granted_by: actorId, updated_by: actorId },
    ])
  }

  test('raw admin persists the admission, skips the user_roles child, and orders R0 before every R3 and R5', async () => {
    const fixture = await platformPair('raw')
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'platform')
    const root = expectCommittedRoot()
    expectRootOrder(root, [], subjects)
    expect(root.sql.some(sql => ADMIN_CHILD_READ.test(sql) || DERIVING_SHARE.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    expect(response.statusCode).toBe(200)
    expectSnapshot(response.body, fixture.actorId, fixture.namespace, true, 'platform_admin')
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, false, [])
  })

  test('RBAC admin persists the admission and share-locks the admin child inside the 5000/10000 window', async () => {
    const fixture = await platformPair('member')
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'platform')
    const root = expectCommittedRoot()
    expectRootOrder(root, [], subjects)
    const shareAt = root.sql.findIndex(sql => ADMIN_SHARE.test(sql))
    expect(shareAt).toBeGreaterThan(matches(root, USER_LOCK).at(-1) ?? Number.MAX_SAFE_INTEGER)
    expect(root.params[shareAt]).toEqual([fixture.actorId])
    expect(root.params[shareAt - 1]).toEqual(['5000', '10000'])
    expect(root.sql[shareAt - 1]).toContain("set_config('lock_timeout'")
    expect(root.sql[shareAt + 1]).toContain("set_config('lock_timeout'")
    expect(root.sql.some(sql => DERIVING_SHARE.test(sql) || ROLE_SHARE.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    expect(response.statusCode).toBe(200)
    expectSnapshot(response.body, fixture.actorId, fixture.namespace, true, 'platform_admin')
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, false, [])
  })

  test('inactive target persists for a raw admin and stays writable', async () => {
    const fixture = await platformPair('raw', 'inactive')
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'platform')
    const root = expectCommittedRoot()
    expect(root.sql.some(sql => ADMIN_CHILD_READ.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    expect(response.statusCode).toBe(200)
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    expect((await observer.query('SELECT is_active, deleted_at IS NULL AS present FROM users WHERE id = $1', [fixture.targetId])).rows).toEqual([{ is_active: false, present: true }])
  })

  test('pending target persists for a raw admin and stays writable', async () => {
    const fixture = await platformPair('raw', 'pending')
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'platform')
    const root = expectCommittedRoot()
    expect(root.sql.some(sql => ADMIN_CHILD_READ.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    expect(response.statusCode).toBe(200)
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    expect((await observer.query('SELECT activation_status, deleted_at IS NULL AS present FROM users WHERE id = $1', [fixture.targetId])).rows).toEqual([{ activation_status: 'pending_activation', present: true }])
  })

  test('deleting the target after preflight is 404 before the inactive actor is 403 and writes nothing', async () => {
    const fixture = await platformPair('inactive')
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query('DELETE FROM users WHERE id = $1', [fixture.targetId]).then(() => undefined))
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'platform')
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual(failure('NOT_FOUND', 'User not found'))
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.traces[0]?.sql.some(sql => ADMIN_SHARE.test(sql) || ADMISSION_INSERT.test(sql))).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId, fixture.actorId])).toEqual([])
  })

  test('recycling the target after preflight is 409 before the inactive actor is 403 and writes nothing', async () => {
    const fixture = await platformPair('inactive')
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [fixture.targetId]).then(() => undefined))
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'platform')
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual(failure('USER_IN_RECYCLE_BIN', '账号在回收站中，请先恢复后再修改权限'))
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.traces[0]?.sql.some(sql => ADMIN_SHARE.test(sql) || ADMISSION_INSERT.test(sql))).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId, fixture.actorId])).toEqual([])
  })

  test('delegated group admission persists after an unrelated active uuid seed is enumerated and the department witness stays empty', async () => {
    const fixture = await delegatedPair()
    const integrationId = await insertIntegration()
    const seedExternal = `p1k-seed-${randomUUID()}`
    const seedId = await insertDepartment(integrationId, seedExternal, null)
    await assertIntegrationUuid(seedId)
    await seedScope(fixture.actorId, fixture.namespace, seedId)
    const groupId = await insertGroup()
    await seedGroup(fixture.actorId, fixture.namespace, groupId, fixture.targetId)
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated')
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(childEnumParams(root)).toEqual([[integrationId], [integrationId]])
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual([])
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([[groupId, fixture.targetId]])
    expect(statementParams(root, DERIVING_SHARE)).toEqual([[fixture.actorId, [fixture.roleId]]])
    expect(root.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect(response.statusCode).toBe(200)
    expectSnapshot(response.body, fixture.actorId, fixture.namespace, false, 'delegated_admin')
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect((await observer.query('SELECT is_active FROM directory_departments WHERE id = $1', [seedId])).rows).toEqual([{ is_active: true }])
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  })

  test('revoker commits the admin child first and the admission writes nothing', async () => {
    const fixture = await platformPair('member')
    const holder = await control()
    await holder.client.query(ADMIN_CHILD_DELETE, [fixture.actorId])
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'platform'))
    let committed = false
    let result: Awaited<typeof pending> | undefined
    try {
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      expect(holder.pid).toBeGreaterThan(0)
      expectQueuedOnSubjectVersions(waiting, [fixture.actorId, fixture.targetId])
      expect(state.live?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      await holder.client.query('COMMIT')
      committed = true
    } finally {
      if (!committed) await holder.client.query('ROLLBACK').catch(() => undefined)
      result = await pending
      await holder.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) {
      expect(result.value.statusCode).toBe(403)
      expect(result.value.body).toEqual(failure('FORBIDDEN', 'Admin access required'))
    }
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.traces[0]?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([])
  })

  test('admission holds the admin child share until commit while the revoker delete is blocked', async () => {
    const fixture = await platformPair('member')
    const paused = parkBefore(ADMISSION_INSERT)
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'platform'))
    const editor = await control()
    let deleting: ReturnType<typeof outcome> | undefined
    let result: Awaited<typeof pending> | undefined
    let deleted: Awaited<ReturnType<typeof outcome>> | undefined
    try {
      await paused.wait()
      expect(paused.holder()).toBe(rootPid())
      expect(state.active).toBe(1)
      deleting = outcome(editor.client.query(ADMIN_CHILD_DELETE, [fixture.actorId]))
      const waiting = await blockedQuery(editor.pid, paused.holder())
      expect(waiting).toContain('DELETE FROM user_roles')
      expect(waiting).toContain("role_id = 'admin'")
      expect(state.live?.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(true)
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
    } finally {
      paused.release()
      result = await pending
      if (deleting) deleted = await deleting
      await editor.client.query('COMMIT').catch(async () => { await editor.client.query('ROLLBACK').catch(() => undefined) })
      await editor.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) expect(result.value.statusCode).toBe(200)
    expect(deleted?.ok).toBe(true)
    const root = expectCommittedRoot()
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'platform_admin')
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([])
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, false, [])
  })

  test('uuid seed, intermediate, and leaf stay shared against the local department archive primitive until commit', async () => {
    const fixture = await delegatedPair()
    const integrationId = await insertIntegration()
    const seedExternal = `p1k-seed-${randomUUID()}`
    const intermediateExternal = `p1k-mid-${randomUUID()}`
    const leafExternal = `p1k-leaf-${randomUUID()}`
    const seedId = await insertDepartment(integrationId, seedExternal, null)
    const intermediateId = await insertDepartment(integrationId, intermediateExternal, seedExternal)
    const leafId = await insertDepartment(integrationId, leafExternal, intermediateExternal)
    await assertIntegrationUuid(seedId)
    await seedScope(fixture.actorId, fixture.namespace, seedId)
    await linkLeaf(integrationId, fixture.targetId, leafId)
    const departmentIds = [seedId, intermediateId, leafId].sort(byCodeUnit)
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const paused = parkBefore(ADMISSION_INSERT)
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    const editor = await control()
    let archiving: ReturnType<typeof outcome> | undefined
    let result: Awaited<typeof pending> | undefined
    let archived: Awaited<ReturnType<typeof outcome>> | undefined
    try {
      await paused.wait()
      expect(paused.holder()).toBe(rootPid())
      expect(state.active).toBe(1)
      expect(childEnumParams(state.live)).toEqual([[integrationId], [integrationId]])
      expect(statementParams(state.live, MEMBERSHIP_SHARE)).toEqual([])
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      archiving = outcome(editor.client.query(ARCHIVE_SQL, [intermediateId]))
      const waiting = await blockedQuery(editor.pid, paused.holder())
      expect(waiting).toContain('UPDATE directory_departments')
      expect(waiting).toContain('is_active = false')
      expect(waiting).not.toContain('directory_sync')
      expect(statementParams(state.live, DEPARTMENT_SHARE)).toEqual(departmentIds.map(id => [id]))
    } finally {
      paused.release()
      result = await pending
      if (archiving) archived = await archiving
      await editor.client.query('COMMIT').catch(async () => { await editor.client.query('ROLLBACK').catch(() => undefined) })
      await editor.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) expect(result.value.statusCode).toBe(200)
    expect(archived?.ok).toBe(true)
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual(departmentIds.map(id => [id]))
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([])
    expect(statementParams(root, DERIVING_SHARE)).toEqual([[fixture.actorId, [fixture.roleId]]])
    expect(root.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    const activity = new Map((await observer.query(
      'SELECT id::text AS id, is_active FROM directory_departments WHERE id = ANY($1::uuid[])',
      [departmentIds],
    )).rows.map(row => [String(row.id), row.is_active === true]))
    expect(activity.get(seedId)).toBe(true)
    expect(activity.get(leafId)).toBe(true)
    expect(activity.get(intermediateId)).toBe(false)
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  })

  it('foreign-edge seed disappearance empties both witness enumerations and refusal leaves the restored predicate unwritten', async () => {
    const fixture = await delegatedPair()
    const integrationY = await insertIntegration()
    const integrationX = await insertIntegration()
    const seedId = await insertDepartment(integrationY, `p1k-${randomUUID()}`, null)
    await seedScope(fixture.actorId, fixture.namespace, seedId)
    await linkLeaf(integrationX, fixture.targetId, seedId)
    const rowsOf = (nativeResult: unknown) => {
      if (typeof nativeResult !== 'object' || nativeResult === null) throw new Error('NATIVE_RESULT_SHAPE')
      const rows = (nativeResult as { rows?: unknown }).rows
      if (!Array.isArray(rows)) throw new Error('NATIVE_ROWS_SHAPE')
      return rows.map(row => {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('NATIVE_ROW_SHAPE')
        return row as Record<string, unknown>
      })
    }
    const countOf = (nativeResult: unknown) => {
      if (typeof nativeResult !== 'object' || nativeResult === null) throw new Error('NATIVE_RESULT_SHAPE')
      const rowCount = (nativeResult as { rowCount?: unknown }).rowCount
      if (typeof rowCount !== 'number') throw new Error('NATIVE_ROWCOUNT_SHAPE')
      return rowCount
    }
    const scalarOf = (nativeResult: unknown, key: string, kind: 'number' | 'boolean') => {
      const rows = rowsOf(nativeResult)
      if (rows.length !== 1 || countOf(nativeResult) !== 1) throw new Error('NATIVE_SCALAR_ARITY')
      const value = rows[0]?.[key]
      if (typeof value !== kind) throw new Error('NATIVE_SCALAR_TYPE')
      return value
    }
    const emptyNative = (nativeResult: unknown) => {
      if (rowsOf(nativeResult).length !== 0 || countOf(nativeResult) !== 0) throw new Error('NATIVE_ENUM_NOT_EMPTY')
    }
    expect(scalarOf(await observer.query(
      `SELECT count(*)::int AS y_accounts
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
       WHERE l.local_user_id = ANY($1::text[]) AND a.integration_id = $2::uuid`,
      [[fixture.actorId, fixture.targetId], integrationY],
    ), 'y_accounts', 'number')).toBe(0)
    expect(scalarOf(await observer.query(
      `SELECT count(*)::int AS foreign_edges
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id AND a.is_active = true AND a.integration_id = $2::uuid
       JOIN directory_account_departments ad ON ad.directory_account_id = a.id AND ad.directory_department_id = $3::uuid
       WHERE l.local_user_id = $1 AND l.link_status = 'linked'`,
      [fixture.targetId, integrationX, seedId],
    ), 'foreign_edges', 'number')).toBe(1)
    const setSeed = async (active: boolean) => {
      const sql = active
        ? 'UPDATE directory_departments SET is_active = true, updated_at = NOW() WHERE id = $1 RETURNING is_active'
        : `${ARCHIVE_SQL} RETURNING is_active`
      if (scalarOf(await observer.query(sql, [seedId]), 'is_active', 'boolean') !== active) throw new Error('NATIVE_DEPARTMENT_STATE')
    }
    let helpers = 0
    let seedEnums = 0
    let groupEnums = 0
    let finals = 0
    let initialAllowed = false
    const pids: number[] = []
    const notePid = (pid: number) => {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('NATIVE_PID')
      pids.push(pid)
    }
    state.beforeSql = async sql => {
      if (!sql.includes(') AS allowed') || helpers !== 1 || seedEnums < 2) return
      await setSeed(true)
    }
    state.afterSql = async (sql, _params, pid, nativeResult) => {
      if (sql.includes(') AS allowed')) {
        const allowed = scalarOf(nativeResult, 'allowed', 'boolean')
        notePid(pid)
        if (helpers === 0) {
          if (allowed !== true) throw new Error('HELPER_ALLOWED_NOT_TRUE')
          helpers += 1
          initialAllowed = true
          await setSeed(false)
          return
        }
        if (allowed !== true) throw new Error('FINAL_ALLOWED_NOT_TRUE')
        finals += 1
        await setSeed(false)
        return
      }
      if (sql.includes('bool_or(COALESCE(s.include_children, TRUE)) AS include_children')) {
        emptyNative(nativeResult)
        notePid(pid)
        seedEnums += 1
        return
      }
      if (sql.includes('SELECT DISTINCT gscope.group_id')) {
        emptyNative(nativeResult)
        notePid(pid)
        groupEnums += 1
      }
    }
    try {
      const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated')
      const root = state.traces[0]
      const persisted = await storedAdmissions([fixture.targetId])
      console.log(JSON.stringify({ phase: 'p1k-empty-witness', status: response.statusCode,
        root_committed: root?.committed, initial_allowed: initialAllowed, seed_enumerations: seedEnums,
        group_enumerations: groupEnums, final_allowed: finals, admissions: persisted.length,
        department_active: scalarOf(await observer.query('SELECT is_active FROM directory_departments WHERE id = $1', [seedId]), 'is_active', 'boolean'),
      }))
      expect(response.statusCode).toBe(403)
      expect(response.body).toEqual(failure(
        'ROLE_DELEGATION_USER_OUT_OF_SCOPE',
        'User is outside your delegated department or member-group scope',
      ))
      expect(persisted).toEqual([])
      expect(state.traces).toHaveLength(1)
      expect(root?.business).toBe(true)
      expect(root?.committed).toBe(false)
      expect(state.events).toEqual([])
      expect(state.cacheUserIds).toEqual([])
      expect(state.audit).not.toHaveBeenCalled()
      expect(state.outOfRoot).toEqual([])
      expect(root?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
      expect(initialAllowed).toBe(true)
      expect(helpers).toBe(1)
      expect(seedEnums).toBe(1)
      expect(groupEnums).toBe(1)
      expect(finals).toBe(0)
      expect(pids).toEqual([state.pids[0], state.pids[0], state.pids[0]])
      expect(root?.sql.filter(sql => sql.includes(') AS allowed'))).toHaveLength(1)
      expect(root?.sql.filter(sql => sql.includes('bool_or(COALESCE(s.include_children, TRUE)) AS include_children') && !sql.includes(') AS allowed'))).toHaveLength(1)
      expect(root?.sql.filter(sql => sql.includes('SELECT DISTINCT gscope.group_id') && !sql.includes(') AS allowed'))).toHaveLength(1)
      expect(scalarOf(await observer.query('SELECT is_active FROM directory_departments WHERE id = $1', [seedId]), 'is_active', 'boolean')).toBe(false)
      await setSeed(true)
      expect(await isUserWithinDelegatedScope(
        fixture.actorId, [fixture.namespace], fixture.targetId,
        (sql, params) => observer.query(sql, params as unknown[]),
      )).toBe(true)
      expect(scalarOf(await observer.query('SELECT is_active FROM directory_departments WHERE id = $1', [seedId]), 'is_active', 'boolean')).toBe(true)
      expect(scalarOf(await observer.query(
        'SELECT count(*)::int AS roles FROM user_roles WHERE user_id = $1 AND role_id = $2',
        [fixture.actorId, fixture.roleId],
      ), 'roles', 'number')).toBe(1)
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
    } finally {
      state.beforeSql = undefined
      state.afterSql = undefined
      for (const release of releases.splice(0)) release()
    }
  })

  const derivingChildDelete = 'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2'

  it('revoker commits the deriving child first and the admission writes nothing', async () => {
    const fixture = await delegatedPair()
    const groupId = await insertGroup()
    await seedGroup(fixture.actorId, fixture.namespace, groupId, fixture.targetId)
    const holder = await control()
    await holder.client.query(derivingChildDelete, [fixture.actorId, fixture.roleId])
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    let committed = false
    let result: Awaited<typeof pending> | undefined
    try {
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      expect(holder.pid).toBeGreaterThan(0)
      expectQueuedOnSubjectVersions(waiting, [fixture.actorId, fixture.targetId])
      expect(state.live?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      await holder.client.query('COMMIT')
      committed = true
    } finally {
      if (!committed) await holder.client.query('ROLLBACK').catch(() => undefined)
      result = await pending
      await holder.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) {
      expect(result.value.statusCode).toBe(403)
      expect(result.value.body).toEqual(failure('ROLE_DELEGATION_FORBIDDEN', 'Namespace is outside your delegated admin scope'))
    }
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.traces[0]?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
    expect((await observer.query('SELECT role FROM users WHERE id = $1', [fixture.actorId])).rows).toEqual([{ role: 'user' }])
    expect((await observer.query('SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = $2', [fixture.actorId, fixture.roleId])).rows).toEqual([])
  }, 20_000)

  it('admission holds the deriving child share until commit while the revoker delete is blocked', async () => {
    const fixture = await delegatedPair()
    const groupId = await insertGroup()
    await seedGroup(fixture.actorId, fixture.namespace, groupId, fixture.targetId)
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const resume = gate()
    let holder = 0
    state.afterSql = async (sql, _params, pid) => {
      if (holder || !sql.startsWith('SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = ANY($2::text[]) ORDER BY role_id')) return
      holder = pid
      await resume.promise
    }
    const paused = { wait: () => until(() => holder > 0, 'COMMAND_DID_NOT_REACH_PAUSE'), holder: () => holder, release: resume.release }
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    const editor = await control()
    let deleting: ReturnType<typeof outcome> | undefined
    let result: Awaited<typeof pending> | undefined
    let deleted: Awaited<ReturnType<typeof outcome>> | undefined
    try {
      await paused.wait()
      expect(paused.holder()).toBe(rootPid())
      expect(state.active).toBe(1)
      deleting = outcome(editor.client.query(derivingChildDelete, [fixture.actorId, fixture.roleId]))
      const waiting = await blockedQuery(editor.pid, paused.holder())
      expect(waiting).toContain('DELETE FROM user_roles')
      expect(waiting).toContain('role_id = $2')
      expect(waiting).not.toContain("role_id = 'admin'")
      expect(statementParams(state.live, DERIVING_SHARE)).toEqual([[fixture.actorId, [fixture.roleId]]])
      expect(state.live?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
    } finally {
      paused.release()
      result = await pending
      if (deleting) deleted = await deleting
      await editor.client.query('COMMIT').catch(async () => { await editor.client.query('ROLLBACK').catch(() => undefined) })
      await editor.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) expect(result.value.statusCode).toBe(200)
    expect(deleted?.ok).toBe(true)
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(statementParams(root, DERIVING_SHARE)).toEqual([[fixture.actorId, [fixture.roleId]]])
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([[groupId, fixture.targetId]])
    expect(root.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect((await observer.query('SELECT role FROM users WHERE id = $1', [fixture.actorId])).rows).toEqual([{ role: 'user' }])
    expect((await observer.query('SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = $2', [fixture.actorId, fixture.roleId])).rows).toEqual([])
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  }, 20_000)

  type PathFixture = { actorId: string; targetId: string; namespace: string; roleId: string }
  async function departmentChain(actorId: string, namespace: string, targetId: string, includeChildren = true, linkTarget = true) {
    const integrationId = await insertIntegration()
    const seedExternal = `p1k-seed-${randomUUID()}`
    const intermediateExternal = `p1k-mid-${randomUUID()}`
    const leafExternal = `p1k-leaf-${randomUUID()}`
    const seedId = await insertDepartment(integrationId, seedExternal, null)
    const intermediateId = await insertDepartment(integrationId, intermediateExternal, seedExternal)
    const leafId = await insertDepartment(integrationId, leafExternal, intermediateExternal)
    await assertIntegrationUuid(seedId)
    await seedScope(actorId, namespace, seedId, includeChildren)
    if (linkTarget) await linkLeaf(integrationId, targetId, leafId)
    const departmentIds = [seedId, intermediateId, leafId].sort(byCodeUnit)
    return { integrationId, seedExternal, intermediateExternal, leafExternal, seedId, intermediateId, leafId, departmentIds }
  }
  async function departmentActivity(departmentIds: readonly string[]) {
    return new Map((await observer.query(
      'SELECT id::text AS id, is_active FROM directory_departments WHERE id = ANY($1::uuid[])',
      [[...departmentIds]],
    )).rows.map(row => [String(row.id), row.is_active === true]))
  }
  function outOfScopeBody() {
    return failure('ROLE_DELEGATION_USER_OUT_OF_SCOPE', 'User is outside your delegated department or member-group scope')
  }
  async function expectPathWriterFirst(fixture: PathFixture, childEnums: readonly (readonly string[])[], departmentIds: readonly string[], blockedDepartmentId: string, lockSql: string, lockParams: unknown[]) {
    const holder = await control()
    await holder.client.query(lockSql, lockParams)
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    let committed = false
    let result: Awaited<typeof pending> | undefined
    try {
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(holder.pid).toBeGreaterThan(0)
      expect(waiting).toContain('FOR SHARE')
      expect(waiting).toContain('directory_departments')
      expect(statement.sql).toMatch(DEPARTMENT_SHARE)
      expect(statement.params).toEqual([blockedDepartmentId])
      expect(state.live?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      await holder.client.query('COMMIT')
      committed = true
    } finally {
      if (!committed) await holder.client.query('ROLLBACK').catch(() => undefined)
      result = await pending
      await holder.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) {
      expect(result.value.statusCode).toBe(403)
      expect(result.value.body).toEqual(outOfScopeBody())
    }
    const root = state.traces[0]
    expect(state.traces).toHaveLength(1)
    expect(root?.committed).toBe(false)
    expect(root?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
    expect(childEnumParams(root)).toEqual(childEnums.map(ids => [...ids]))
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual(departmentIds.map(id => [id]))
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([])
    expect(statementParams(root, DERIVING_SHARE)).toEqual([[fixture.actorId, [fixture.roleId]]])
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
  }
  async function expectPathAdmissionFirst(fixture: PathFixture, integrationId: string, departmentIds: readonly string[], lockSql: string, lockParams: unknown[], waitingFragments: readonly string[]) {
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const paused = parkBefore(ADMISSION_INSERT)
    let insertForwarded = false
    state.afterSql = async (sql, _params, _pid, nativeResult) => {
      if (!ADMISSION_INSERT.test(sql)) return
      insertForwarded = true
      if (nativeCount(nativeResult) !== 1) throw new Error('NATIVE_INSERT_ARITY')
    }
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    const editor = await control()
    let writing: ReturnType<typeof outcome> | undefined
    let result: Awaited<typeof pending> | undefined
    let written: Awaited<ReturnType<typeof outcome>> | undefined
    try {
      await paused.wait()
      expect(paused.holder()).toBe(rootPid())
      expect(state.active).toBe(1)
      expect(insertForwarded).toBe(false)
      expect(childEnumParams(state.live)).toEqual([[integrationId], [integrationId]])
      expect(statementParams(state.live, DEPARTMENT_SHARE)).toEqual(departmentIds.map(id => [id]))
      expect(statementParams(state.live, MEMBERSHIP_SHARE)).toEqual([])
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      writing = outcome(editor.client.query(lockSql, lockParams))
      const waiting = await blockedQuery(editor.pid, paused.holder())
      for (const fragment of waitingFragments) expect(waiting).toContain(fragment)
    } finally {
      paused.release()
      result = await pending
      if (writing) written = await writing
      await editor.client.query('COMMIT').catch(async () => { await editor.client.query('ROLLBACK').catch(() => undefined) })
      await editor.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) expect(result.value.statusCode).toBe(200)
    expect(written?.ok).toBe(true)
    expect(insertForwarded).toBe(true)
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(childEnumParams(root)).toEqual([[integrationId], [integrationId]])
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual(departmentIds.map(id => [id]))
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([])
    expect(statementParams(root, DERIVING_SHARE)).toEqual([[fixture.actorId, [fixture.roleId]]])
    expect(root.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  }

  test('seed archive commits before the share and the admission writes nothing', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    await expectPathWriterFirst(fixture, [[chain.integrationId]], chain.departmentIds, chain.seedId, ARCHIVE_SQL, [chain.seedId])
    const activity = await departmentActivity(chain.departmentIds)
    expect(activity.get(chain.seedId)).toBe(false)
    expect(activity.get(chain.intermediateId)).toBe(true)
    expect(activity.get(chain.leafId)).toBe(true)
  })

  test('admission holds the seed, intermediate, and leaf shares while the seed archive is blocked', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    await expectPathAdmissionFirst(fixture, chain.integrationId, chain.departmentIds, ARCHIVE_SQL, [chain.seedId], ['UPDATE directory_departments', 'is_active = false'])
    const activity = await departmentActivity(chain.departmentIds)
    expect(activity.get(chain.seedId)).toBe(false)
    expect(activity.get(chain.intermediateId)).toBe(true)
    expect(activity.get(chain.leafId)).toBe(true)
  })

  test('intermediate archive commits before the share and the admission writes nothing', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    await expectPathWriterFirst(fixture, [[chain.integrationId], [chain.integrationId]], chain.departmentIds, chain.intermediateId, ARCHIVE_SQL, [chain.intermediateId])
    const activity = await departmentActivity(chain.departmentIds)
    expect(activity.get(chain.seedId)).toBe(true)
    expect(activity.get(chain.intermediateId)).toBe(false)
    expect(activity.get(chain.leafId)).toBe(true)
  })

  test('leaf archive commits before the share and the admission writes nothing', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    await expectPathWriterFirst(fixture, [[chain.integrationId], [chain.integrationId]], chain.departmentIds, chain.leafId, ARCHIVE_SQL, [chain.leafId])
    const activity = await departmentActivity(chain.departmentIds)
    expect(activity.get(chain.seedId)).toBe(true)
    expect(activity.get(chain.intermediateId)).toBe(true)
    expect(activity.get(chain.leafId)).toBe(false)
  })

  test('admission holds the seed, intermediate, and leaf shares while the leaf archive is blocked', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    await expectPathAdmissionFirst(fixture, chain.integrationId, chain.departmentIds, ARCHIVE_SQL, [chain.leafId], ['UPDATE directory_departments', 'is_active = false'])
    const activity = await departmentActivity(chain.departmentIds)
    expect(activity.get(chain.seedId)).toBe(true)
    expect(activity.get(chain.intermediateId)).toBe(true)
    expect(activity.get(chain.leafId)).toBe(false)
  })

  test('intermediate reparent commits before the share and the admission writes nothing', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    const outsideExternal = `p1k-out-${randomUUID()}`
    await insertDepartment(chain.integrationId, outsideExternal, null)
    await expectPathWriterFirst(fixture, [[chain.integrationId], [chain.integrationId]], chain.departmentIds, chain.intermediateId, REPARENT_SQL, [chain.intermediateExternal, outsideExternal, 0, chain.intermediateId])
    expect((await observer.query('SELECT external_parent_department_id FROM directory_departments WHERE id = $1', [chain.intermediateId])).rows).toEqual([{ external_parent_department_id: outsideExternal }])
  })

  test('admission holds the intermediate share while the reparent is blocked', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    const outsideExternal = `p1k-out-${randomUUID()}`
    await insertDepartment(chain.integrationId, outsideExternal, null)
    await expectPathAdmissionFirst(fixture, chain.integrationId, chain.departmentIds, REPARENT_SQL, [chain.intermediateExternal, outsideExternal, 0, chain.intermediateId], ['UPDATE directory_departments', 'external_parent_department_id'])
    expect((await observer.query('SELECT external_parent_department_id FROM directory_departments WHERE id = $1', [chain.intermediateId])).rows).toEqual([{ external_parent_department_id: outsideExternal }])
  })

  test('intermediate clear-to-root commits before the share and the admission writes nothing', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    await expectPathWriterFirst(fixture, [[chain.integrationId], [chain.integrationId]], chain.departmentIds, chain.intermediateId, REPARENT_SQL, [chain.intermediateExternal, null, 0, chain.intermediateId])
    expect((await observer.query('SELECT external_parent_department_id FROM directory_departments WHERE id = $1', [chain.intermediateId])).rows).toEqual([{ external_parent_department_id: null }])
  })

  test('admission holds the intermediate share while the clear-to-root is blocked', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    await expectPathAdmissionFirst(fixture, chain.integrationId, chain.departmentIds, REPARENT_SQL, [chain.intermediateExternal, null, 0, chain.intermediateId], ['UPDATE directory_departments', 'external_parent_department_id'])
    expect((await observer.query('SELECT external_parent_department_id FROM directory_departments WHERE id = $1', [chain.intermediateId])).rows).toEqual([{ external_parent_department_id: null }])
  })

  test('false include_children refuses a descendant-only target and writes nothing', async () => {
    const fixture = await delegatedPair()
    const integrationId = await insertIntegration()
    const seedExternal = `p1k-seed-${randomUUID()}`
    const childExternal = `p1k-child-${randomUUID()}`
    const seedId = await insertDepartment(integrationId, seedExternal, null)
    const childId = await insertDepartment(integrationId, childExternal, seedExternal)
    await assertIntegrationUuid(seedId)
    await seedScope(fixture.actorId, fixture.namespace, seedId, false)
    await linkLeaf(integrationId, fixture.targetId, childId)
    expect(await isUserWithinDelegatedScope(
      fixture.actorId, [fixture.namespace], fixture.targetId,
      (sql, params) => observer.query(sql, params as unknown[]),
    )).toBe(false)
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated')
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual(outOfScopeBody())
    expect(state.traces).toEqual([])
    expect(state.pids).toEqual([])
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
    const activity = await departmentActivity([seedId, childId])
    expect(activity.get(seedId)).toBe(true)
    expect(activity.get(childId)).toBe(true)
  })

  test('false include_children admits the seed itself and does not share its descendant', async () => {
    const fixture = await delegatedPair()
    const integrationId = await insertIntegration()
    const seedExternal = `p1k-seed-${randomUUID()}`
    const childExternal = `p1k-child-${randomUUID()}`
    const seedId = await insertDepartment(integrationId, seedExternal, null)
    const childId = await insertDepartment(integrationId, childExternal, seedExternal)
    await assertIntegrationUuid(seedId)
    await seedScope(fixture.actorId, fixture.namespace, seedId, false)
    await linkLeaf(integrationId, fixture.targetId, seedId)
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated')
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(childEnumParams(root)).toEqual([[integrationId], [integrationId]])
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual([[seedId]])
    expect(statementParams(root, DEPARTMENT_SHARE).flat()).not.toContain(childId)
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([])
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect(response.statusCode).toBe(200)
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  })

  test('true include_children admits the descendant and shares the seed and the leaf', async () => {
    const fixture = await delegatedPair()
    const integrationId = await insertIntegration()
    const seedExternal = `p1k-seed-${randomUUID()}`
    const leafExternal = `p1k-leaf-${randomUUID()}`
    const seedId = await insertDepartment(integrationId, seedExternal, null)
    const leafId = await insertDepartment(integrationId, leafExternal, seedExternal)
    await assertIntegrationUuid(seedId)
    await seedScope(fixture.actorId, fixture.namespace, seedId, true)
    await linkLeaf(integrationId, fixture.targetId, leafId)
    const departmentIds = [seedId, leafId].sort(byCodeUnit)
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated')
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(childEnumParams(root)).toEqual([[integrationId], [integrationId]])
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual(departmentIds.map(id => [id]))
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([])
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect(response.statusCode).toBe(200)
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  })

  test('direct seed below an archived ancestor admits without sharing that ancestor', async () => {
    const fixture = await delegatedPair()
    const integrationId = await insertIntegration()
    const ancestorExternal = `p1k-anc-${randomUUID()}`
    const seedExternal = `p1k-seed-${randomUUID()}`
    const ancestorId = await insertDepartment(integrationId, ancestorExternal, null)
    const seedId = await insertDepartment(integrationId, seedExternal, ancestorExternal)
    await observer.query(ARCHIVE_SQL, [ancestorId])
    await assertIntegrationUuid(seedId)
    await seedScope(fixture.actorId, fixture.namespace, seedId, true)
    await linkLeaf(integrationId, fixture.targetId, seedId)
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const paused = parkBefore(ADMISSION_INSERT)
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    const editor = await control()
    let settled = false
    let archiving: ReturnType<typeof outcome> | undefined
    let result: Awaited<typeof pending> | undefined
    let archived: Awaited<ReturnType<typeof outcome>> | undefined
    try {
      await paused.wait()
      expect(paused.holder()).toBe(rootPid())
      expect(statementParams(state.live, DEPARTMENT_SHARE)).toEqual([[seedId]])
      expect(statementParams(state.live, DEPARTMENT_SHARE).flat()).not.toContain(ancestorId)
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      archiving = outcome(editor.client.query(ARCHIVE_SQL, [ancestorId]).then(value => {
        settled = true
        return value
      }))
      await until(async () => {
        const row = (await observer.query(
          "SELECT $2 = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1",
          [editor.pid, rootPid()],
        )).rows[0]
        if (row?.blocked === true) throw new Error('ARCHIVED_ANCESTOR_WAS_HELD')
        return settled
      }, 'ANCESTOR_ARCHIVE_DID_NOT_FINISH')
    } finally {
      paused.release()
      result = await pending
      if (archiving) archived = await archiving
      await editor.client.query('COMMIT').catch(async () => { await editor.client.query('ROLLBACK').catch(() => undefined) })
      await editor.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) expect(result.value.statusCode).toBe(200)
    expect(archived?.ok).toBe(true)
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual([[seedId]])
    expect(statementParams(root, DEPARTMENT_SHARE).flat()).not.toContain(ancestorId)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect((await observer.query('SELECT is_active FROM directory_departments WHERE id = $1', [ancestorId])).rows).toEqual([{ is_active: false }])
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  })

  test('alternate successful paths are shared and the irrelevant reachable branch is not', async () => {
    const fixture = await delegatedPair()
    const integrationId = await insertIntegration()
    const seedExternal = `p1k-seed-${randomUUID()}`
    const leftExternal = `p1k-left-${randomUUID()}`
    const rightExternal = `p1k-right-${randomUUID()}`
    const strayExternal = `p1k-stray-${randomUUID()}`
    const leftLeafExternal = `p1k-left-leaf-${randomUUID()}`
    const rightLeafExternal = `p1k-right-leaf-${randomUUID()}`
    const strayLeafExternal = `p1k-stray-leaf-${randomUUID()}`
    const seedId = await insertDepartment(integrationId, seedExternal, null)
    const leftId = await insertDepartment(integrationId, leftExternal, seedExternal)
    const rightId = await insertDepartment(integrationId, rightExternal, seedExternal)
    const strayId = await insertDepartment(integrationId, strayExternal, seedExternal)
    const leftLeafId = await insertDepartment(integrationId, leftLeafExternal, leftExternal)
    const rightLeafId = await insertDepartment(integrationId, rightLeafExternal, rightExternal)
    const strayLeafId = await insertDepartment(integrationId, strayLeafExternal, strayExternal)
    await assertIntegrationUuid(seedId)
    await seedScope(fixture.actorId, fixture.namespace, seedId, true)
    await linkLeaf(integrationId, fixture.targetId, leftLeafId)
    await linkLeaf(integrationId, fixture.targetId, rightLeafId)
    const departmentIds = [seedId, leftId, rightId, leftLeafId, rightLeafId].sort(byCodeUnit)
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated')
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(childEnumParams(root)).toEqual([[integrationId], [integrationId]])
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual(departmentIds.map(id => [id]))
    expect(statementParams(root, DEPARTMENT_SHARE).flat()).not.toContain(strayId)
    expect(statementParams(root, DEPARTMENT_SHARE).flat()).not.toContain(strayLeafId)
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([])
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect(response.statusCode).toBe(200)
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  })

  test('group-only admission shares the membership and does not share an unmatched reachable department branch', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId, true, false)
    const groupId = await insertGroup()
    await seedGroup(fixture.actorId, fixture.namespace, groupId, fixture.targetId)
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated')
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(childEnumParams(root)).toEqual([[chain.integrationId], [chain.integrationId]])
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual([])
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([[groupId, fixture.targetId]])
    expect(root.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect(response.statusCode).toBe(200)
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  })

  test('mixed department and group witnesses share every path department before the membership', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    const groupId = await insertGroup()
    await seedGroup(fixture.actorId, fixture.namespace, groupId, fixture.targetId)
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated')
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    const departmentIndexes = matches(root, DEPARTMENT_SHARE)
    const membershipIndexes = matches(root, MEMBERSHIP_SHARE)
    expect(departmentIndexes[departmentIndexes.length - 1] ?? -1).toBeLessThan(membershipIndexes[0] ?? -1)
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual(chain.departmentIds.map(id => [id]))
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([[groupId, fixture.targetId]])
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect(response.statusCode).toBe(200)
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  })

  test('an added membership witness key is not adopted and the admission writes nothing', async () => {
    const fixture = await delegatedPair()
    const groupId = await insertGroup()
    const addedGroupId = await insertGroup()
    const hiddenNamespace = `${fixture.namespace}x`
    await seedGroup(fixture.actorId, fixture.namespace, groupId, fixture.targetId)
    await observer.query('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2)', [addedGroupId, fixture.targetId])
    await observer.query(
      `INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $1, NOW(), NOW())`,
      [fixture.actorId, hiddenNamespace, addedGroupId],
    )
    const seen: string[][] = []
    const nativeFaults: string[] = []
    state.afterSql = async (sql, _params, _pid, nativeResult) => {
      if (!sql.startsWith('SELECT DISTINCT gscope.group_id') || sql.includes(') AS allowed')) return
      try {
        seen.push(nativeRows(nativeResult).map(row => String(row.group_id)).sort(byCodeUnit))
      } catch (error) {
        nativeFaults.push(error instanceof Error ? error.message : 'NATIVE_ROWS_UNREADABLE')
      }
    }
    const holder = await control()
    await holder.client.query(
      'SELECT group_id, user_id FROM platform_member_group_members WHERE group_id = $1 AND user_id = $2 FOR UPDATE',
      [groupId, fixture.targetId],
    )
    const editor = await control()
    await editor.client.query("SET LOCAL lock_timeout = '2s'")
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    let holderCommitted = false
    let editorCommitted = false
    let result: Awaited<typeof pending> | undefined
    let waiting = ''
    let statement = { sql: '', params: [] as unknown[] }
    let seenAtWait: string[][] = []
    let namespaceWrites = -1
    let namespaceCode = ''
    let admissionsDuringWait: Awaited<ReturnType<typeof storedAdmissions>> = []
    let businessCommitDuringWait = false
    let liveInsertDuringWait = false
    try {
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      waiting = await blockedQuery(rootPid(), holder.pid)
      statement = waitingStatement()
      seenAtWait = seen.map(ids => [...ids])
      admissionsDuringWait = await storedAdmissions([fixture.targetId])
      businessCommitDuringWait = state.events.includes('BUSINESS_COMMIT')
      liveInsertDuringWait = state.live?.sql.some(sql => ADMISSION_INSERT.test(sql)) === true
      if (seenAtWait.length === 1 && nativeFaults.length === 0) {
        try {
          // Separate session. The hook must not await this UPDATE.
          const updated = await editor.client.query(
            `UPDATE delegated_role_admin_member_groups
                SET namespace = $1
              WHERE admin_user_id = $2
                AND group_id = $3
                AND namespace = $4`,
            [fixture.namespace, fixture.actorId, addedGroupId, hiddenNamespace],
          )
          namespaceWrites = typeof updated.rowCount === 'number' ? updated.rowCount : -1
          await editor.client.query('COMMIT')
          editorCommitted = true
        } catch (error) {
          const code = (error as { code?: unknown }).code
          namespaceCode = typeof code === 'string' ? code : 'NAMESPACE_UPDATE_FAILED'
        }
      }
      await holder.client.query('COMMIT')
      holderCommitted = true
    } finally {
      if (!editorCommitted) await editor.client.query('ROLLBACK').catch(() => undefined)
      if (!holderCommitted) await holder.client.query('ROLLBACK').catch(() => undefined)
      result = await pending
      await editor.close()
      await holder.close()
    }
    expect(nativeFaults).toEqual([])
    expect(holder.pid).toBeGreaterThan(0)
    expect(waiting).toContain('FOR SHARE')
    expect(waiting).toContain('platform_member_group_members')
    expect(statement.sql).toMatch(MEMBERSHIP_SHARE)
    expect(statement.params).toEqual([groupId, fixture.targetId])
    expect(seenAtWait).toEqual([[groupId]])
    expect(liveInsertDuringWait).toBe(false)
    expect(businessCommitDuringWait).toBe(false)
    expect(admissionsDuringWait).toEqual([])
    expect(namespaceCode).toBe('')
    expect(namespaceWrites).toBe(1)
    expect(result?.ok).toBe(true)
    if (result?.ok) {
      expect(result.value.statusCode).toBe(403)
      expect(result.value.body).toEqual(outOfScopeBody())
    }
    expect(seen[0]).toEqual([groupId])
    expect(seen[1]).toEqual([groupId, addedGroupId].sort(byCodeUnit))
    expect(statementParams(state.traces[0], MEMBERSHIP_SHARE)).toEqual([[groupId, fixture.targetId]])
    expect(statementParams(state.traces[0], DEPARTMENT_SHARE)).toEqual([])
    expect(statementParams(state.traces[0], USER_LOCK).map(params => params?.[0])).toEqual(subjectsOf(fixture.actorId, fixture.targetId))
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.traces[0]?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
    expect((await observer.query(
      `SELECT admin_user_id, namespace, group_id::text AS group_id, created_by
         FROM delegated_role_admin_member_groups
        WHERE admin_user_id = $1 AND group_id = $2`,
      [fixture.actorId, addedGroupId],
    )).rows).toEqual([{
      admin_user_id: fixture.actorId,
      namespace: fixture.namespace,
      group_id: addedGroupId,
      created_by: fixture.actorId,
    }])
  })

  test('a missing department witness key after the share refuses and the admission writes nothing', async () => {
    const fixture = await delegatedPair()
    const chain = await departmentChain(fixture.actorId, fixture.namespace, fixture.targetId)
    let shares = 0
    state.afterSql = async (sql, _params, _pid, nativeResult) => {
      if (!DEPARTMENT_SHARE.test(sql)) return
      if (nativeCount(nativeResult) !== 1) throw new Error('NATIVE_SHARE_ARITY')
      shares += 1
      if (shares !== 1) return
      await observer.query(
        'DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = $1 AND namespace = $2 AND directory_department_id = $3',
        [fixture.actorId, fixture.namespace, chain.seedId],
      )
    }
    const response = await invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated')
    expect(shares).toBe(chain.departmentIds.length)
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual(outOfScopeBody())
    expect(statementParams(state.traces[0], DEPARTMENT_SHARE)).toEqual(chain.departmentIds.map(id => [id]))
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.traces[0]?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
    expect((await observer.query(
      'SELECT count(*)::int AS scopes FROM delegated_role_admin_scopes WHERE admin_user_id = $1 AND namespace = $2',
      [fixture.actorId, fixture.namespace],
    )).rows).toEqual([{ scopes: 0 }])
  })

  test('projection delete of an excluded-inventory target commits before the share and the admission writes nothing', async () => {
    const fixture = await delegatedPair()
    const groupId = await insertGroup()
    await seedGroup(fixture.actorId, fixture.namespace, groupId, fixture.targetId)
    expect((await observer.query(
      'SELECT count(*)::int AS accounts FROM directory_account_links WHERE local_user_id = ANY($1::text[])',
      [[fixture.actorId, fixture.targetId]],
    )).rows).toEqual([{ accounts: 0 }])
    const counts: number[] = []
    state.afterSql = async (sql, _params, _pid, nativeResult) => {
      if (!MEMBERSHIP_SHARE.test(sql)) return
      counts.push(nativeCount(nativeResult))
    }
    const holder = await control()
    await holder.client.query(PROJECTION_MEMBER_DELETE_SQL, [groupId, [fixture.targetId]])
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    let committed = false
    let result: Awaited<typeof pending> | undefined
    try {
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      expect(holder.pid).toBeGreaterThan(0)
      expectQueuedOnSubjectVersions(waiting, [fixture.actorId, fixture.targetId])
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      await holder.client.query('COMMIT')
      committed = true
    } finally {
      if (!committed) await holder.client.query('ROLLBACK').catch(() => undefined)
      result = await pending
      await holder.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) {
      expect(result.value.statusCode).toBe(403)
      expect(result.value.body).toEqual(outOfScopeBody())
    }
    // D21 (Y5a): the admission queued on the target's version row until the delete committed, so its
    // inventory no longer holds the membership and no membership share is taken.
    expect(counts).toEqual([])
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.traces[0]?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
    expect(statementParams(state.traces[0], DEPARTMENT_SHARE)).toEqual([])
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
    expect((await observer.query(
      'SELECT user_id FROM platform_member_group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, fixture.targetId],
    )).rows).toEqual([])
  })

  test('admission holds the excluded-inventory membership while the projection delete is blocked', async () => {
    const fixture = await delegatedPair()
    const groupId = await insertGroup()
    await seedGroup(fixture.actorId, fixture.namespace, groupId, fixture.targetId)
    expect((await observer.query(
      'SELECT count(*)::int AS accounts FROM directory_account_links WHERE local_user_id = ANY($1::text[])',
      [[fixture.actorId, fixture.targetId]],
    )).rows).toEqual([{ accounts: 0 }])
    const subjects = subjectsOf(fixture.actorId, fixture.targetId)
    const paused = parkBefore(ADMISSION_INSERT)
    const counts: number[] = []
    let insertForwarded = false
    state.afterSql = async (sql, _params, _pid, nativeResult) => {
      if (MEMBERSHIP_SHARE.test(sql)) counts.push(nativeCount(nativeResult))
      if (!ADMISSION_INSERT.test(sql)) return
      insertForwarded = true
      if (nativeCount(nativeResult) !== 1) throw new Error('NATIVE_INSERT_ARITY')
    }
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    const editor = await control()
    let deleting: ReturnType<typeof outcome> | undefined
    let result: Awaited<typeof pending> | undefined
    let deleted: Awaited<ReturnType<typeof outcome>> | undefined
    try {
      await paused.wait()
      expect(paused.holder()).toBe(rootPid())
      expect(state.active).toBe(1)
      expect(insertForwarded).toBe(false)
      expect(counts).toEqual([1])
      expect(statementParams(state.live, DEPARTMENT_SHARE)).toEqual([])
      expect(statementParams(state.live, MEMBERSHIP_SHARE)).toEqual([[groupId, fixture.targetId]])
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      deleting = outcome(editor.client.query(PROJECTION_MEMBER_DELETE_SQL, [groupId, [fixture.targetId]]))
      const waiting = await blockedQuery(editor.pid, paused.holder())
      expect(waiting).toContain('DELETE FROM platform_member_group_members')
      expect(waiting).toContain('ANY($2::text[])')
    } finally {
      paused.release()
      result = await pending
      if (deleting) deleted = await deleting
      await editor.client.query('COMMIT').catch(async () => { await editor.client.query('ROLLBACK').catch(() => undefined) })
      await editor.close()
    }
    expect(result?.ok).toBe(true)
    if (result?.ok) expect(result.value.statusCode).toBe(200)
    expect(deleted?.ok).toBe(true)
    expect(insertForwarded).toBe(true)
    const root = expectCommittedRoot()
    expectRootOrder(root, [fixture.roleId], subjects)
    expect(statementParams(root, DEPARTMENT_SHARE)).toEqual([])
    expect(statementParams(root, MEMBERSHIP_SHARE)).toEqual([[groupId, fixture.targetId]])
    expect(root.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(false)
    expectAdmissionInsert(root, fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
    expect((await observer.query(
      'SELECT user_id FROM platform_member_group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, fixture.targetId],
    )).rows).toEqual([])
    expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
  })

  async function observedLockWait(holderPid: number) {
    let pid = 0
    let query = ''
    await until(async () => {
      const rows = (await observer.query(
        `SELECT pid, query
           FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND $1 = ANY(pg_blocking_pids(pid))`,
        [holderPid],
      )).rows
      if (rows.length !== 1) return false
      const rowPid = Number(rows[0]?.pid ?? 0)
      if (rowPid <= 0) return false
      pid = rowPid
      query = String(rows[0]?.query ?? '')
      return true
    }, 'EXPECTED_PHYSICAL_LOCK_WAIT')
    expect(pid).toBe(rootPid())
    expect(state.live?.pid).toBe(pid)
    return { pid, query }
  }
  async function settleCycle(
    holderPid: number,
    start: () => Promise<{ statusCode: number; body: unknown }>,
    closeCycle: () => Promise<unknown>,
    beforeClose: (observed: { pid: number; query: string }) => void,
    release: () => Promise<void>,
  ) {
    let pending: ReturnType<typeof outcome<{ statusCode: number; body: unknown }>> | undefined
    let closing: ReturnType<typeof outcome> | undefined
    let cycleStarted = false
    try {
      pending = outcome(start())
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const observed = await observedLockWait(holderPid)
      beforeClose(observed)
      closing = outcome(closeCycle())
      cycleStarted = true
      const both = await Promise.all([pending, closing])
      return { result: both[0], closed: both[1] }
    } catch (error) {
      if (!cycleStarted) {
        await release()
        if (pending) await pending
        if (closing) await closing
      }
      throw error
    }
  }

  test('two-group projection deletes serialize on the target subject version row (D21): no 40P01, and the admission reads the committed removal', async () => {
    // Before D21 the holder's two membership deletes (high group, then low group) and the admission's
    // two membership shares (low, then high) formed a 40P01 cycle. D21 makes both sides take the
    // target's subject version row first: the holder's first DELETE takes it through its trigger, the
    // admission's mutex bump queues behind it, and the holder's second DELETE re-bumps a row it
    // already holds, so it never waits and no cycle forms. The admission then reads the committed
    // state: neither membership is left, so the target is out of scope.
    const fixture = await delegatedPair()
    const firstGroupId = await insertGroup()
    const secondGroupId = await insertGroup()
    await seedGroup(fixture.actorId, fixture.namespace, firstGroupId, fixture.targetId)
    await seedGroup(fixture.actorId, fixture.namespace, secondGroupId, fixture.targetId)
    expect((await observer.query(
      'SELECT count(*)::int AS accounts FROM directory_account_links WHERE local_user_id = ANY($1::text[])',
      [[fixture.actorId, fixture.targetId]],
    )).rows).toEqual([{ accounts: 0 }])
    const ordered = [firstGroupId, secondGroupId].sort(byCodeUnit)
    const lowGroupId = ordered[0] ?? ''
    const highGroupId = ordered[1] ?? ''
    const holder = await control()
    await holder.client.query(PROJECTION_MEMBER_DELETE_SQL, [highGroupId, [fixture.targetId]])
    const pending = outcome(invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'))
    let committed = false
    let result: Awaited<typeof pending> | undefined
    try {
      await until(() => Boolean(state.pids[0]), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      expect(holder.pid).toBeGreaterThan(0)
      expectQueuedOnSubjectVersions(waiting, [fixture.actorId, fixture.targetId])
      await holder.client.query(PROJECTION_MEMBER_DELETE_SQL, [lowGroupId, [fixture.targetId]])
      expect(state.events).not.toContain('BUSINESS_COMMIT')
      expect(await storedAdmissions([fixture.targetId])).toEqual([])
      await holder.client.query('COMMIT')
      committed = true
    } finally {
      if (!committed) await holder.client.query('ROLLBACK').catch(() => undefined)
      result = await pending
      await holder.close()
    }
    expect(state.sqlStates).not.toContain('40P01')
    expect(state.sqlStates).not.toContain('55P03')
    expect(result?.ok).toBe(true)
    if (result?.ok) {
      expect(result.value.statusCode).toBe(403)
      expect(result.value.body).toEqual(outOfScopeBody())
    }
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.traces[0]?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
    expectNoEffects()
    expect(await storedAdmissions([fixture.targetId])).toEqual([])
    expect((await observer.query(
      'SELECT count(*)::int AS memberships FROM platform_member_group_members WHERE user_id = $1 AND group_id = ANY($2::uuid[])',
      [fixture.targetId, [lowGroupId, highGroupId]],
    )).rows).toEqual([{ memberships: 0 }])
  })

  test('two-department projection cycle records whichever backend PostgreSQL selects as the 40P01 victim', async () => {
    const fixture = await delegatedPair()
    const departmentIntegrationId = await insertIntegration()
    const accountIntegrationId = await insertIntegration()
    const seedExternal = `p1k-seed-${randomUUID()}`
    const leafExternal = `p1k-leaf-${randomUUID()}`
    const seedId = await insertDepartment(departmentIntegrationId, seedExternal, null)
    const leafId = await insertDepartment(departmentIntegrationId, leafExternal, seedExternal)
    await assertIntegrationUuid(seedId)
    await seedScope(fixture.actorId, fixture.namespace, seedId, true)
    await linkLeaf(accountIntegrationId, fixture.targetId, leafId)
    expect((await observer.query(
      'SELECT count(*)::int AS same_integration_accounts FROM directory_accounts WHERE integration_id = $1::uuid',
      [departmentIntegrationId],
    )).rows).toEqual([{ same_integration_accounts: 0 }])
    const ordered = [seedId, leafId].sort(byCodeUnit)
    const lowId = ordered[0] ?? ''
    const highId = ordered[1] ?? ''
    const lowExternal = lowId === seedId ? seedExternal : leafExternal
    const highExternal = highId === seedId ? seedExternal : leafExternal
    const lowParent = lowId === seedId ? null : seedExternal
    const highParent = highId === seedId ? null : seedExternal
    const sentinel = `p1k-cycle-${randomUUID()}`
    const holder = await control()
    let released = false
    const releaseHolder = async () => {
      if (released) return
      released = true
      await holder.close()
    }
    const names = async () => (await observer.query(
      'SELECT name FROM directory_departments WHERE id = ANY($1::uuid[])',
      [[seedId, leafId]],
    )).rows.map(row => String(row.name)).sort()
    try {
      await holder.client.query(DEPARTMENT_UPSERT_SQL, departmentUpsertParams(departmentIntegrationId, highExternal, highParent, sentinel))
      const { result, closed } = await settleCycle(
        holder.pid,
        () => invoke(fixture.actorId, fixture.targetId, fixture.namespace, true, 'delegated'),
        () => holder.client.query(DEPARTMENT_UPSERT_SQL, departmentUpsertParams(departmentIntegrationId, lowExternal, lowParent, sentinel)),
        observed => {
          expect(observed.pid).toBe(rootPid())
          expect(observed.query).toContain('FOR SHARE')
          expect(observed.query).toContain('directory_departments')
          const statement = waitingStatement()
          expect(statement.sql).toMatch(DEPARTMENT_SHARE)
          expect(statement.params).toEqual([highId])
          expect(statementParams(state.live, MEMBERSHIP_SHARE)).toEqual([])
        },
        releaseHolder,
      )
      const writerVictim = closed.ok === false && sqlState(closed.error) === '40P01' && result.ok === true
      const admissionVictim = closed.ok === true && result.ok === true && result.value.statusCode === 409 && state.sqlStates.includes('40P01')
      expect([writerVictim, admissionVictim].filter(Boolean)).toHaveLength(1)
      expect(state.sqlStates).not.toContain('55P03')
      expect(state.traces).toHaveLength(1)
      if (admissionVictim && result.ok) {
        expect(result.value.body).toEqual(busyBody())
        expect(state.traces[0]?.committed).toBe(false)
        expect(state.traces[0]?.sql.some(sql => ADMISSION_INSERT.test(sql))).toBe(false)
        expectNoEffects()
        expect(await storedAdmissions([fixture.targetId])).toEqual([])
        await holder.client.query('COMMIT')
        expect(await names()).toEqual([sentinel, sentinel].sort())
      }
      if (writerVictim && result.ok) {
        expect(state.sqlStates).not.toContain('40P01')
        await holder.client.query('ROLLBACK')
        expect(await names()).toEqual([seedExternal, leafExternal].sort())
        expect(result.value.statusCode).toBe(200)
        const root = expectCommittedRoot()
        expectRootOrder(root, [fixture.roleId], subjectsOf(fixture.actorId, fixture.targetId))
        expect(childEnumParams(root)).toEqual([[departmentIntegrationId], [departmentIntegrationId]])
        expect(statementParams(root, DEPARTMENT_SHARE)).toEqual([[lowId], [highId]])
        const seedReads = root.sql.flatMap((sql, index) => sql.includes('bool_or(COALESCE(s.include_children, TRUE)) AS include_children') && !sql.includes(') AS allowed') ? [index] : [])
        const allowed = root.sql.flatMap((sql, index) => sql.includes(') AS allowed') ? [index] : [])
        const inserted = root.sql.findIndex(sql => ADMISSION_INSERT.test(sql))
        expect(seedReads).toHaveLength(2)
        expect(seedReads[1] ?? -1).toBeGreaterThan(matches(root, DEPARTMENT_SHARE).at(-1) ?? -1)
        expect(allowed[1] ?? -1).toBeGreaterThan(seedReads[1] ?? -1)
        expect(inserted).toBeGreaterThan(allowed[1] ?? -1)
        await expectPersisted(fixture.targetId, fixture.namespace, fixture.actorId, 'delegated_admin')
        expectGrantAudit(fixture.actorId, fixture.targetId, fixture.namespace, true, [fixture.namespace])
      }
    } finally {
      await releaseHolder()
    }
  })
})
