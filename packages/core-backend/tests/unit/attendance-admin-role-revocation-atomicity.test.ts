/**
 * A1: attendance-admin single and batch unassign must take the namespace-admission
 * subject lock and write the revoke witness on that same transaction client.
 *
 * Every case invokes the registered route handler. Source text is not the oracle.
 * Database and session state are doubles; the real lock and witness helpers run.
 */
import type { Request, Response, Router } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  poolQuery: vi.fn(),
}))

const rbacServiceMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(async () => false),
  listUserPermissions: vi.fn(async () => [] as string[]),
  invalidateUserPerms: vi.fn(),
  userHasPermission: vi.fn(async () => false),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.poolQuery },
}))

vi.mock('../../src/rbac/service', () => rbacServiceMocks)

vi.mock('../../src/services/AttendanceScheduler', () => ({
  getSharedAttendanceScheduler: vi.fn(() => null),
}))

vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({
  redeliverFailedAttendanceNotification: vi.fn(),
}))

import {
  RECOVERY_CONFLICT_HTTP_CODE,
  RECOVERY_CONFLICT_HTTP_MESSAGE,
} from '../../src/db/recovery-conflict'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { attendanceAdminRouter } from '../../src/routes/attendance-admin'

const SINGLE_PATH = '/api/attendance-admin/users/:userId/roles/unassign'
const BATCH_PATH = '/api/attendance-admin/users/batch/roles/unassign'
const ACTOR_ID = 'admin-1'
const SINGLE_USER_ID = 'user-1'
const BATCH_REQUEST_ORDER = ['user-z', 'user-a', 'user-m']
const BATCH_SORTED_ORDER = ['user-a', 'user-m', 'user-z']

const UNIFORM_409_BODY = {
  ok: false,
  error: {
    code: RECOVERY_CONFLICT_HTTP_CODE,
    message: RECOVERY_CONFLICT_HTTP_MESSAGE,
    details: { retryable: true },
  },
}

type SqlResult = { rows: unknown[]; rowCount: number }

type RouteCall = {
  events: string[]
  lockKeys: string[]
  witnessParams: unknown[][]
  namespaceRoleIds: unknown[]
  poolSql: string[]
  committed: boolean
}

function markerError(): Error & { code: string } {
  return Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
}

function witnessCheckError(): Error & { code: string } {
  return Object.assign(new Error('witness check failed'), { code: '23514' })
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as Response & { statusCode: number; body: unknown }
}

function invokeHandler(
  router: Router,
  path: string,
  req: Partial<Request>,
  res: Response,
) {
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string
        methods: Record<string, boolean>
        stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
      }
    }>
  }).stack.find((entry) => entry.route?.path === path && entry.route.methods?.post)
  if (!layer?.route) throw new Error(`Route POST ${path} not found`)
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  const fullReq = {
    method: 'POST',
    headers: {},
    query: {},
    params: {},
    body: {},
    user: { id: ACTOR_ID, role: 'admin' },
    ...req,
  } as unknown as Request
  return Promise.resolve(handler(fullReq, res, (err?: unknown) => {
    if (err) throw err
  }))
}

