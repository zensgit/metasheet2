import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authUser: { id: 'admin-1' } as { id?: string },
}))

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  inspectUserPermissionGrants: vi.fn(),
  userHasPermission: vi.fn(),
  invalidateUserPerms: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: (error?: unknown) => void) => {
    req.user = state.authUser as never
    next()
  },
}))

vi.mock('../../src/db/pg', () => ({
  pool: { query: pgMocks.query },
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
  listUserPermissions: rbacMocks.listUserPermissions,
  inspectUserPermissionGrants: rbacMocks.inspectUserPermissionGrants,
  userHasPermission: rbacMocks.userHasPermission,
  invalidateUserPerms: rbacMocks.invalidateUserPerms,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

import { permissionsRouter } from '../../src/routes/permissions'
import { removeMatchingLegacyPermission } from '../../src/admin/legacy-permission-revoke'

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
  } as Response & { statusCode: number; body: unknown; headersSent: boolean }
}

async function invokeLegacyRevoke(body: Record<string, unknown>) {
  const router = permissionsRouter()
  const layer = router.stack.find((entry) => entry.route?.path === '/api/permissions/legacy/revoke' && entry.route?.methods?.post)
  if (!layer?.route?.stack) throw new Error('legacy revoke route missing')
  const req = {
    method: 'POST',
    url: '/api/permissions/legacy/revoke',
    headers: {},
    query: {},
    params: {},
    body,
    user: undefined,
  } as unknown as Request
  const res = createMockResponse()
  for (const routeLayer of layer.route.stack) {
    await new Promise<void>((resolve, reject) => {
      try {
        const maybePromise = routeLayer.handle(req, res, (error?: unknown) => {
          if (error) reject(error)
          else resolve()
        })
        if (maybePromise && typeof maybePromise.then === 'function') {
          Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
        } else if (routeLayer.handle.length < 3) {
          resolve()
        }
      } catch (error) {
        reject(error)
      }
    })
  }
  return res
}

type Script = {
  columnType?: string
  permissions?: unknown
  actorRole?: string
  actorRoles?: string[]
  targetRoles?: string[]
  targetActive?: boolean
  deletedAt?: string | null
  missingTarget?: boolean
  failWrite?: Error | null
  suppressWrite?: boolean
}

function installScript(script: Script) {
  const sqlLog: string[] = []
  const order: string[] = []
  let permissionWrite: unknown[] | undefined
  pgMocks.transaction.mockImplementation(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => {
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        const text = String(sql)
        sqlLog.push(text)
        if (text.includes('ORDER BY role_id ASC')) {
          const roles = params?.[0] === 'admin-1' ? (script.actorRoles ?? ['admin']) : []
          return { rows: roles.map((roleId) => ({ role_id: roleId })) }
        }
        if (text.includes('FROM user_roles')) {
          const roles = params?.[0] === 'admin-1'
            ? (script.actorRoles ?? ['admin'])
            : (script.targetRoles ?? ['attendance_employee'])
          return { rows: roles.map((roleId) => ({ role_id: roleId })) }
        }
        if (text.includes('FOR SHARE')) return { rows: [{ id: params?.[0] }] }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
        if (text.includes('FOR UPDATE')) {
          const id = String(params?.[0] ?? '')
          if (script.missingTarget && id !== 'admin-1') return { rows: [] }
          return {
            rows: [{
              id,
              role: id === 'admin-1' ? (script.actorRole ?? 'admin') : 'user',
              activation_status: 'activated',
              is_active: id === 'admin-1' ? true : (script.targetActive ?? true),
              access_generation: 1,
              deleted_at: id === 'admin-1' ? null : (script.deletedAt ?? null),
              purged_at: null,
            }],
          }
        }
        if (text.includes('SET permissions')) {
          if (script.failWrite) throw script.failWrite
          permissionWrite = params
          if (script.suppressWrite) return { rows: [], rowCount: 0 }
          return { rows: [{ id: params?.[0] }], rowCount: 1 }
        }
        if (text.includes('pg_typeof')) {
          return {
            rows: [{
              permissions_type: script.columnType ?? 'jsonb',
              permissions: script.permissions,
            }],
          }
        }
        if (text.includes('access_generation')) return { rows: [{ access_generation: 2 }] }
        if (text.includes('directory_deprovision')) return { rows: [] }
        throw new Error(`unexpected legacy sql: ${text.slice(0, 180)}`)
      },
    }
    try {
      const result = await handler(client)
      order.push('commit')
      return result
    } catch (error) {
      order.push('rollback')
      throw error
    }
  })
  return { sqlLog, order, readWrite: () => permissionWrite }
}

