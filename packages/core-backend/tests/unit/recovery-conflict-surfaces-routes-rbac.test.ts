/**
 * O2-S2 — per-surface discriminating tests, HTTP layer (RBAC-family routers).
 *
 * For each route surface: inject the marker 40001 at the db seam → EXACT uniform
 * retryable 409 body; inject a non-40001 error → the route's ORIGINAL error semantics,
 * asserted positively (exact status/body, or the same error object rejecting for the
 * routers that had no catch before this slice).
 *
 * Surfaces covered here:
 *   - routes/roles.ts                  (POST /api/roles, DELETE /api/roles/:id)
 *   - routes/spreadsheet-permissions.ts (grant / revoke)
 *   - routes/permissions.ts            (POST /api/permissions/grant)
 *   - routes/attendance-admin.ts       (POST .../users/:userId/roles/assign,
 *                                       POST .../users/batch/roles/assign)
 */

import type { Request, Response, Router } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  poolQuery: vi.fn(),
}))

const rbacServiceMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
  userHasPermission: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.poolQuery },
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacServiceMocks.isAdmin,
  listUserPermissions: rbacServiceMocks.listUserPermissions,
  invalidateUserPerms: rbacServiceMocks.invalidateUserPerms,
  userHasPermission: rbacServiceMocks.userHasPermission,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

// attendance-admin's module graph (not exercised here) — same seams as the
// w4c4 route suite.
vi.mock('../../src/routes/admin-users', () => ({
  ensurePlatformAdmin: vi.fn(async () => 'admin-1'),
}))
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
import { rolesRouter } from '../../src/routes/roles'
import { spreadsheetPermissionsRouter } from '../../src/routes/spreadsheet-permissions'
import { permissionsRouter } from '../../src/routes/permissions'
import { attendanceAdminRouter } from '../../src/routes/attendance-admin'
import { censusFile } from './lib/recovery-census-recorder'

// O2-A1/P3-1 RUNTIME leg linkage: each recovery-census leg below records its
// site as its LAST statement, and the file-level afterAll installed here asserts the
// EXECUTED set equals this file's registered set exactly. A skipped/focused-out/deleted
// leg therefore reds this file instead of silently leaving a dead call site green.
const census = censusFile('recovery-conflict-surfaces-routes-rbac.test.ts')

const UNIFORM_409_BODY = {
  ok: false,
  error: {
    code: RECOVERY_CONFLICT_HTTP_CODE,
    message: RECOVERY_CONFLICT_HTTP_MESSAGE,
    details: { retryable: true },
  },
}

function markerError(): Error & { code: string } {
  return Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
}

function otherDbError(): Error & { code: string } {
  return Object.assign(new Error('deadlock detected'), { code: '40P01' })
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

/** Invoke the route's FINAL handler directly (guards are not under test here). */
function invokeHandler(
  router: Router,
  method: 'post' | 'put' | 'delete',
  path: string,
  req: Partial<Request>,
  res: Response,
): Promise<unknown> {
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string
        methods: Record<string, boolean>
        stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
      }
    }>
  }).stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  const fullReq = {
    method: method.toUpperCase(),
    headers: {},
    query: {},
    params: {},
    body: {},
    user: { id: 'admin-1' },
    ...req,
  } as unknown as Request
  return Promise.resolve(handler(fullReq, res, (err?: unknown) => {
    if (err) throw err
  }))
}

beforeEach(() => {
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  pgMocks.poolQuery.mockReset()
  rbacServiceMocks.isAdmin.mockReset()
  rbacServiceMocks.listUserPermissions.mockReset()
  rbacServiceMocks.invalidateUserPerms.mockReset()
  auditMocks.auditLog.mockReset()
  auditMocks.auditLog.mockResolvedValue(undefined)
})