function installTransaction(options: {
  targets?: 'present' | 'missing'
  failOn?: 'delete' | 'witness'
  failError?: Error
} = {}): RouteCall {
  const call: RouteCall = {
    events: [],
    lockKeys: [],
    witnessParams: [],
    namespaceRoleIds: [],
    poolSql: [],
    committed: false,
  }
  const clientQuery = vi.fn(async (sql: string, params?: unknown[]): Promise<SqlResult> => {
    const text = sql.replace(/\s+/g, ' ').trim()
    if (/pg_advisory_xact_lock/.test(text)) {
      call.events.push('lock')
      call.lockKeys.push(String(params?.[0] ?? ''))
      return { rows: [], rowCount: 1 }
    }
    if (/DELETE FROM user_roles/.test(text)) {
      call.events.push('delete')
      if (options.failOn === 'delete') throw options.failError ?? markerError()
      const ids = Array.isArray(params?.[0]) ? params[0] as string[] : []
      return { rows: ids.map((user_id) => ({ user_id })), rowCount: ids.length }
    }
    if (/FROM role_permissions WHERE role_id/.test(text)) {
      call.events.push('list-namespaces')
      call.namespaceRoleIds.push(params?.[0])
      return { rows: [], rowCount: 0 }
    }
    if (/SELECT TRUE AS allowed/.test(text)) {
      call.events.push('remaining-role')
      return { rows: [], rowCount: 0 }
    }
    if (/INSERT INTO user_namespace_admissions/.test(text)) {
      call.events.push('witness')
      call.witnessParams.push([...(params ?? [])])
      if (options.failOn === 'witness') throw options.failError ?? witnessCheckError()
      return { rows: [], rowCount: 1 }
    }
    if (/uo\.user_id = \$1/.test(text)) {
      call.events.push('actor-membership')
      return { rows: [{ ok: 1 }], rowCount: 1 }
    }
    if (/u\.id = ANY\(\$1::text\[\]\)/.test(text)) {
      call.events.push('resolve-targets')
      if (options.targets === 'missing') return { rows: [], rowCount: 0 }
      const ids = Array.isArray(params?.[0]) ? params[0] as string[] : []
      return {
        rows: ids.map((id) => ({
          id,
          email: `${id}@example.test`,
          name: 'Target',
          employeeNo: null,
          department: null,
          is_active: true,
        })),
        rowCount: ids.length,
      }
    }
    if (/FROM users/.test(text) && /WHERE id = \$1/.test(text)) {
      call.events.push('profile')
      const id = String(params?.[0] ?? '')
      return {
        rows: [{
          id,
          email: `${id}@example.test`,
          name: 'Target',
          employeeNo: null,
          department: null,
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-10-14T00:00:00.000Z',
        }],
        rowCount: 1,
      }
    }
    call.events.push('other-sql')
    return { rows: [], rowCount: 0 }
  })
  const client = { query: clientQuery }
  pgMocks.transaction.mockImplementation(async (handler: (tx: typeof client) => Promise<unknown>) => {
    call.events.push('begin')
    try {
      const result = await handler(client)
      call.events.push('commit')
      call.committed = true
      return result
    } catch (error) {
      call.events.push('rollback')
      throw error
    }
  })
  pgMocks.query.mockImplementation(async (sql: string) => {
    call.poolSql.push(sql)
    if (/pg_advisory_xact_lock|DELETE FROM user_roles|INSERT INTO user_namespace_admissions|FROM role_permissions|SELECT TRUE AS allowed/.test(sql)) {
      throw new Error('transaction statement reached the pool')
    }
    return { rows: [], rowCount: 0 }
  })
  return call
}

function mutationEvents(events: string[]): string[] {
  return events.filter((event) => event === 'lock' || event === 'delete' || event === 'witness' || event === 'commit' || event === 'rollback')
}

function expectNoMembershipMutation(call: RouteCall): void {
  expect(call.committed).toBe(false)
  expect(call.lockKeys).toEqual([])
  expect(call.witnessParams).toEqual([])
  expect(call.events).not.toContain('delete')
  expect(call.events).not.toContain('commit')
  expect(call.poolSql.some((sql) => /DELETE FROM user_roles|INSERT INTO user_namespace_admissions|pg_advisory_xact_lock/.test(sql))).toBe(false)
}

const entries = [
  {
    name: 'single',
    path: SINGLE_PATH,
    params: { userId: SINGLE_USER_ID },
    body: { template: 'employee' },
    failureCode: 'ROLE_UNASSIGN_FAILED',
  },
  {
    name: 'batch',
    path: BATCH_PATH,
    params: {},
    body: { userIds: BATCH_REQUEST_ORDER, template: 'employee' },
    failureCode: 'BATCH_ROLE_UNASSIGN_FAILED',
  },
] as const

beforeEach(() => {
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  pgMocks.poolQuery.mockReset()
  rbacServiceMocks.isAdmin.mockReset()
  rbacServiceMocks.isAdmin.mockResolvedValue(false)
  rbacServiceMocks.listUserPermissions.mockReset()
  rbacServiceMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
  rbacServiceMocks.invalidateUserPerms.mockReset()
  rbacServiceMocks.userHasPermission.mockReset()
})

