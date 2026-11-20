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
  active: 0,
  readsAtAudit: -1,
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
    const service = new actual.ConnectionPool({ connectionString: process.env.DATABASE_URL, max: 6, name: 'delegated-scope-writers-db' })
    const built = {
      getInternalPool: () => service.getInternalPool(),
      query: async (sql: string, params?: unknown[]) => {
        const compact = sql.replace(/\s+/g, ' ').trim()
        state.poolSql.push(compact)
        if (
          state.failReadback
          && state.events.includes('BUSINESS_COMMIT')
          && (compact.includes('FROM delegated_role_admin_scopes') || compact.includes('FROM delegated_role_admin_member_groups'))
        ) {
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

import { adminUsersRouter } from '../../src/routes/admin-users'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { deriveDelegatedAdminNamespace, lockNamespaceAdmissionWrites } from '../../src/rbac/namespace-admission'

const databaseUrl = process.env.DATABASE_URL
if (process.env.EXPECT_DB === '1' && !databaseUrl) throw new Error('EXPECT_DB=1 but DATABASE_URL is missing; module load refuses a skip-shaped green')
const describeWithDatabase = databaseUrl ? describe : describe.skip
const scopePath = '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)'
const groupPath = '/api/admin/role-delegation/users/:userId/scope-groups/:action(assign|unassign)'
const templatePath = '/api/admin/role-delegation/users/:userId/scope-templates/apply'
const ROLE_SHARE = /SELECT id::text AS id FROM roles WHERE id = \$1::text FOR SHARE/
const ROLE_UPDATE = /SELECT id::text AS id FROM roles WHERE id = \$1::text FOR UPDATE/
const ADMISSION = /SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/
const USER_LOCK = /FROM users WHERE id = \$1::text FOR UPDATE/
const ADMIN_CHILD_READ = /SELECT role_id FROM user_roles WHERE user_id = \$1 AND role_id = 'admin'/
const ADMIN_SHARE = /SELECT role_id FROM user_roles WHERE user_id = \$1 AND role_id = 'admin' FOR SHARE/
const FRESH_ROLES = /SELECT role_id FROM user_roles WHERE user_id = \$1 ORDER BY role_id ASC/
const releases: Array<() => void> = []

type RouteName = 'scope' | 'group' | 'template'
type Handle = (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown
type Trace = { pid: number; sql: string[]; params: unknown[][]; business: boolean; committed: boolean }
type Life = 'live' | 'inactive' | 'pending' | 'deleted'
type ActorKind = 'raw' | 'member' | 'inactive' | 'pending' | 'deleted' | 'missing'

function rewind() {
  state.traces = []
  state.live = undefined
  state.pids = []
  state.poolSql = []
  state.outOfRoot = []
  state.events = []
  state.readsAtAudit = -1
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
function pause(pattern: RegExp) {
  const resume = gate()
  let entered = false
  let holder = 0
  state.afterSql = async (sql, _params, pid) => { if (!entered && pattern.test(sql)) { entered = true; holder = pid; await resume.promise } }
  return { wait: () => until(() => entered, 'COMMAND_DID_NOT_REACH_PAUSE'), release: resume.release, holder: () => holder }
}
function beforeMatching(pattern: RegExp, effect: () => Promise<void>) {
  let used = false
  state.beforeSql = async sql => { if (used || !pattern.test(sql)) return; used = true; await effect() }
}
function assignmentReads() {
  return state.poolSql.filter(sql => sql.includes('FROM delegated_role_admin_scopes') || sql.includes('FROM delegated_role_admin_member_groups')).length
}
function delegatedWrites() {
  return state.traces.flatMap(trace => trace.sql.filter(sql => /(?:INSERT INTO|UPDATE|DELETE FROM) delegated_role_admin_(?:scopes|member_groups)\b/.test(sql)))
}
function classified(trace: Trace) {
  const steps: string[] = []
  trace.sql.forEach((sql, index) => {
    const param = String(trace.params[index]?.[0] ?? '')
    if (ROLE_SHARE.test(sql)) steps.push(`share:${param}`)
    else if (ADMISSION.test(sql)) steps.push(`r3:${param}`)
    else if (USER_LOCK.test(sql)) steps.push(`r5:${param}`)
  })
  return steps
}
function expectOneRoot() {
  expect(state.outOfRoot).toEqual([])
  expect(state.traces.map(trace => trace.business)).toEqual([true])
  const root = state.traces[0]
  expect(root?.committed).toBe(true)
  expect(root?.sql.some(sql => sql.includes('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'))).toBe(true)
  expect(root?.sql.filter(sql => sql.includes('pg_advisory_xact_lock_shared(20261106, 1)') && !sql.includes('pg_try_advisory'))).toEqual([root?.sql.find(sql => sql.includes('pg_advisory_xact_lock_shared(20261106, 1)'))])
  expect(root?.sql.some(sql => ROLE_UPDATE.test(sql) || sql.includes('user-recycle:platform-admin'))).toBe(false)
  expect(state.pids).toEqual([root?.pid])
  return root
}
function rootPid() {
  const pid = state.live?.pid
  if (!pid) throw new Error('ROOT_PID_MISSING')
  return pid
}
function test(name: string, fn: () => Promise<void>) {
  it(name, fn, 20_000)
}

describeWithDatabase('delegated scope writers on the real pool; registered handlers exclude authentication', () => {
  let observer: PgPool
  let handlers: Record<RouteName, Handle>
  const userIds: string[] = []
  const roleIds: string[] = []
  const integrationIds: string[] = []
  const groupIds: string[] = []
  const templateIds: string[] = []
  const controls: Array<{ close: () => Promise<void> }> = []

  beforeAll(async () => {
    observer = new PgPool({ connectionString: databaseUrl, max: 4 })
    state.open()
    await observer.query('SELECT 1')
    const router = adminUsersRouter() as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }> }
    const last = (path: string) => {
      const layer = router.stack.find(entry => entry.route?.path === path && entry.route.methods.post)
      if (!layer?.route || layer.route.stack.length < 2) throw new Error('EXPECTED_REGISTERED_HANDLER')
      return layer.route.stack[layer.route.stack.length - 1].handle
    }
    expect(() => router.stack.find(entry => entry.route?.path === scopePath)?.route?.stack[0].handle()).toThrow('HANDLER_SEAM_NOT_AUTH_E2E')
    handlers = { scope: last(scopePath), group: last(groupPath), template: last(templatePath) }
  })
  beforeEach(() => {
    expect(state.active).toBe(0)
    rewind()
    state.audit.mockReset().mockImplementation(async () => {
      expect(state.active).toBe(0)
      expect(state.events).toContain('BUSINESS_COMMIT')
      state.readsAtAudit = assignmentReads()
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
      ['DELETE FROM delegated_role_scope_template_member_groups WHERE template_id = ANY($1::uuid[])', [[...templateIds]]],
      ['DELETE FROM delegated_role_scope_template_departments WHERE template_id = ANY($1::uuid[])', [[...templateIds]]],
      ['DELETE FROM delegated_role_scope_templates WHERE id = ANY($1::uuid[])', [[...templateIds]]],
      ['DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[])', [[...userIds]]],
      ['DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = ANY($1::text[])', [[...userIds]]],
      ['DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [[...userIds]]],
      ['DELETE FROM directory_departments WHERE integration_id = ANY($1::uuid[])', [[...integrationIds]]],
      ['DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [[...integrationIds]]],
      ['DELETE FROM platform_member_groups WHERE id = ANY($1::uuid[])', [[...groupIds]]],
      ['DELETE FROM users WHERE id = ANY($1::text[])', [[...userIds]]],
      ["DELETE FROM roles WHERE id = ANY($1::text[]) AND id <> 'admin' AND id <> 'attendance_admin'", [[...roleIds]]],
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
    if (failures.length === 0) {
      userIds.length = 0
      roleIds.length = 0
      integrationIds.length = 0
      groupIds.length = 0
      templateIds.length = 0
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
    await until(async () => {
      const row = (await observer.query("SELECT query, wait_event_type = 'Lock' AND $2 = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1", [waiter, holder])).rows[0]
      seen = String(row?.query ?? '')
      return row?.blocked === true
    }, 'EXPECTED_PHYSICAL_LOCK_WAIT')
    return seen
  }
  async function insertUser(sort: 'a' | 'z', rawRole: string, life: Life) {
    const userId = `p1g-${sort}-${randomUUID()}`
    userIds.push(userId)
    await observer.query(
      `INSERT INTO users (id, username, email, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set)
       VALUES ($1, $1, $2, 'Synthetic delegated scope fixture', 'synthetic-unused', $3, false, $4, '[]'::jsonb, $5, false)`,
      [userId, `${userId}@example.invalid`, life !== 'inactive', rawRole, life === 'pending' ? 'pending_activation' : 'activated'],
    )
    if (life === 'deleted') await observer.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [userId])
    return userId
  }
  async function insertRole(roleId: string) {
    roleIds.push(roleId)
    await observer.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
  }
  async function department(active: boolean) {
    const label = `p1g-${randomUUID()}`
    const integrationId = (await observer.query("INSERT INTO directory_integrations(org_id,provider,name,status,corp_id,config) VALUES($1,'dingtalk',$1,'active',$1,'{}'::jsonb) RETURNING id", [label])).rows[0].id as string
    integrationIds.push(integrationId)
    const departmentId = (await observer.query("INSERT INTO directory_departments(integration_id,provider,external_department_id,name,is_active,raw) VALUES($1,'dingtalk',$2,$2,$3,'{}'::jsonb) RETURNING id", [integrationId, label, active])).rows[0].id as string
    return { integrationId, departmentId }
  }
  async function insertGroup() {
    const groupId = (await observer.query('INSERT INTO platform_member_groups(name) VALUES($1) RETURNING id', [`p1g-${randomUUID()}`])).rows[0].id as string
    groupIds.push(groupId)
    return groupId
  }
  async function world(actor: ActorKind, targetLife: Life = 'live', withTargetRole = true) {
    const namespace = `a${randomUUID().replaceAll('-', '')}`
    const roleId = `${namespace}_admin`
    await insertRole(roleId)
    const actorLife: Life = actor === 'inactive' || actor === 'pending' || actor === 'deleted' ? actor : 'live'
    const actorId = actor === 'missing' ? `p1g-z-${randomUUID()}` : await insertUser('z', actor === 'raw' ? 'admin' : 'user', actorLife)
    if (actor === 'member') await observer.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [actorId])
    const targetId = await insertUser('a', 'user', targetLife)
    if (withTargetRole) await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [targetId, roleId])
    const directory = await department(true)
    const groupId = await insertGroup()
    return { actorId, targetId, namespace, roleId, departmentId: directory.departmentId, groupId }
  }
  async function profileOf(userId: string) {
    return (await observer.query(
      `SELECT id, email, username, name, mobile, employee_no AS "employeeNo", department, position, hire_date AS "hireDate", role, is_active, is_admin,
              COALESCE(activation_status, 'activated') AS "activationStatus", COALESCE(local_password_set, TRUE) AS "localPasswordSet", last_login_at, created_at, updated_at
       FROM users WHERE id = $1 AND deleted_at IS NULL AND purged_at IS NULL`,
      [userId],
    )).rows[0]
  }
  async function mappedScopes(userId: string) {
    const rows = (await observer.query(
      `SELECT s.id, s.admin_user_id, s.namespace, s.directory_department_id, s.include_children, s.created_by, s.created_at, s.updated_at,
              d.integration_id, i.name AS integration_name, i.provider, i.corp_id, d.external_department_id, d.name AS department_name,
              d.full_path AS department_full_path, d.is_active AS department_is_active
       FROM delegated_role_admin_scopes s
       JOIN directory_departments d ON d.id = s.directory_department_id
       JOIN directory_integrations i ON i.id = d.integration_id
       WHERE s.admin_user_id = $1
       ORDER BY s.namespace ASC, i.name ASC, COALESCE(d.full_path, d.name) ASC`,
      [userId],
    )).rows
    return rows.map(row => ({
      id: row.id,
      adminUserId: row.admin_user_id,
      namespace: row.namespace,
      directoryDepartmentId: row.directory_department_id,
      includeChildren: row.include_children !== false,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      integrationId: row.integration_id,
      integrationName: row.integration_name,
      provider: row.provider,
      corpId: row.corp_id,
      externalDepartmentId: row.external_department_id,
      departmentName: row.department_name,
      departmentFullPath: row.department_full_path,
      departmentActive: row.department_is_active,
    }))
  }
  async function mappedGroups(userId: string) {
    const rows = (await observer.query(
      `SELECT gscope.id, gscope.admin_user_id, gscope.namespace, gscope.group_id, gscope.created_by, gscope.created_at, gscope.updated_at,
              g.name AS group_name, g.description AS group_description, COUNT(gm.user_id)::int AS member_count
       FROM delegated_role_admin_member_groups gscope
       JOIN platform_member_groups g ON g.id = gscope.group_id
       LEFT JOIN platform_member_group_members gm ON gm.group_id = g.id
       WHERE gscope.admin_user_id = $1
       GROUP BY gscope.id, gscope.admin_user_id, gscope.namespace, gscope.group_id, gscope.created_by, gscope.created_at, gscope.updated_at, g.name, g.description
       ORDER BY gscope.namespace ASC, g.name ASC`,
      [userId],
    )).rows
    return rows.map(row => ({
      id: row.id,
      adminUserId: row.admin_user_id,
      namespace: row.namespace,
      groupId: row.group_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      name: row.group_name,
      description: row.group_description,
      memberCount: Number(row.member_count || 0),
    }))
  }
  function namespacesOf(roleIdsForUser: readonly string[]) {
    return [...new Set(roleIdsForUser.map(roleId => deriveDelegatedAdminNamespace(roleId)).filter((namespace): namespace is string => Boolean(namespace)))].sort()
  }
  async function rawDelegation(userId: string) {
    return {
      scopes: (await observer.query('SELECT namespace, directory_department_id, include_children FROM delegated_role_admin_scopes WHERE admin_user_id = $1 ORDER BY namespace, directory_department_id', [userId])).rows,
      groups: (await observer.query('SELECT namespace, group_id FROM delegated_role_admin_member_groups WHERE admin_user_id = $1 ORDER BY namespace, group_id', [userId])).rows,
    }
  }
  async function invoke(route: RouteName, actorId: string, userId: string, body: Record<string, unknown>, action?: 'assign' | 'unassign') {
    const response = { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this }, json(payload: unknown) { this.body = payload; return this } }
    await Promise.resolve(handlers[route]({
      method: 'POST', headers: {}, query: {}, params: { userId, ...(action ? { action } : {}) }, body, user: { id: actorId, role: 'admin' },
    }, response, (error?: unknown) => { if (error) throw error }))
    return response
  }
  async function succeeded(route: RouteName, fixture: { actorId: string; targetId: string; namespace: string }, body: Record<string, unknown>, action: 'assign' | 'unassign' | undefined, profile: unknown, roleIdsForUser: readonly string[], filter: boolean) {
    const response = await invoke(route, fixture.actorId, fixture.targetId, body, action)
    const adminNamespaces = namespacesOf(roleIdsForUser)
    const scopes = await mappedScopes(fixture.targetId)
    const groups = await mappedGroups(fixture.targetId)
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: {
        actorId: fixture.actorId,
        user: profile,
        adminNamespaces,
        scopeAssignments: filter ? scopes.filter(row => adminNamespaces.includes(String(row.namespace))) : scopes,
        groupAssignments: filter ? groups.filter(row => adminNamespaces.includes(String(row.namespace))) : groups,
      },
      meta: undefined,
    })
    return response
  }

  test('raw-admin scope assign commits one childless root and returns the preflight profile', async () => {
    const fixture = await world('raw')
    const profile = await profileOf(fixture.targetId)
    await succeeded('scope', fixture, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign', profile, [fixture.roleId], false)
    const root = expectOneRoot()
    expect(root.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(false)
    expect(await rawDelegation(fixture.targetId)).toEqual({ scopes: [{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }], groups: [] })
    expect(state.readsAtAudit).toBe(0)
    expect(assignmentReads()).toBe(2)
    expect(state.events).toEqual(['BUSINESS_COMMIT', 'audit'])
    expect(state.audit).toHaveBeenCalledWith({
      actorId: fixture.actorId, actorType: 'user', action: 'grant', resourceType: 'delegated-admin-scope',
      resourceId: `${fixture.targetId}:${fixture.namespace}:${fixture.departmentId}`,
      meta: { userId: fixture.targetId, namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId, includeChildrenSemantics: 'include-descendants', includeChildren: true },
    })
  })

  test('membership scope assign share-locks the admin child inside 5000/10000 and restores', async () => {
    const fixture = await world('member')
    const profile = await profileOf(fixture.targetId)
    await succeeded('scope', fixture, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign', profile, [fixture.roleId], false)
    const root = expectOneRoot()
    const shareAt = root.sql.findIndex(sql => ADMIN_SHARE.test(sql))
    expect(root.params[shareAt]).toEqual([fixture.actorId])
    expect(root.sql[shareAt - 1]).toContain("set_config('lock_timeout'")
    expect(root.params[shareAt - 1]).toEqual(['5000', '10000'])
    expect(root.sql[shareAt + 1]).toContain("set_config('lock_timeout'")
    expect(root.sql.filter(sql => ADMIN_SHARE.test(sql))).toHaveLength(1)
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
  })

  it.each(['inactive', 'pending'] as const)('keeps a %s target assignable', async life => {
    const fixture = await world('raw', life)
    const profile = await profileOf(fixture.targetId)
    await succeeded('scope', fixture, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign', profile, [fixture.roleId], false)
    expect((await rawDelegation(fixture.targetId)).scopes).toHaveLength(1)
  }, 20_000)

  test('missing target is 404 before a missing actor is considered', async () => {
    const response = await invoke('scope', `p1g-z-${randomUUID()}`, `p1g-a-${randomUUID()}`, { namespace: 'absent', directoryDepartmentId: randomUUID() }, 'assign')
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'User not found' } })
    expect(state.traces).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
  })

  it.each(['missing', 'inactive', 'pending', 'deleted'] as const)('refuses a %s actor with no delegation', async actor => {
    const fixture = await world(actor)
    const response = await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign')
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } })
    expect(delegatedWrites()).toEqual([])
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.audit).not.toHaveBeenCalled()
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([])
  }, 20_000)

  test('recycle after preflight is 409 before an inactive actor is 403', async () => {
    const fixture = await world('inactive')
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [fixture.targetId]).then(() => undefined))
    const response = await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign')
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({ ok: false, error: { code: 'USER_IN_RECYCLE_BIN', message: '账号在回收站中，请先恢复后再修改权限' } })
    expect(delegatedWrites()).toEqual([])
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.audit).not.toHaveBeenCalled()
  })

  test('deleting the admin child before its share is 403, restores timeouts, and writes nothing', async () => {
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
    const response = await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign')
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } })
    const trace = state.traces[0]
    const shareAt = trace.sql.findIndex(sql => ADMIN_SHARE.test(sql))
    expect(trace.params[shareAt - 1]).toEqual(['5000', '10000'])
    expect(trace.sql[shareAt + 1]).toContain("set_config('lock_timeout'")
    expect(trace.committed).toBe(false)
    expect(delegatedWrites()).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
  })

  test('admin child share blocks deletion until the business commit', async () => {
    const fixture = await world('member')
    const paused = pause(ADMIN_CHILD_READ)
    const pending = outcome(invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign'))
    const editor = await control()
    let deleting: ReturnType<typeof outcome> | undefined
    try {
      await paused.wait()
      deleting = outcome(editor.client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId]))
      await blockedQuery(editor.pid, paused.holder())
      expect((await rawDelegation(fixture.targetId)).scopes).toEqual([])
      expect(state.events).not.toContain('BUSINESS_COMMIT')
    } finally {
      paused.release()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
      if (deleting) expect((await deleting).ok).toBe(true)
      await editor.close()
    }
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
    expectOneRoot()
  })

  test('sorted canonical parents precede R3 and R5 on one read-committed root', async () => {
    const fixture = await world('raw')
    const namespaceB = `b${randomUUID().replaceAll('-', '')}`
    const roleB = `${namespaceB}_admin`
    const plain = `p1gplain${randomUUID().replaceAll('-', '')}`
    await insertRole(roleB)
    await insertRole(plain)
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($1, $3)', [fixture.targetId, roleB, plain])
    const profile = await profileOf(fixture.targetId)
    await succeeded('scope', fixture, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign', profile, [fixture.roleId, roleB, plain], false)
    const root = expectOneRoot()
    const subjects = [fixture.targetId, fixture.actorId].sort()
    expect(classified(root)).toEqual([
      `share:${fixture.roleId}`,
      `share:${roleB}`,
      ...subjects.map(userId => `r3:namespace-admission:${userId}`),
      ...subjects.map(userId => `r5:${userId}`),
    ])
    const worldAt = root.sql.findIndex(sql => sql.includes('pg_advisory_xact_lock_shared(20261106, 1)') && !sql.includes('pg_try_advisory'))
    const firstShare = root.sql.findIndex(sql => ROLE_SHARE.test(sql))
    const lastUser = root.sql.findLastIndex(sql => USER_LOCK.test(sql))
    const fresh = root.sql.findIndex((sql, index) => FRESH_ROLES.test(sql) && root.params[index]?.[0] === fixture.targetId)
    const inserted = root.sql.findIndex(sql => sql.includes('INSERT INTO delegated_role_admin_scopes'))
    expect(root.sql.findIndex(sql => sql.includes('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'))).toBeLessThan(worldAt)
    expect(worldAt).toBeLessThan(firstShare)
    expect(firstShare).toBeLessThan(root.sql.findIndex(sql => ADMISSION.test(sql)))
    expect(lastUser).toBeLessThan(fresh)
    expect(fresh).toBeLessThan(inserted)
    expect(root.sql.some(sql => ADMIN_SHARE.test(sql))).toBe(false)
  })

  test('parent FOR SHARE blocks before R3 and R5, and the waiting query is not FOR UPDATE', async () => {
    const fixture = await world('raw')
    const blocker = await control()
    const probe = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await blocker.client.query('SELECT id FROM roles WHERE id = $1 FOR UPDATE', [fixture.roleId])
      pending = outcome(invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign'))
      await until(() => Boolean(state.live?.pid), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), blocker.pid)
      expect(waiting.includes('FOR SHARE')).toBe(true)
      expect(waiting.includes('FOR UPDATE')).toBe(false)
      expect(state.live?.sql.some(sql => ROLE_UPDATE.test(sql) || sql.includes('hashtextextended') || USER_LOCK.test(sql))).toBe(false)
      expect((await rawDelegation(fixture.targetId)).scopes).toEqual([])
      await probe.client.query("SET LOCAL lock_timeout = '300ms'")
      await lockNamespaceAdmissionWrites(probe.client, fixture.targetId)
      await probe.client.query('SELECT id FROM users WHERE id = $1::text FOR UPDATE', [fixture.targetId])
    } finally {
      await probe.close()
      await blocker.client.query('ROLLBACK')
      const result = await pending
      expect(result?.ok).toBe(true)
      if (result?.ok) expect(result.value.statusCode).toBe(200)
    }
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }])
    expectOneRoot()
  })

  test('losing namespace A before target R3 returns 409 and no delegation while the snapshotted parent was shared', async () => {
    const fixture = await world('raw')
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [fixture.targetId, fixture.roleId]).then(() => undefined))
    const response = await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign')
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({ ok: false, error: { code: 'ROLE_DELEGATION_NAMESPACE_NOT_HELD', message: 'Selected user does not hold that delegated admin namespace' } })
    const root = expectOneRoot()
    expect(classified(root).filter(step => step.startsWith('share:'))).toEqual([`share:${fixture.roleId}`])
    expect(delegatedWrites()).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([])
    expect((await observer.query('SELECT id FROM roles WHERE id = $1', [fixture.roleId])).rows).toEqual([{ id: fixture.roleId }])
  })

  test('adding unrelated B before target R3 still writes A and does not lock B', async () => {
    const fixture = await world('raw')
    const namespaceB = `b${randomUUID().replaceAll('-', '')}`
    const roleB = `${namespaceB}_admin`
    await insertRole(roleB)
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [fixture.targetId, roleB]).then(() => undefined))
    const profile = await profileOf(fixture.targetId)
    await succeeded('scope', fixture, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign', profile, [fixture.roleId, roleB], false)
    const root = expectOneRoot()
    expect(classified(root).filter(step => step.startsWith('share:'))).toEqual([`share:${fixture.roleId}`])
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }])
  })

  test('an actor A membership does not satisfy a target that lacks A', async () => {
    const fixture = await world('raw', 'live', false)
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [fixture.actorId, fixture.roleId])
    const response = await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign')
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({ ok: false, error: { code: 'ROLE_DELEGATION_NAMESPACE_NOT_HELD', message: 'Selected user does not hold that delegated admin namespace' } })
    expect(state.traces).toEqual([])
    expect(delegatedWrites()).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([])
  })

  test('group assign persists the membership and audits before the read', async () => {
    const fixture = await world('raw')
    const profile = await profileOf(fixture.targetId)
    await succeeded('group', fixture, { namespace: fixture.namespace, groupId: fixture.groupId }, 'assign', profile, [fixture.roleId], false)
    expectOneRoot()
    expect(await rawDelegation(fixture.targetId)).toEqual({ scopes: [], groups: [{ namespace: fixture.namespace, group_id: fixture.groupId }] })
    expect(state.readsAtAudit).toBe(0)
    expect(assignmentReads()).toBe(2)
    expect(state.audit).toHaveBeenCalledWith({
      actorId: fixture.actorId, actorType: 'user', action: 'grant', resourceType: 'delegated-admin-group-scope',
      resourceId: `${fixture.targetId}:${fixture.namespace}:group:${fixture.groupId}`,
      meta: { userId: fixture.targetId, namespace: fixture.namespace, groupId: fixture.groupId },
    })
  })

  test('template merge persists both child tables and reads before audit', async () => {
    const fixture = await world('raw')
    const templateId = (await observer.query('INSERT INTO delegated_role_scope_templates(name) VALUES ($1) RETURNING id', [`p1g-${randomUUID()}`])).rows[0].id as string
    templateIds.push(templateId)
    await observer.query('INSERT INTO delegated_role_scope_template_departments(template_id, directory_department_id, include_children) VALUES ($1, $2, true)', [templateId, fixture.departmentId])
    await observer.query('INSERT INTO delegated_role_scope_template_member_groups(template_id, group_id, created_at) VALUES ($1, $2, NOW())', [templateId, fixture.groupId])
    const profile = await profileOf(fixture.targetId)
    await succeeded('template', fixture, { namespace: fixture.namespace, templateId, mode: 'merge' }, undefined, profile, [fixture.roleId], true)
    const root = expectOneRoot()
    const templateAt = root.sql.findIndex(sql => sql.includes('FROM delegated_role_scope_templates') && sql.includes('FOR UPDATE'))
    expect(templateAt).toBeGreaterThan(root.sql.findLastIndex(sql => USER_LOCK.test(sql)))
    expect(await rawDelegation(fixture.targetId)).toEqual({
      scopes: [{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }],
      groups: [{ namespace: fixture.namespace, group_id: fixture.groupId }],
    })
    expect(state.readsAtAudit).toBe(2)
    expect(state.events).toEqual(['BUSINESS_COMMIT', 'audit'])
    expect(state.audit).toHaveBeenCalledWith({
      actorId: fixture.actorId, actorType: 'user', action: 'grant', resourceType: 'delegated-admin-scope-template',
      resourceId: `${fixture.targetId}:${fixture.namespace}:template:${templateId}`,
      meta: {
        userId: fixture.targetId, namespace: fixture.namespace, templateId, mode: 'merge', departmentCount: 1, memberGroupCount: 1,
        includeChildrenSemantics: [{ directoryDepartmentId: fixture.departmentId, includeChildren: true, semantics: 'include-descendants' }],
      },
    })
  })

  const surfaces = ['scope', 'group', 'replace', 'merge'] as const
  type Surface = typeof surfaces[number]
  const paddedRoleId = ' attendance_admin '
  const paddedNamespace = deriveDelegatedAdminNamespace(paddedRoleId)

  function expectExactOff() {
    expect(process.env.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED).not.toBe('true')
  }
  function requireRoot() {
    const root = expectOneRoot()
    if (!root) throw new Error('ROOT_MISSING')
    return root
  }
  function parentShares(trace: Trace) {
    return classified(trace).filter(step => step.startsWith('share:'))
  }
  function liveWrites() {
    return (state.live?.sql ?? []).filter(sql => /(?:INSERT INTO|DELETE FROM) delegated_role_admin_(?:scopes|member_groups)\b/.test(sql))
  }
  function waitingStatement() {
    const live = state.live
    if (!live || live.sql.length === 0) throw new Error('WAITING_STATEMENT_MISSING')
    return { sql: live.sql[live.sql.length - 1] ?? '', params: live.params[live.params.length - 1] ?? [] }
  }
  function routeFailure(route: RouteName) {
    if (route === 'scope') return { code: 'ROLE_DELEGATION_SCOPE_UPDATE_FAILED', message: 'Failed to update delegated admin scope' }
    if (route === 'group') return { code: 'ROLE_DELEGATION_GROUP_SCOPE_UPDATE_FAILED', message: 'Failed to update delegated admin member-group scope' }
    return { code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_APPLY_FAILED', message: 'Failed to apply scope template' }
  }
  function expectRoute500(response: { statusCode: number; body: unknown }, route: RouteName) {
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({ ok: false, error: routeFailure(route) })
  }
  function expectBusyBody(response: { statusCode: number; body: unknown }) {
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } },
    })
  }
  function syntheticSqlState(code: string, marker: boolean) {
    return Object.assign(new Error(marker ? RECOVERY_AUTHORITY_BUSY_MARKER : `SYNTHETIC_SQLSTATE_${code}`), {
      code,
      synthetic: 'not-a-server-deadlock',
    })
  }
  function byScope(left: { namespace: string; directory_department_id: string }, right: { namespace: string; directory_department_id: string }) {
    if (left.namespace !== right.namespace) return left.namespace < right.namespace ? -1 : 1
    if (left.directory_department_id !== right.directory_department_id) return left.directory_department_id < right.directory_department_id ? -1 : 1
    return 0
  }
  function byGroup(left: { namespace: string; group_id: string }, right: { namespace: string; group_id: string }) {
    if (left.namespace !== right.namespace) return left.namespace < right.namespace ? -1 : 1
    if (left.group_id !== right.group_id) return left.group_id < right.group_id ? -1 : 1
    return 0
  }
  async function seedScope(userId: string, namespace: string, departmentId: string, includeChildren: boolean, actorId: string) {
    await observer.query(
      `INSERT INTO delegated_role_admin_scopes (admin_user_id, namespace, directory_department_id, include_children, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [userId, namespace, departmentId, includeChildren, actorId],
    )
  }
  async function seedGroup(userId: string, namespace: string, groupId: string, actorId: string) {
    await observer.query(
      `INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [userId, namespace, groupId, actorId],
    )
  }
  async function installTemplate(departmentId?: string, groupId?: string, includeChildren = true) {
    const templateId = (await observer.query('INSERT INTO delegated_role_scope_templates(name) VALUES ($1) RETURNING id', [`p1g-${randomUUID()}`])).rows[0].id as string
    templateIds.push(templateId)
    if (departmentId) {
      await observer.query(
        'INSERT INTO delegated_role_scope_template_departments(template_id, directory_department_id, include_children) VALUES ($1, $2, $3)',
        [templateId, departmentId, includeChildren],
      )
    }
    if (groupId) {
      await observer.query(
        'INSERT INTO delegated_role_scope_template_member_groups(template_id, group_id, created_at) VALUES ($1, $2, NOW())',
        [templateId, groupId],
      )
    }
    return templateId
  }
  async function bindPadded(targetId: string) {
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [targetId, paddedRoleId])
  }
  async function runSurface(surface: Surface, fixture: { actorId: string; targetId: string; departmentId: string; groupId: string }, namespace: string, roleIdsForUser: readonly string[], templateId?: string) {
    const profile = await profileOf(fixture.targetId)
    if (surface === 'scope') {
      await succeeded('scope', fixture, { namespace, directoryDepartmentId: fixture.departmentId }, 'assign', profile, roleIdsForUser, false)
    } else if (surface === 'group') {
      await succeeded('group', fixture, { namespace, groupId: fixture.groupId }, 'assign', profile, roleIdsForUser, false)
    } else {
      await succeeded('template', fixture, { namespace, templateId, mode: surface }, undefined, profile, roleIdsForUser, true)
    }
    const includeChildren = true
    const scopeRow = { namespace, directory_department_id: fixture.departmentId, include_children: includeChildren }
    const groupRow = { namespace, group_id: fixture.groupId }
    expect(await rawDelegation(fixture.targetId)).toEqual(surface === 'scope'
      ? { scopes: [scopeRow], groups: [] }
      : surface === 'group'
        ? { scopes: [], groups: [groupRow] }
        : { scopes: [scopeRow], groups: [groupRow] })
  }
  async function invokeSurface(surface: Surface, fixture: { actorId: string; targetId: string; departmentId: string; groupId: string }, namespace: string, templateId?: string) {
    if (surface === 'scope') return invoke('scope', fixture.actorId, fixture.targetId, { namespace, directoryDepartmentId: fixture.departmentId }, 'assign')
    if (surface === 'group') return invoke('group', fixture.actorId, fixture.targetId, { namespace, groupId: fixture.groupId }, 'assign')
    return invoke('template', fixture.actorId, fixture.targetId, { namespace, templateId, mode: surface })
  }
  async function populated() {
    const fixture = await world('raw')
    const namespaceB = `b${randomUUID().replaceAll('-', '')}`
    const roleB = `${namespaceB}_admin`
    await insertRole(roleB)
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [fixture.targetId, roleB])
    const deptA2 = (await department(true)).departmentId
    const deptB = (await department(true)).departmentId
    const groupA2 = await insertGroup()
    const groupB = await insertGroup()
    const orphanNamespace = `zorphan${randomUUID().replaceAll('-', '')}`
    const deptOrphan = (await department(true)).departmentId
    const groupOrphan = await insertGroup()
    await seedScope(fixture.targetId, fixture.namespace, fixture.departmentId, true, fixture.actorId)
    await seedGroup(fixture.targetId, fixture.namespace, fixture.groupId, fixture.actorId)
    await seedScope(fixture.targetId, namespaceB, deptB, true, fixture.actorId)
    await seedGroup(fixture.targetId, namespaceB, groupB, fixture.actorId)
    await seedScope(fixture.targetId, orphanNamespace, deptOrphan, false, fixture.actorId)
    await seedGroup(fixture.targetId, orphanNamespace, groupOrphan, fixture.actorId)
    const templateId = await installTemplate(deptA2, groupA2, true)
    return { fixture, namespaceB, roleB, deptA2, deptB, groupA2, groupB, orphanNamespace, deptOrphan, groupOrphan, templateId }
  }
  function preservedRows(held: Awaited<ReturnType<typeof populated>>, mode: 'replace' | 'merge') {
    const scopes = [
      { namespace: held.namespaceB, directory_department_id: held.deptB, include_children: true },
      { namespace: held.orphanNamespace, directory_department_id: held.deptOrphan, include_children: false },
    ]
    const groups = [
      { namespace: held.namespaceB, group_id: held.groupB },
      { namespace: held.orphanNamespace, group_id: held.groupOrphan },
    ]
    if (mode === 'replace') {
      scopes.push({ namespace: held.fixture.namespace, directory_department_id: held.deptA2, include_children: true })
      groups.push({ namespace: held.fixture.namespace, group_id: held.groupA2 })
    } else {
      scopes.push(
        { namespace: held.fixture.namespace, directory_department_id: held.fixture.departmentId, include_children: true },
        { namespace: held.fixture.namespace, directory_department_id: held.deptA2, include_children: true },
      )
      groups.push(
        { namespace: held.fixture.namespace, group_id: held.fixture.groupId },
        { namespace: held.fixture.namespace, group_id: held.groupA2 },
      )
    }
    scopes.sort(byScope)
    groups.sort(byGroup)
    return { scopes, groups }
  }

  it.each(surfaces)('padded-only %s keeps an empty parent plan and the raw attendance namespace', async surface => {
    expect(paddedNamespace).toBe('attendance')
    const fixture = await world('raw', 'live', false)
    await bindPadded(fixture.targetId)
    const templateId = surface === 'replace' || surface === 'merge' ? await installTemplate(fixture.departmentId, fixture.groupId, true) : undefined
    await runSurface(surface, fixture, paddedNamespace ?? '', [paddedRoleId], templateId)
    const root = requireRoot()
    expect(parentShares(root)).toEqual([])
    expect(root.sql.some(sql => ROLE_SHARE.test(sql))).toBe(false)
    expect(root.params.some(params => params.includes('attendance_admin') || params.includes(paddedRoleId))).toBe(false)
  }, 20_000)

  it.each(surfaces)('mixed canonical and padded %s locks only the canonical parent', async surface => {
    const fixture = await world('raw')
    await bindPadded(fixture.targetId)
    const templateId = surface === 'replace' || surface === 'merge' ? await installTemplate(fixture.departmentId, fixture.groupId, true) : undefined
    await runSurface(surface, fixture, fixture.namespace, [fixture.roleId, paddedRoleId], templateId)
    const root = requireRoot()
    expect(parentShares(root)).toEqual([`share:${fixture.roleId}`])
    expect(root.params.some(params => params.includes(paddedRoleId) || params.includes('attendance_admin'))).toBe(false)
  }, 20_000)

  it.each(surfaces)('dangling canonical parent %s is shared as missing and still writes', async surface => {
    const fixture = await world('raw', 'live', false)
    const dangling = `a${randomUUID().replaceAll('-', '')}_admin`
    roleIds.push(dangling)
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [fixture.targetId, dangling])
    const namespace = deriveDelegatedAdminNamespace(dangling)
    expect(namespace).toBeTruthy()
    const templateId = surface === 'replace' || surface === 'merge' ? await installTemplate(fixture.departmentId, fixture.groupId, true) : undefined
    await runSurface(surface, fixture, namespace ?? '', [dangling], templateId)
    const root = requireRoot()
    expect(parentShares(root)).toEqual([`share:${dangling}`])
    expect((await observer.query('SELECT id FROM roles WHERE id = $1', [dangling])).rows).toEqual([])
  }, 20_000)

  it.each(surfaces)('padded A removed before target R3 on %s is 409 with an empty parent plan', async surface => {
    const fixture = await world('raw', 'live', false)
    await bindPadded(fixture.targetId)
    const templateId = surface === 'replace' || surface === 'merge' ? await installTemplate(fixture.departmentId, fixture.groupId, true) : undefined
    const before = await rawDelegation(fixture.targetId)
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, () => observer.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [fixture.targetId, paddedRoleId]).then(() => undefined))
    const response = await invokeSurface(surface, fixture, paddedNamespace ?? '', templateId)
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({ ok: false, error: { code: 'ROLE_DELEGATION_NAMESPACE_NOT_HELD', message: 'Selected user does not hold that delegated admin namespace' } })
    const root = requireRoot()
    expect(parentShares(root)).toEqual([])
    expect(delegatedWrites()).toEqual([])
    expect(root.sql.some(sql => sql.includes('DELETE FROM delegated_role_admin_'))).toBe(false)
    expect(state.audit).not.toHaveBeenCalled()
    expect(await rawDelegation(fixture.targetId)).toEqual(before)
  }, 20_000)

  it.each(surfaces)('added canonical B before target R3 on %s still writes padded A', async surface => {
    const fixture = await world('raw', 'live', false)
    await bindPadded(fixture.targetId)
    const namespaceB = `b${randomUUID().replaceAll('-', '')}`
    const roleB = `${namespaceB}_admin`
    const templateId = surface === 'replace' || surface === 'merge' ? await installTemplate(fixture.departmentId, fixture.groupId, true) : undefined
    beforeMatching(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/, async () => {
      await insertRole(roleB)
      await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [fixture.targetId, roleB])
    })
    await runSurface(surface, fixture, paddedNamespace ?? '', [paddedRoleId, roleB], templateId)
    const root = requireRoot()
    expect(parentShares(root)).toEqual([])
    expect(root.params.some(params => params.includes(roleB) || params.includes('attendance_admin'))).toBe(false)
  }, 20_000)

  it.each(['assign', 'unassign'] as const)('missing group is 404 on %s before either write', async action => {
    const fixture = await world('raw')
    const response = await invoke('group', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, groupId: randomUUID() }, action)
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ ok: false, error: { code: 'PLATFORM_MEMBER_GROUP_NOT_FOUND', message: 'Platform member group not found' } })
    expect(state.traces).toEqual([])
    expect(state.outOfRoot).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
    expect(await rawDelegation(fixture.targetId)).toEqual({ scopes: [], groups: [] })
  }, 20_000)

  it.each(['missing', 'inactive'] as const)('department %s is 404 on scope assign only', async kind => {
    const fixture = await world('raw')
    const departmentId = kind === 'missing' ? randomUUID() : (await department(false)).departmentId
    const response = await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: departmentId }, 'assign')
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ ok: false, error: { code: 'DIRECTORY_DEPARTMENT_NOT_FOUND', message: 'Directory department not found' } })
    expect(state.traces).toEqual([])
    expect(delegatedWrites()).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
  }, 20_000)

  test('scope unassign succeeds without the namespace, without an active department, and ignores malformed includeChildren', async () => {
    const fixture = await world('raw', 'live', false)
    const inactive = await department(false)
    const profile = await profileOf(fixture.targetId)
    await succeeded('scope', fixture, { namespace: fixture.namespace, directoryDepartmentId: inactive.departmentId, includeChildren: null }, 'unassign', profile, [], false)
    const root = requireRoot()
    expect(root.sql.some(sql => sql.includes('DELETE FROM delegated_role_admin_scopes'))).toBe(true)
    expect(state.poolSql.some(sql => sql.includes('FROM directory_departments') && sql.includes('is_active'))).toBe(false)
    expect(await rawDelegation(fixture.targetId)).toEqual({ scopes: [], groups: [] })
    expect(state.readsAtAudit).toBe(0)
    expect(state.audit).toHaveBeenCalledWith({
      actorId: fixture.actorId, actorType: 'user', action: 'revoke', resourceType: 'delegated-admin-scope',
      resourceId: `${fixture.targetId}:${fixture.namespace}:${inactive.departmentId}`,
      meta: { userId: fixture.targetId, namespace: fixture.namespace, directoryDepartmentId: inactive.departmentId, includeChildrenSemantics: 'unassigned' },
    })
  })

  test('group unassign succeeds without the namespace and a zero-row delete stays success', async () => {
    const fixture = await world('raw', 'live', false)
    const profile = await profileOf(fixture.targetId)
    await succeeded('group', fixture, { namespace: fixture.namespace, groupId: fixture.groupId }, 'unassign', profile, [], false)
    requireRoot()
    expect(delegatedWrites().some(sql => sql.includes('DELETE FROM delegated_role_admin_member_groups'))).toBe(true)
    expect(await rawDelegation(fixture.targetId)).toEqual({ scopes: [], groups: [] })
    expect(state.readsAtAudit).toBe(0)
    expect(state.audit).toHaveBeenCalledWith({
      actorId: fixture.actorId, actorType: 'user', action: 'revoke', resourceType: 'delegated-admin-group-scope',
      resourceId: `${fixture.targetId}:${fixture.namespace}:group:${fixture.groupId}`,
      meta: { userId: fixture.targetId, namespace: fixture.namespace, groupId: fixture.groupId },
    })
  })

  test('scope unassign deletes only the selected namespace row', async () => {
    const fixture = await world('raw')
    const namespaceB = `b${randomUUID().replaceAll('-', '')}`
    const roleB = `${namespaceB}_admin`
    await insertRole(roleB)
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [fixture.targetId, roleB])
    const otherDepartment = (await department(true)).departmentId
    await seedScope(fixture.targetId, fixture.namespace, fixture.departmentId, true, fixture.actorId)
    await seedScope(fixture.targetId, namespaceB, otherDepartment, true, fixture.actorId)
    const profile = await profileOf(fixture.targetId)
    await succeeded('scope', fixture, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'unassign', profile, [fixture.roleId, roleB], false)
    expect(await rawDelegation(fixture.targetId)).toEqual({
      scopes: [{ namespace: namespaceB, directory_department_id: otherDepartment, include_children: true }],
      groups: [],
    })
    expect(state.audit).toHaveBeenCalledWith({
      actorId: fixture.actorId, actorType: 'user', action: 'revoke', resourceType: 'delegated-admin-scope',
      resourceId: `${fixture.targetId}:${fixture.namespace}:${fixture.departmentId}`,
      meta: { userId: fixture.targetId, namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId, includeChildrenSemantics: 'include-descendants', includeChildren: true },
    })
  })

  test('group unassign deletes only the selected namespace row', async () => {
    const fixture = await world('raw')
    const namespaceB = `b${randomUUID().replaceAll('-', '')}`
    const roleB = `${namespaceB}_admin`
    await insertRole(roleB)
    await observer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [fixture.targetId, roleB])
    const otherGroup = await insertGroup()
    await seedGroup(fixture.targetId, fixture.namespace, fixture.groupId, fixture.actorId)
    await seedGroup(fixture.targetId, namespaceB, otherGroup, fixture.actorId)
    const profile = await profileOf(fixture.targetId)
    await succeeded('group', fixture, { namespace: fixture.namespace, groupId: fixture.groupId }, 'unassign', profile, [fixture.roleId, roleB], false)
    expect(await rawDelegation(fixture.targetId)).toEqual({
      scopes: [],
      groups: [{ namespace: namespaceB, group_id: otherGroup }],
    })
  })

  test('omitted includeChildren keeps a stored false while exact department is off', async () => {
    expectExactOff()
    const fixture = await world('raw')
    await seedScope(fixture.targetId, fixture.namespace, fixture.departmentId, false, fixture.actorId)
    const profile = await profileOf(fixture.targetId)
    await succeeded('scope', fixture, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign', profile, [fixture.roleId], false)
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: false }])
    expect(state.audit).toHaveBeenCalledWith({
      actorId: fixture.actorId, actorType: 'user', action: 'grant', resourceType: 'delegated-admin-scope',
      resourceId: `${fixture.targetId}:${fixture.namespace}:${fixture.departmentId}`,
      meta: { userId: fixture.targetId, namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId, includeChildrenSemantics: 'exact-department', includeChildren: false },
    })
  })

  test('explicit includeChildren false is 403 while exact department is off', async () => {
    expectExactOff()
    const fixture = await world('raw')
    const response = await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId, includeChildren: false }, 'assign')
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ ok: false, error: { code: 'DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED', message: 'Exact department scope is disabled' } })
    expect(state.traces).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([])
  })

  it.each([null, 'yes'] as const)('malformed includeChildren %s is 400 on scope assign', async includeChildren => {
    const fixture = await world('raw')
    const response = await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId, includeChildren }, 'assign')
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ ok: false, error: { code: 'INCLUDE_CHILDREN_INVALID', message: 'includeChildren must be a boolean' } })
    expect(state.traces).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
  }, 20_000)

  it.each(['replace', 'merge'] as const)('missing template %s is 404 before either replace delete', async mode => {
    const fixture = await world('raw')
    await seedScope(fixture.targetId, fixture.namespace, fixture.departmentId, true, fixture.actorId)
    await seedGroup(fixture.targetId, fixture.namespace, fixture.groupId, fixture.actorId)
    const before = await rawDelegation(fixture.targetId)
    const response = await invoke('template', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, templateId: randomUUID(), mode })
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ ok: false, error: { code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_NOT_FOUND', message: 'Scope template not found' } })
    const root = requireRoot()
    expect(root.sql.some(sql => sql.includes('FROM delegated_role_scope_templates') && sql.includes('FOR UPDATE'))).toBe(true)
    expect(root.sql.some(sql => sql.includes('DELETE FROM delegated_role_admin_'))).toBe(false)
    expect(state.audit).not.toHaveBeenCalled()
    expect(await rawDelegation(fixture.targetId)).toEqual(before)
  }, 20_000)

  it.each(['replace', 'merge'] as const)('empty template %s is 409 before either replace delete', async mode => {
    const fixture = await world('raw')
    await seedScope(fixture.targetId, fixture.namespace, fixture.departmentId, true, fixture.actorId)
    await seedGroup(fixture.targetId, fixture.namespace, fixture.groupId, fixture.actorId)
    const templateId = await installTemplate()
    const before = await rawDelegation(fixture.targetId)
    const response = await invoke('template', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, templateId, mode })
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({ ok: false, error: { code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_EMPTY', message: 'Scope template has no departments or member groups to apply' } })
    const root = requireRoot()
    expect(root.sql.some(sql => sql.includes('FROM delegated_role_scope_templates') && sql.includes('FOR UPDATE'))).toBe(true)
    expect(root.sql.some(sql => sql.includes('DELETE FROM delegated_role_admin_'))).toBe(false)
    expect(state.audit).not.toHaveBeenCalled()
    expect(await rawDelegation(fixture.targetId)).toEqual(before)
  }, 20_000)

  it.each(['replace', 'merge'] as const)('exact-disabled template %s is 403 before either replace delete', async mode => {
    expectExactOff()
    const fixture = await world('raw')
    await seedScope(fixture.targetId, fixture.namespace, fixture.departmentId, true, fixture.actorId)
    await seedGroup(fixture.targetId, fixture.namespace, fixture.groupId, fixture.actorId)
    const templateId = await installTemplate(fixture.departmentId, undefined, false)
    const before = await rawDelegation(fixture.targetId)
    const response = await invoke('template', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, templateId, mode })
    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ ok: false, error: { code: 'DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED', message: 'Exact department scope is disabled' } })
    const root = requireRoot()
    expect(root.sql.some(sql => sql.includes('FROM delegated_role_scope_templates') && sql.includes('FOR UPDATE'))).toBe(true)
    expect(root.sql.some(sql => sql.includes('DELETE FROM delegated_role_admin_'))).toBe(false)
    expect(state.audit).not.toHaveBeenCalled()
    expect(await rawDelegation(fixture.targetId)).toEqual(before)
  }, 20_000)

  test('replace changes only the selected namespace and the response filters the unheld orphan', async () => {
    const held = await populated()
    const profile = await profileOf(held.fixture.targetId)
    await succeeded('template', held.fixture, { namespace: held.fixture.namespace, templateId: held.templateId, mode: 'replace' }, undefined, profile, [held.fixture.roleId, held.roleB], true)
    const root = requireRoot()
    expect(root.sql.filter(sql => sql.startsWith('DELETE FROM delegated_role_admin_scopes') || sql.startsWith('DELETE FROM delegated_role_admin_member_groups'))).toHaveLength(2)
    expect(await rawDelegation(held.fixture.targetId)).toEqual(preservedRows(held, 'replace'))
  })

  test('merge changes only the selected namespace and the response filters the unheld orphan', async () => {
    const held = await populated()
    const profile = await profileOf(held.fixture.targetId)
    await succeeded('template', held.fixture, { namespace: held.fixture.namespace, templateId: held.templateId, mode: 'merge' }, undefined, profile, [held.fixture.roleId, held.roleB], true)
    const root = requireRoot()
    expect(root.sql.some(sql => sql.startsWith('DELETE FROM delegated_role_admin_'))).toBe(false)
    expect(await rawDelegation(held.fixture.targetId)).toEqual(preservedRows(held, 'merge'))
  })

  test('omitted template mode replaces the selected namespace', async () => {
    const held = await populated()
    const profile = await profileOf(held.fixture.targetId)
    await succeeded('template', held.fixture, { namespace: held.fixture.namespace, templateId: held.templateId }, undefined, profile, [held.fixture.roleId, held.roleB], true)
    expect(await rawDelegation(held.fixture.targetId)).toEqual(preservedRows(held, 'replace'))
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ mode: 'replace', templateId: held.templateId }),
    }))
  })

  test('padded MERGE mode merges and keeps the unselected namespace rows', async () => {
    const held = await populated()
    const profile = await profileOf(held.fixture.targetId)
    await succeeded('template', held.fixture, { namespace: held.fixture.namespace, templateId: held.templateId, mode: ' MERGE ' }, undefined, profile, [held.fixture.roleId, held.roleB], true)
    expect(await rawDelegation(held.fixture.targetId)).toEqual(preservedRows(held, 'merge'))
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ mode: 'merge', templateId: held.templateId }),
    }))
  })

  test('invalid template mode is 400 and opens no root', async () => {
    const fixture = await world('raw')
    await seedScope(fixture.targetId, fixture.namespace, fixture.departmentId, true, fixture.actorId)
    const templateId = await installTemplate(fixture.departmentId, fixture.groupId, true)
    const before = await rawDelegation(fixture.targetId)
    const response = await invoke('template', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, templateId, mode: 'mix' })
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ ok: false, error: { code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_MODE_INVALID', message: 'mode must be replace or merge' } })
    expect(state.traces).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
    expect(await rawDelegation(fixture.targetId)).toEqual(before)
  })

  test('held world exclusive lock blocks R0 before any parent share, R3, or R5', async () => {
    const fixture = await world('raw')
    const holder = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT pg_advisory_xact_lock(20261106, 1)')
      pending = outcome(invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign'))
      await until(() => Boolean(state.live?.pid), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(waiting.includes('pg_advisory_xact_lock_shared(20261106, 1)')).toBe(true)
      expect(waiting.includes('pg_try_advisory')).toBe(false)
      expect(statement.sql.includes('pg_advisory_xact_lock_shared(20261106, 1)')).toBe(true)
      expect(statement.params).toEqual([])
      expect(state.live?.sql.some(sql => ROLE_SHARE.test(sql) || ADMISSION.test(sql) || USER_LOCK.test(sql))).toBe(false)
      expect(liveWrites()).toEqual([])
      await holder.close()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
    } finally {
      await holder.close()
      if (pending) await pending
    }
    expectOneRoot()
  })

  test('held target R3 blocks before R5', async () => {
    const fixture = await world('raw')
    const holder = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`namespace-admission:${fixture.targetId}`])
      pending = outcome(invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign'))
      await until(() => Boolean(state.live?.pid), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(waiting.includes('hashtextextended')).toBe(true)
      expect(waiting.includes('FOR UPDATE')).toBe(false)
      expect(statement.params).toEqual([`namespace-admission:${fixture.targetId}`])
      expect(state.live?.sql.some(sql => USER_LOCK.test(sql) || ROLE_UPDATE.test(sql))).toBe(false)
      expect(liveWrites()).toEqual([])
      await holder.close()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
    } finally {
      await holder.close()
      if (pending) await pending
    }
    expectOneRoot()
  })

  test('held target user row blocks the early FOR UPDATE before any delegated write', async () => {
    const fixture = await world('raw')
    const holder = await control()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT id::text AS id FROM users WHERE id = $1::text FOR UPDATE', [fixture.targetId])
      pending = outcome(invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign'))
      await until(() => Boolean(state.live?.pid), 'ROOT_CALLBACK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(waiting).toContain('FROM users')
      expect(waiting).toContain('FOR UPDATE')
      expect(waiting).not.toContain('FOR SHARE')
      expect(waiting).not.toContain('FROM roles')
      expect(statement.params).toEqual([fixture.targetId])
      expect(state.live?.sql.some(sql => ROLE_UPDATE.test(sql))).toBe(false)
      expect(state.live?.sql.some(sql => ROLE_SHARE.test(sql))).toBe(true)
      expect(liveWrites()).toEqual([])
      await holder.close()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
    } finally {
      await holder.close()
      if (pending) await pending
    }
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }])
  })

  test('template FOR UPDATE waits after R5 and blocks a target user probe', async () => {
    const fixture = await world('raw')
    const templateId = await installTemplate(fixture.departmentId, fixture.groupId, true)
    const holder = await control()
    const probe = await control()
    let pending: ReturnType<typeof outcome> | undefined
    let probing: ReturnType<typeof outcome> | undefined
    try {
      await holder.client.query('SELECT id FROM delegated_role_scope_templates WHERE id = $1 FOR UPDATE', [templateId])
      pending = outcome(invoke('template', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, templateId, mode: 'merge' }))
      await until(() => state.live?.sql.at(-1)?.includes('delegated_role_scope_templates') === true, 'TEMPLATE_LOCK_NOT_STARTED')
      const waiting = await blockedQuery(rootPid(), holder.pid)
      const statement = waitingStatement()
      expect(waiting.includes('delegated_role_scope_templates')).toBe(true)
      expect(waiting.includes('FOR UPDATE')).toBe(true)
      expect(statement.params).toEqual([templateId])
      const templateAt = state.live?.sql.findIndex(sql => sql.includes('delegated_role_scope_templates') && sql.includes('FOR UPDATE')) ?? -1
      expect(templateAt).toBeGreaterThan(state.live?.sql.findLastIndex(sql => USER_LOCK.test(sql)) ?? -1)
      expect(liveWrites()).toEqual([])
      probing = outcome(probe.client.query('SELECT id::text AS id FROM users WHERE id = $1::text FOR UPDATE', [fixture.targetId]))
      const probeQuery = await blockedQuery(probe.pid, rootPid())
      expect(probeQuery.includes('FROM users')).toBe(true)
      expect(probeQuery.includes('FOR UPDATE')).toBe(true)
      await holder.close()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.statusCode).toBe(200)
      const probeResult = await probing
      expect(probeResult.ok).toBe(true)
    } finally {
      await holder.close()
      if (pending) await pending
      if (probing) await probing
      await probe.close()
    }
  })

  test('same-client synthetic XX000 on the admin-child share skips timeout restore and writes nothing', async () => {
    const fixture = await world('member')
    state.serverFault = async (sql, _params, client) => {
      if (!ADMIN_SHARE.test(sql)) return
      state.serverFault = undefined
      await client.query("DO $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_ABORTED_ADMIN_SHARE' USING ERRCODE = 'XX000'; END $$")
    }
    const response = await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign')
    expectRoute500(response, 'scope')
    expect(state.traces).toHaveLength(1)
    const trace = state.traces[0]
    expect(trace?.committed).toBe(false)
    const shareAt = trace?.sql.findIndex(sql => ADMIN_SHARE.test(sql)) ?? -1
    expect(shareAt).toBeGreaterThan(0)
    expect(trace?.params[shareAt - 1]).toEqual(['5000', '10000'])
    expect(trace?.sql.slice(shareAt + 1).some(sql => sql.includes("set_config('lock_timeout'"))).toBe(false)
    expect(delegatedWrites()).toEqual([])
    expect(state.audit).not.toHaveBeenCalled()
    expect(state.events).not.toContain('BUSINESS_COMMIT')
    expect((await rawDelegation(fixture.targetId)).scopes).toEqual([])
    expect((await observer.query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [fixture.actorId])).rows).toEqual([{ role_id: 'admin' }])
  })

  it.each([
    ['scope', 'acquire', '55P03', false],
    ['group', 'acquire', '57014', false],
    ['template', 'acquire', '40P01', false],
    ['scope', 'acquire', '40001', false],
    ['group', 'work', '55P03', false],
    ['template', 'work', '57014', false],
    ['scope', 'work', '40P01', false],
    ['group', 'work', '40001', false],
    ['scope', 'acquire', '40001', true],
    ['group', 'work', '40001', true],
    ['template', 'acquire', 'XX000', false],
    ['scope', 'work', 'XX000', false],
  ] as const)('synthetic %s %s SQLSTATE %s marker %s maps once and is not a server deadlock', async (route, phase, code, marker) => {
    const fixture = await world('raw')
    await seedScope(fixture.targetId, fixture.namespace, fixture.departmentId, true, fixture.actorId)
    await seedGroup(fixture.targetId, fixture.namespace, fixture.groupId, fixture.actorId)
    const before = await rawDelegation(fixture.targetId)
    const templateId = route === 'template' ? await installTemplate(fixture.departmentId, fixture.groupId, true) : undefined
    const matches = phase === 'acquire'
      ? (sql: string) => sql.includes('pg_advisory_xact_lock_shared(20261106, 1)') && !sql.includes('pg_try_advisory')
      : (sql: string) => /(?:INSERT INTO|DELETE FROM) delegated_role_admin_(?:scopes|member_groups)\b/.test(sql)
    let used = false
    state.injectBeforeQuery = (sql) => {
      if (used || !matches(sql)) return undefined
      used = true
      return syntheticSqlState(code, marker)
    }
    const response = route === 'template'
      ? await invoke('template', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, templateId, mode: 'replace' })
      : await invoke(route, fixture.actorId, fixture.targetId, route === 'scope'
        ? { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }
        : { namespace: fixture.namespace, groupId: fixture.groupId }, 'assign')
    expect(used).toBe(true)
    if (marker || code === 'XX000') expectRoute500(response, route)
    else expectBusyBody(response)
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.business).toBe(true)
    expect(state.traces[0]?.committed).toBe(false)
    expect(state.audit).not.toHaveBeenCalled()
    expect(state.events).not.toContain('BUSINESS_COMMIT')
    expect(state.outOfRoot).toEqual([])
    expect(await rawDelegation(fixture.targetId)).toEqual(before)
    if (phase === 'acquire') {
      const worldAt = state.traces[0]?.sql.findIndex(sql => sql.includes('pg_advisory_xact_lock_shared(20261106, 1)') && !sql.includes('pg_try_advisory')) ?? -1
      expect(worldAt).toBeGreaterThanOrEqual(0)
      expect(state.traces[0]?.sql.slice(worldAt + 1).some(sql => sql.includes("set_config('lock_timeout'"))).toBe(false)
    }
  }, 20_000)

  it.each(['scope', 'group', 'template'] as const)('commit acknowledgement loss on %s is 500, keeps the row, and does not audit or replay', async route => {
    const fixture = await world('raw')
    const templateId = route === 'template' ? await installTemplate(fixture.departmentId, fixture.groupId, true) : undefined
    state.failCommitAck = true
    const response = route === 'template'
      ? await invoke('template', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, templateId, mode: 'merge' })
      : route === 'group'
        ? await invoke('group', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, groupId: fixture.groupId }, 'assign')
        : await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign')
    expectRoute500(response, route)
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(true)
    expect(state.events).toEqual(['BUSINESS_COMMIT'])
    expect(state.audit).not.toHaveBeenCalled()
    expect(await rawDelegation(fixture.targetId)).toEqual(route === 'group'
      ? { scopes: [], groups: [{ namespace: fixture.namespace, group_id: fixture.groupId }] }
      : route === 'template'
        ? {
          scopes: [{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }],
          groups: [{ namespace: fixture.namespace, group_id: fixture.groupId }],
        }
        : { scopes: [{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }], groups: [] })
  }, 20_000)

  it.each(['scope', 'group', 'template'] as const)('post-commit readback failure on %s is 500, keeps the row, and preserves audit order', async route => {
    const fixture = await world('raw')
    const templateId = route === 'template' ? await installTemplate(fixture.departmentId, fixture.groupId, true) : undefined
    state.failReadback = true
    const response = route === 'template'
      ? await invoke('template', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, templateId, mode: 'merge' })
      : route === 'group'
        ? await invoke('group', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, groupId: fixture.groupId }, 'assign')
        : await invoke('scope', fixture.actorId, fixture.targetId, { namespace: fixture.namespace, directoryDepartmentId: fixture.departmentId }, 'assign')
    expectRoute500(response, route)
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0]?.committed).toBe(true)
    if (route === 'template') {
      expect(state.audit).not.toHaveBeenCalled()
      expect(state.events).toEqual(['BUSINESS_COMMIT'])
      expect(state.readsAtAudit).toBe(-1)
    } else {
      expect(state.readsAtAudit).toBe(0)
      expect(state.events).toEqual(['BUSINESS_COMMIT', 'audit'])
      expect(state.audit).toHaveBeenCalledTimes(1)
      expect(assignmentReads()).toBeGreaterThan(0)
    }
    expect(await rawDelegation(fixture.targetId)).toEqual(route === 'group'
      ? { scopes: [], groups: [{ namespace: fixture.namespace, group_id: fixture.groupId }] }
      : route === 'template'
        ? {
          scopes: [{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }],
          groups: [{ namespace: fixture.namespace, group_id: fixture.groupId }],
        }
        : { scopes: [{ namespace: fixture.namespace, directory_department_id: fixture.departmentId, include_children: true }], groups: [] })
  }, 20_000)
})