describe('routes/roles.ts', () => {
  it('[recovery-census:roles:create] POST /api/roles: marker 40001 on the write → exact uniform retryable 409', async () => {
    pgMocks.poolQuery.mockRejectedValue(markerError())
    const res = mockResponse()
    await invokeHandler(rolesRouter(), 'post', '/api/roles', {
      body: { id: 'role-1', name: 'Role', permissions: ['p:read'] },
    }, res)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('roles:create')
  })

  it('POST /api/roles: non-40001 error → the SAME rejection as before (no catch existed)', async () => {
    const original = otherDbError()
    pgMocks.poolQuery.mockRejectedValue(original)
    const res = mockResponse()
    await expect(invokeHandler(rolesRouter(), 'post', '/api/roles', {
      body: { id: 'role-1', name: 'Role' },
    }, res)).rejects.toBe(original)
    // And nothing was written to the response — the original semantics exactly.
    expect(res.body).toBeUndefined()
  })

  it('[recovery-census:roles:delete] DELETE /api/roles/:id: marker 40001 (FK cascade into role_permissions/user_roles) → 409', async () => {
    pgMocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'role-1', name: 'Role' }] })
      .mockRejectedValueOnce(markerError())
    const res = mockResponse()
    await invokeHandler(rolesRouter(), 'delete', '/api/roles/:id', {
      params: { id: 'role-1' },
    }, res)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('roles:delete')
  })

  it('[recovery-census:roles:update] PUT /api/roles/:id: marker 40001 on the UPDATE → exact uniform retryable 409', async () => {
    pgMocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'role-1', name: 'Role' }] }) // SELECT before
      .mockRejectedValueOnce(markerError()) // UPDATE roles
    const res = mockResponse()
    await invokeHandler(rolesRouter(), 'put', '/api/roles/:id', {
      params: { id: 'role-1' },
      body: { name: 'Renamed' },
    }, res)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('roles:update')
  })

  it('PUT /api/roles/:id: non-40001 error → the SAME rejection as before (no catch existed)', async () => {
    const original = otherDbError()
    pgMocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'role-1', name: 'Role' }] })
      .mockRejectedValueOnce(original)
    const res = mockResponse()
    await expect(invokeHandler(rolesRouter(), 'put', '/api/roles/:id', {
      params: { id: 'role-1' },
      body: { name: 'Renamed' },
    }, res)).rejects.toBe(original)
    expect(res.body).toBeUndefined()
  })
})

describe('routes/spreadsheet-permissions.ts', () => {
  it('[recovery-census:spreadsheet-permissions:grant] grant: marker 40001 inside the locked transaction → exact uniform retryable 409', async () => {
    pgMocks.transaction.mockRejectedValue(markerError())
    const res = mockResponse()
    await invokeHandler(
      spreadsheetPermissionsRouter(),
      'post',
      '/api/spreadsheets/:id/permissions/grant',
      { params: { id: 'sheet-1' }, body: { userId: 'user-1', permission: 'read' } },
      res,
    )
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('spreadsheet-permissions:grant')
  })

  it('grant: non-40001 error → the SAME rejection as before (no catch existed)', async () => {
    const original = otherDbError()
    pgMocks.transaction.mockRejectedValue(original)
    const res = mockResponse()
    await expect(invokeHandler(
      spreadsheetPermissionsRouter(),
      'post',
      '/api/spreadsheets/:id/permissions/grant',
      { params: { id: 'sheet-1' }, body: { userId: 'user-1', permission: 'read' } },
      res,
    )).rejects.toBe(original)
    expect(res.body).toBeUndefined()
  })

  it('[recovery-census:spreadsheet-permissions:revoke] revoke: marker 40001 inside the locked transaction → exact uniform retryable 409', async () => {
    pgMocks.transaction.mockRejectedValue(markerError())
    const res = mockResponse()
    await invokeHandler(
      spreadsheetPermissionsRouter(),
      'post',
      '/api/spreadsheets/:id/permissions/revoke',
      { params: { id: 'sheet-1' }, body: { userId: 'user-1', permission: 'read' } },
      res,
    )
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('spreadsheet-permissions:revoke')
  })
})