describe('legacy permission revoke', () => {
  beforeEach(() => {
    state.authUser = { id: 'admin-1' }
    rbacMocks.isAdmin.mockReset()
    rbacMocks.isAdmin.mockImplementation(() => {
      throw new Error('token isAdmin must not authorize legacy revoke')
    })
    rbacMocks.invalidateUserPerms.mockReset()
    auditMocks.auditLog.mockReset()
    auditMocks.auditLog.mockResolvedValue(undefined)
    pgMocks.transaction.mockReset()
  })

  it('removes every padded copy and keeps other values in order', () => {
    expect(removeMatchingLegacyPermission(
      [' attendance:read ', 'attendance:read', 'attendance:write', 7],
      'attendance:read',
    )).toEqual({
      next: ['attendance:write', 7],
      changed: true,
    })
    expect(removeMatchingLegacyPermission({ bad: true }, 'attendance:read').changed).toBe(false)
    expect(removeMatchingLegacyPermission(['attendance:write'], 'attendance:read').changed).toBe(false)
    expect(removeMatchingLegacyPermission(
      [' keep ', null, 'attendance:read', null],
      'attendance:read',
    )).toEqual({
      next: [' keep ', null, null],
      changed: true,
    })
    expect(removeMatchingLegacyPermission('["attendance:read","keep"]', 'attendance:read')).toEqual({
      next: '["attendance:read","keep"]',
      changed: false,
    })
  })

  it('clears only the legacy column for an inactive target and invalidates after commit', async () => {
    const script = installScript({
      columnType: 'jsonb',
      permissions: [' attendance:read ', 'attendance:read', 'attendance:write', 7],
      targetActive: false,
    })

    const response = await invokeLegacyRevoke({ userId: ' user-1 ', permission: ' attendance:read ' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      success: true,
      userId: 'user-1',
      permission: 'attendance:read',
      changed: true,
    })
    const written = script.readWrite()
    expect(written?.[0]).toBe('user-1')
    expect(written?.[1]).toBe(JSON.stringify(['attendance:write', 7]))
    const permissionUpdate = script.sqlLog.find((sql) => sql.includes('SET permissions')) ?? ''
    expect(permissionUpdate).toContain('$2::jsonb')
    expect(permissionUpdate).not.toMatch(/role|is_admin|is_active|activation_status|user_permissions|role_permissions/)
    const admissionAt = script.sqlLog.findIndex((sql) => sql.includes('pg_advisory_xact_lock'))
    const userAt = script.sqlLog.findIndex((sql) => sql.includes('FOR UPDATE'))
    const writeAt = script.sqlLog.findIndex((sql) => sql.includes('SET permissions'))
    expect(script.sqlLog.some((sql) => sql.includes('FOR SHARE'))).toBe(false)
    expect(script.sqlLog.some((sql) => sql.includes('FROM roles'))).toBe(false)
    expect(admissionAt).toBeGreaterThanOrEqual(0)
    expect(admissionAt).toBeLessThan(userAt)
    expect(userAt).toBeLessThan(writeAt)
    expect(script.sqlLog[writeAt]).toContain('RETURNING id')
    expect(script.sqlLog.some((sql) => sql.includes('directory_deprovision_effects'))).toBe(true)
    expect(script.order).toEqual(['commit'])
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke',
      resourceType: 'legacy-permission',
      resourceId: 'user-1:attendance:read',
    }))
    expect(rbacMocks.isAdmin).not.toHaveBeenCalled()
  })

  it('writes a text[] cast and keeps unmatched strings and nulls', async () => {
    const script = installScript({
      columnType: 'text[]',
      permissions: ['  attendance:read', null, 'attendance:read', ' keep ', null],
    })

    const response = await invokeLegacyRevoke({ userId: 'user-1', permission: 'attendance:read' })

    expect(response.statusCode).toBe(200)
    expect((response.body as { changed: boolean }).changed).toBe(true)
    expect(script.readWrite()?.[1]).toEqual([null, ' keep ', null])
    expect(script.sqlLog.find((sql) => sql.includes('SET permissions'))).toContain('$2::text[]')
  })

  it('leaves a jsonb scalar unchanged when its text is an encoded array', async () => {
    const encoded = '["attendance:read","keep"]'
    const script = installScript({
      columnType: 'jsonb',
      permissions: encoded,
    })

    const response = await invokeLegacyRevoke({ userId: 'user-1', permission: 'attendance:read' })

    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: 'Legacy permission not found for user' })
    expect(response.body).not.toHaveProperty('success')
    expect(response.body).not.toHaveProperty('changed')
    expect(script.readWrite()).toBeUndefined()
    expect(script.sqlLog.some((sql) => sql.includes('SET permissions'))).toBe(false)
    expect(script.sqlLog.some((sql) => sql.includes('directory_deprovision'))).toBe(false)
    expect(rbacMocks.invalidateUserPerms).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('does not assert changed when the permission update matches zero rows', async () => {
    const script = installScript({
      columnType: 'jsonb',
      permissions: ['attendance:read'],
      suppressWrite: true,
    })

    const response = await invokeLegacyRevoke({ userId: 'user-1', permission: 'attendance:read' })

    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: 'Legacy permission not found for user' })
    expect(response.body).not.toHaveProperty('changed')
    expect(script.readWrite()?.[1]).toBe(JSON.stringify([]))
    expect(script.sqlLog.some((sql) => sql.includes('directory_deprovision'))).toBe(false)
    expect(rbacMocks.invalidateUserPerms).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('does not pretend a missing legacy code changed', async () => {
    const script = installScript({
      columnType: 'jsonb',
      permissions: ['attendance:write'],
    })

    const response = await invokeLegacyRevoke({ userId: 'user-1', permission: 'attendance:read' })

    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: 'Legacy permission not found for user' })
    expect(response.body).not.toHaveProperty('changed')
    expect(script.readWrite()).toBeUndefined()
    expect(script.sqlLog.some((sql) => sql.includes('directory_deprovision'))).toBe(false)
    expect(rbacMocks.invalidateUserPerms).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('refuses a missing target, a recycled target, and a demoted actor', async () => {
    installScript({ missingTarget: true })
    let response = await invokeLegacyRevoke({ userId: 'missing', permission: 'attendance:read' })
    expect(response.statusCode).toBe(404)
    expect((response.body as { code?: string }).code).toBe('NOT_FOUND')

    installScript({ deletedAt: '2026-01-01T00:00:00.000Z' })
    response = await invokeLegacyRevoke({ userId: 'user-1', permission: 'attendance:read' })
    expect(response.statusCode).toBe(409)
    expect((response.body as { code?: string }).code).toBe('USER_IN_RECYCLE_BIN')

    installScript({ actorRole: 'user', actorRoles: [] })
    response = await invokeLegacyRevoke({ userId: 'user-1', permission: 'attendance:read' })
    expect(response.statusCode).toBe(403)
    expect((response.body as { code?: string }).code).toBe('FORBIDDEN')
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
    expect(rbacMocks.invalidateUserPerms).not.toHaveBeenCalled()
  })

  it('rolls the response back when the permission write hits a recovery lease', async () => {
    const busy = Object.assign(new Error('METASHEET_RECOVERY_AUTHORITY_BUSY'), { code: '40001' })
    const script = installScript({
      columnType: 'jsonb',
      permissions: ['attendance:read'],
      failWrite: busy,
    })

    const response = await invokeLegacyRevoke({ userId: 'user-1', permission: 'attendance:read' })

    expect(response.statusCode).toBe(409)
    expect((response.body as { ok?: boolean; error?: { code?: string } }).ok).toBe(false)
    expect((response.body as { error?: { code?: string } }).error?.code).toBe('RECOVERY_AUTHORITY_BUSY')
    expect(script.order).toEqual(['rollback'])
    expect(rbacMocks.invalidateUserPerms).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('does not report a change when the column type cannot be written back', async () => {
    const script = installScript({
      columnType: 'json',
      permissions: ['attendance:read'],
    })

    const response = await invokeLegacyRevoke({ userId: 'user-1', permission: 'attendance:read' })

    expect(response.statusCode).toBe(500)
    expect(script.readWrite()).toBeUndefined()
    expect(script.order).toEqual(['rollback'])
    expect(rbacMocks.invalidateUserPerms).not.toHaveBeenCalled()
  })
})