describe('attendance-admin unassign scope and target guards do not mutate', () => {
  it.each(entries)('$name refuses a role outside the attendance scope before any transaction', async (entry) => {
    const call = installTransaction()
    const res = mockResponse()
    await invokeHandler(attendanceAdminRouter(), entry.path, {
      params: entry.params,
      body: { ...entry.body, template: undefined, roleId: 'admin' },
    }, res)

    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'ROLE_OUT_OF_SCOPE' } })
    expect(pgMocks.transaction).not.toHaveBeenCalled()
    expect(call.events).toEqual([])
    expectNoMembershipMutation(call)
    expect(rbacServiceMocks.listUserPermissions).not.toHaveBeenCalled()
  })

  it.each(entries)('$name refuses an org-scoped caller before lock, DELETE or witness', async (entry) => {
    const call = installTransaction()
    const res = mockResponse()
    await invokeHandler(attendanceAdminRouter(), entry.path, {
      params: entry.params,
      query: { orgId: 'org-a' },
      body: entry.body,
      user: { id: ACTOR_ID, role: 'user' } as Request['user'],
    }, res)

    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'ORG_SCOPED_ROLE_WRITE_UNAVAILABLE' } })
    expect(call.events).toEqual(['begin', 'actor-membership', 'rollback'])
    expectNoMembershipMutation(call)
    expect(rbacServiceMocks.listUserPermissions).not.toHaveBeenCalled()
  })

  it.each(entries)('$name refuses a missing target before lock, DELETE or witness', async (entry) => {
    const call = installTransaction({ targets: 'missing' })
    const res = mockResponse()
    await invokeHandler(attendanceAdminRouter(), entry.path, {
      params: entry.params,
      query: { scope: 'global' },
      body: entry.body,
    }, res)

    expect(res.statusCode).toBe(404)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'USER_TARGET_NOT_FOUND' } })
    expect(call.events).toEqual(['begin', 'resolve-targets', 'rollback'])
    expectNoMembershipMutation(call)
  })

  it('single refuses a non-admin global actor and an unauthenticated actor before any write', async () => {
    const forbidden = installTransaction()
    const forbiddenRes = mockResponse()
    await invokeHandler(attendanceAdminRouter(), SINGLE_PATH, {
      params: { userId: SINGLE_USER_ID },
      query: { scope: 'global' },
      body: { template: 'employee' },
      user: { id: ACTOR_ID, role: 'user' } as Request['user'],
    }, forbiddenRes)
    expect(forbiddenRes.statusCode).toBe(403)
    expect(forbiddenRes.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(forbidden.events).toEqual(['begin', 'rollback'])
    expectNoMembershipMutation(forbidden)

    const anonymous = installTransaction()
    const anonymousRes = mockResponse()
    await invokeHandler(attendanceAdminRouter(), SINGLE_PATH, {
      params: { userId: SINGLE_USER_ID },
      query: { scope: 'global' },
      body: { template: 'employee' },
      user: {} as Request['user'],
    }, anonymousRes)
    expect(anonymousRes.statusCode).toBe(401)
    expect(anonymousRes.body).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
    expect(anonymous.events).toEqual(['begin', 'rollback'])
    expectNoMembershipMutation(anonymous)
  })
})