describe('routes/permissions.ts', () => {
  it('[recovery-census:permissions:grant] grant: marker 40001 on the user_permissions INSERT → exact uniform retryable 409', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    pgMocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'perm:x' }] }) // permission exists
      .mockRejectedValueOnce(markerError()) // INSERT INTO user_permissions
    const res = mockResponse()
    await invokeHandler(permissionsRouter(), 'post', '/api/permissions/grant', {
      body: { userId: 'user-1', permission: 'perm:x' },
    }, res)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('permissions:grant')
  })

  it('grant: non-40001 error → ORIGINAL 500 body, exactly as before', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    pgMocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'perm:x' }] })
      .mockRejectedValueOnce(otherDbError())
    const res = mockResponse()
    await invokeHandler(permissionsRouter(), 'post', '/api/permissions/grant', {
      body: { userId: 'user-1', permission: 'perm:x' },
    }, res)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'Failed to grant permission' })
  })

  it('[recovery-census:permissions:revoke] revoke: marker 40001 on the user_permissions DELETE → exact uniform retryable 409', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    pgMocks.poolQuery.mockRejectedValueOnce(markerError()) // DELETE FROM user_permissions
    const res = mockResponse()
    await invokeHandler(permissionsRouter(), 'post', '/api/permissions/revoke', {
      body: { userId: 'user-1', permission: 'perm:x' },
    }, res)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('permissions:revoke')
  })

  it('revoke: non-40001 error → ORIGINAL 500 body, exactly as before', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    pgMocks.poolQuery.mockRejectedValueOnce(otherDbError())
    const res = mockResponse()
    await invokeHandler(permissionsRouter(), 'post', '/api/permissions/revoke', {
      body: { userId: 'user-1', permission: 'perm:x' },
    }, res)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'Failed to revoke permission' })
  })

  it('[recovery-census:permissions:template-apply] template apply: marker 40001 on the user_permissions INSERT → exact uniform retryable 409', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    // 'attendance-employee' is a REAL preset-backed template with non-empty permissions,
    // so the handler reaches the INSERT INTO user_permissions write.
    pgMocks.poolQuery.mockRejectedValueOnce(markerError())
    const res = mockResponse()
    await invokeHandler(permissionsRouter(), 'post', '/api/admin/permission-templates/apply', {
      body: { userId: 'user-1', templateId: 'attendance-employee' },
    }, res)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('permissions:template-apply')
  })

  it('template apply: non-40001 error → ORIGINAL 500 body, exactly as before', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    pgMocks.poolQuery.mockRejectedValueOnce(otherDbError())
    const res = mockResponse()
    await invokeHandler(permissionsRouter(), 'post', '/api/admin/permission-templates/apply', {
      body: { userId: 'user-1', templateId: 'attendance-employee' },
    }, res)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'Failed to apply permission template' })
  })
})

// Request bodies here name a role TEMPLATE rather than a raw role id. These cases assert
// recovery-conflict classification (marker 40001 → uniform retryable 409; everything else
// keeps its original 500) — the body is only ever the shortest one that gets past the
// ROLE_REQUIRED 400, and was never an assertion that a raw role id is a supported request
// contract. Now that this router constrains role ids to its own scope, a template is the
// shortest such body. Every assertion below is unchanged, and the [recovery-census:…]
// titles are byte-identical so the recorded census set is untouched.
describe('routes/attendance-admin.ts', () => {
  function installUserRolesRejection(error: unknown): void {
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO user_roles/.test(sql)) throw error
      if (/FROM users/.test(sql)) {
        return {
          rows: [{
            id: 'user-1', email: 'u@example.com', name: 'U', employeeNo: null,
            department: null, role: 'user', is_active: true, is_admin: false,
            last_login_at: null, created_at: 'now',
          }],
        }
      }
      // ensureAttendanceRoleTemplates seeds permissions / role_permissions.
      return { rows: [], rowCount: 0 }
    })
  }

  it('[recovery-census:attendance-admin:assign] single role assign: marker 40001 on the user_roles INSERT → exact uniform retryable 409', async () => {
    installUserRolesRejection(markerError())
    rbacServiceMocks.listUserPermissions.mockResolvedValue([])
    rbacServiceMocks.isAdmin.mockResolvedValue(false)
    const res = mockResponse()
    await invokeHandler(
      attendanceAdminRouter(),
      'post',
      '/api/attendance-admin/users/:userId/roles/assign',
      { params: { userId: 'user-1' }, body: { template: 'employee' } },
      res,
    )
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('attendance-admin:assign')
  })

  it('single role assign: non-40001 error → ORIGINAL 500 ROLE_ASSIGN_FAILED, exactly as before', async () => {
    installUserRolesRejection(otherDbError())
    const res = mockResponse()
    await invokeHandler(
      attendanceAdminRouter(),
      'post',
      '/api/attendance-admin/users/:userId/roles/assign',
      { params: { userId: 'user-1' }, body: { template: 'employee' } },
      res,
    )
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'ROLE_ASSIGN_FAILED', message: 'deadlock detected', details: undefined },
    })
  })

  it('[recovery-census:attendance-admin:batch-assign] batch role assign: marker 40001 on the user_roles INSERT → exact uniform retryable 409', async () => {
    const batchUserId = '10000000-0000-4000-8000-000000000001'
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO user_roles/.test(sql)) throw markerError()
      if (/FROM users/.test(sql)) {
        return { rows: [{ id: batchUserId, email: 'u@example.com', name: 'U', is_active: true }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = mockResponse()
    await invokeHandler(
      attendanceAdminRouter(),
      'post',
      '/api/attendance-admin/users/batch/roles/assign',
      { body: { userIds: [batchUserId], template: 'employee' } },
      res,
    )
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('attendance-admin:batch-assign')
  })

  it('[recovery-census:attendance-admin:unassign] single role unassign: marker 40001 on the user_roles DELETE → exact uniform retryable 409', async () => {
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (/DELETE FROM user_roles/.test(sql)) throw markerError()
      if (/FROM users/.test(sql)) {
        return {
          rows: [{
            id: 'user-1', email: 'u@example.com', name: 'U', employeeNo: null,
            department: null, role: 'user', is_active: true, is_admin: false,
            last_login_at: null, created_at: 'now',
          }],
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = mockResponse()
    await invokeHandler(
      attendanceAdminRouter(),
      'post',
      '/api/attendance-admin/users/:userId/roles/unassign',
      { params: { userId: 'user-1' }, body: { template: 'employee' } },
      res,
    )
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('attendance-admin:unassign')
  })

  it('single role unassign: non-40001 error → ORIGINAL 500 ROLE_UNASSIGN_FAILED, exactly as before', async () => {
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (/DELETE FROM user_roles/.test(sql)) throw otherDbError()
      if (/FROM users/.test(sql)) {
        return {
          rows: [{
            id: 'user-1', email: 'u@example.com', name: 'U', employeeNo: null,
            department: null, role: 'user', is_active: true, is_admin: false,
            last_login_at: null, created_at: 'now',
          }],
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = mockResponse()
    await invokeHandler(
      attendanceAdminRouter(),
      'post',
      '/api/attendance-admin/users/:userId/roles/unassign',
      { params: { userId: 'user-1' }, body: { template: 'employee' } },
      res,
    )
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'ROLE_UNASSIGN_FAILED', message: 'deadlock detected', details: undefined },
    })
  })

  it('[recovery-census:attendance-admin:batch-unassign] batch role unassign: marker 40001 on the user_roles DELETE → exact uniform retryable 409', async () => {
    const batchUserId = '10000000-0000-4000-8000-000000000002'
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (/DELETE FROM user_roles/.test(sql)) throw markerError()
      if (/FROM users/.test(sql)) {
        return { rows: [{ id: batchUserId, email: 'u@example.com', name: 'U', is_active: true }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = mockResponse()
    await invokeHandler(
      attendanceAdminRouter(),
      'post',
      '/api/attendance-admin/users/batch/roles/unassign',
      { body: { userIds: [batchUserId], template: 'employee' } },
      res,
    )
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    census.record('attendance-admin:batch-unassign')
  })
})