describe('attendance-admin unassign lock, DELETE and witness share one transaction client', () => {
  it('single unassign orders begin, lock, DELETE, witness and commit on the transaction client', async () => {
    const call = installTransaction()
    const res = mockResponse()
    await invokeHandler(attendanceAdminRouter(), SINGLE_PATH, {
      params: { userId: SINGLE_USER_ID },
      query: { scope: 'global' },
      body: { template: 'employee' },
    }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        user: { id: SINGLE_USER_ID, name: 'Target' },
        roles: [],
        permissions: ['attendance:read'],
        isAdmin: false,
      },
    })
    expect((res.body as { data: Record<string, unknown> }).data).not.toHaveProperty('disabledNamespaces')
    expect(call.events).toEqual([
      'begin',
      'resolve-targets',
      'lock',
      'delete',
      'list-namespaces',
      'remaining-role',
      'witness',
      'profile',
      'commit',
    ])
    expect(call.lockKeys).toEqual([`namespace-admission:${SINGLE_USER_ID}`])
    expect(call.namespaceRoleIds).toEqual(['attendance_employee'])
    expect(call.witnessParams).toEqual([
      [SINGLE_USER_ID, 'attendance', 'role_unassigned', ACTOR_ID, false],
    ])
    expect(call.committed).toBe(true)
    expect(call.poolSql.some((sql) => /pg_advisory_xact_lock|DELETE FROM user_roles|user_namespace_admissions|role_permissions|SELECT TRUE AS allowed/.test(sql))).toBe(false)
    expect(rbacServiceMocks.listUserPermissions).toHaveBeenCalledWith(SINGLE_USER_ID)
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalled()
  })

  it('batch unassign locks sorted target ids and finishes every witness before commit', async () => {
    const call = installTransaction()
    const res = mockResponse()
    await invokeHandler(attendanceAdminRouter(), BATCH_PATH, {
      query: { scope: 'global' },
      body: { userIds: BATCH_REQUEST_ORDER, template: 'employee' },
    }, res)

    expect(res.statusCode).toBe(200)
    const data = (res.body as { ok: boolean; data: Record<string, unknown> }).data
    expect(data).toMatchObject({
      roleId: 'attendance_employee',
      requested: 3,
      eligible: 3,
      updated: 3,
      affectedUserIds: BATCH_REQUEST_ORDER,
      affectedUserIdsTruncated: false,
      unchangedUserIds: [],
      missingUserIds: [],
      inactiveUserIds: [],
    })
    expect(data).not.toHaveProperty('disabledNamespaces')
    expect(call.events).toEqual([
      'begin',
      'resolve-targets',
      'lock',
      'lock',
      'lock',
      'delete',
      'list-namespaces',
      'remaining-role',
      'witness',
      'list-namespaces',
      'remaining-role',
      'witness',
      'list-namespaces',
      'remaining-role',
      'witness',
      'commit',
    ])
    expect(call.lockKeys).toEqual(BATCH_SORTED_ORDER.map((id) => `namespace-admission:${id}`))
    expect(call.namespaceRoleIds).toEqual([
      'attendance_employee',
      'attendance_employee',
      'attendance_employee',
    ])
    expect(call.witnessParams.map((params) => params[0])).toEqual(BATCH_SORTED_ORDER)
    expect(call.witnessParams.every((params) => params[1] === 'attendance' && params[2] === 'role_unassigned' && params[3] === ACTOR_ID && params[4] === false)).toBe(true)
    const lastWitness = call.events.lastIndexOf('witness')
    expect(lastWitness).toBeGreaterThan(call.events.indexOf('delete'))
    expect(call.events.indexOf('commit')).toBeGreaterThan(lastWitness)
    expect(call.events.indexOf('lock')).toBeLessThan(call.events.indexOf('delete'))
    expect(call.committed).toBe(true)
    expect(call.poolSql).toEqual([])
    expect(rbacServiceMocks.listUserPermissions).not.toHaveBeenCalled()
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalled()
  })
})

describe('attendance-admin unassign witness failure and recovery conflict', () => {
  it.each(entries)('$name rolls back when the witness write fails', async (entry) => {
    const call = installTransaction({ failOn: 'witness', failError: witnessCheckError() })
    const res = mockResponse()
    await invokeHandler(attendanceAdminRouter(), entry.path, {
      params: entry.params,
      query: { scope: 'global' },
      body: entry.body,
    }, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: { code: entry.failureCode, message: 'witness check failed', details: undefined },
    })
    expect(call.committed).toBe(false)
    expect(call.events.at(-1)).toBe('rollback')
    expect(mutationEvents(call.events).filter((event) => event !== 'rollback')).toEqual(
      entry.name === 'single'
        ? ['lock', 'delete', 'witness']
        : ['lock', 'lock', 'lock', 'delete', 'witness'],
    )
    expect(call.events).not.toContain('commit')
    expect(rbacServiceMocks.listUserPermissions).not.toHaveBeenCalled()
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalled()
  })

  it.each(entries)('$name answers retryable 409 and does not commit when recovery rejects the transaction', async (entry) => {
    const call = installTransaction({
      failOn: entry.name === 'single' ? 'delete' : 'witness',
      failError: markerError(),
    })
    const res = mockResponse()
    await invokeHandler(attendanceAdminRouter(), entry.path, {
      params: entry.params,
      query: { scope: 'global' },
      body: entry.body,
    }, res)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    expect(call.committed).toBe(false)
    expect(call.events.at(-1)).toBe('rollback')
    expect(call.events).not.toContain('commit')
    if (entry.name === 'single') {
      expect(mutationEvents(call.events)).toEqual(['lock', 'delete', 'rollback'])
      expect(call.witnessParams).toEqual([])
    } else {
      expect(call.lockKeys).toEqual(BATCH_SORTED_ORDER.map((id) => `namespace-admission:${id}`))
      expect(mutationEvents(call.events)).toEqual(['lock', 'lock', 'lock', 'delete', 'witness', 'rollback'])
    }
    expect(rbacServiceMocks.listUserPermissions).not.toHaveBeenCalled()
  })
})
