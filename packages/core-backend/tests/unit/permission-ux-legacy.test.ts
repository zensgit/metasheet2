import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authUser: { id: 'admin-1', isAdmin: true, role: 'admin' } as Record<string, unknown>,
  poolQuery: vi.fn(),
  query: vi.fn(),
  transaction: vi.fn(),
  auditLog: vi.fn(),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: (error?: unknown) => void) => {
    req.user = state.authUser as never
    next()
  },
}))

vi.mock('../../src/db/pg', () => ({
  pool: { query: state.poolQuery },
  query: state.query,
  transaction: state.transaction,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: state.auditLog,
}))

import { getPermCacheStatus, inspectUserPermissionGrants, userHasPermission } from '../../src/rbac/service'
import { permissionsRouter } from '../../src/routes/permissions'

function createMockResponse() {
  return {
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
  } as Response & { statusCode: number; body: unknown }
}

async function invokeLegacyRevoke(body: unknown) {
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
      const maybePromise = routeLayer.handle(req, res, (error?: unknown) => {
        if (error) reject(error)
        else resolve()
      })
      if (maybePromise && typeof maybePromise.then === 'function') {
        Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
      }
    })
  }
  return res
}

describe('inherited role inspection', () => {
  beforeEach(() => {
    state.poolQuery.mockReset()
    state.query.mockReset()
    state.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('FROM user_permissions')) return { rows: [{ code: 'workflow:read' }] }
      if (text.includes('LEFT JOIN roles')) {
        return {
          rows: [
            { code: 'workflow:read', role_id: 'named-role', role_name: ' Named ' },
            { code: ' historical:obsolete ', role_id: 'orphan-role', role_name: null },
            { code: 'workflow:read', role_id: 'orphan-role', role_name: '   ' },
          ],
        }
      }
      if (text.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [' kept:note '] }] }
      if (text.includes('JOIN role_permissions')) return { rows: [] }
      return { rows: [] }
    })
    state.query.mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('user_namespace_admissions')) return { rows: [] }
      if (text.includes('FROM user_roles')) {
        return { rows: [{ role_id: 'named-role', permission_code: 'workflow:read' }] }
      }
      return { rows: [] }
    })
  })

  it('keeps an orphan role and does not change permission matching or the serve cache', async () => {
    const inspection = await inspectUserPermissionGrants('user-1')

    expect(inspection.inheritedRoles).toEqual([
      { roleId: 'named-role', roleName: 'Named', permissions: ['workflow:read'] },
      { roleId: 'orphan-role', roleName: null, permissions: ['historical:obsolete', 'workflow:read'] },
    ])
    expect(inspection.inherited).toEqual(['historical:obsolete', 'workflow:read'])
    expect(inspection.direct).toEqual(['workflow:read'])
    expect(inspection.legacy).toEqual(['kept:note'])
    expect(inspection.unavailable).toBeUndefined()
    expect(Array.isArray(inspection.blockedByNamespaceAdmission)).toBe(true)
    expect(getPermCacheStatus().cacheSize).toBe(0)

    state.poolQuery.mockClear()
    await userHasPermission('user-1', 'workflow:read')
    const matchingSql = state.poolQuery.mock.calls.map((call) => String(call[0]))
    expect(matchingSql.some((sql) => sql.includes('LEFT JOIN roles'))).toBe(false)
    expect(matchingSql.some((sql) => sql.includes('FROM user_permissions'))).toBe(true)
    expect(getPermCacheStatus().cacheSize).toBe(0)
  })
})

describe('legacy revoke waits for the live actor', () => {
  beforeEach(() => {
    state.authUser = { id: 'admin-1', isAdmin: true, role: 'admin' }
    state.auditLog.mockReset()
    state.auditLog.mockResolvedValue(undefined)
    state.transaction.mockReset()
  })

  it('refuses an actor demoted while the admission lock is held and writes nothing', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let markStarted = (): void => undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const actor = { role: 'admin', roles: ['admin'] }
    const direct = ['workflow:read']
    const rolePermissions = ['workflow:read']
    let permissionWrite: unknown
    state.transaction.mockImplementation(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => {
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          const text = String(sql)
          if (text.includes('DELETE FROM user_permissions') || text.includes('role_permissions') && text.includes('DELETE')) {
            throw new Error('legacy revoke touched a direct or role grant')
          }
          if (text.includes('pg_advisory_xact_lock') && String(params?.[0]) === 'namespace-admission:admin-1') {
            markStarted()
            await gate
            return { rows: [] }
          }
          if (text.includes('ORDER BY role_id ASC')) {
            return { rows: actor.roles.map((roleId) => ({ role_id: roleId })) }
          }
          if (text.includes('FROM user_roles')) return { rows: [{ role_id: 'attendance_employee' }] }
          if (text.includes('FOR SHARE') || text.includes('pg_advisory_xact_lock')) return { rows: [{ id: params?.[0] }] }
          if (text.includes('FOR UPDATE')) {
            const id = String(params?.[0] ?? '')
            return {
              rows: [{
                id,
                role: id === 'admin-1' ? actor.role : 'user',
                activation_status: 'activated',
                is_active: true,
                access_generation: 3,
                deleted_at: null,
                purged_at: null,
              }],
            }
          }
          if (text.includes('pg_typeof')) return { rows: [{ permissions_type: 'jsonb', permissions: ['workflow:read'] }] }
          if (text.includes('SET permissions')) {
            permissionWrite = params
            return { rows: [{ id: params?.[0] }], rowCount: 1 }
          }
          throw new Error(`unexpected sql ${text.slice(0, 120)}`)
        },
      }
      return handler(client)
    })

    const pending = invokeLegacyRevoke({ userId: 'user-9', permission: 'workflow:read' })
    await started
    actor.role = 'user'
    actor.roles = []
    release()
    const response = await pending

    expect(response.statusCode).toBe(403)
    expect((response.body as { code?: string }).code).toBe('FORBIDDEN')
    expect(permissionWrite).toBeUndefined()
    expect(direct).toEqual(['workflow:read'])
    expect(rolePermissions).toEqual(['workflow:read'])
    expect(state.auditLog).not.toHaveBeenCalled()
  })

  it('refuses when the waiting lock deletes only user_roles admin and users.role stays admin', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let markStarted = (): void => undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const actor = { role: 'admin', roles: ['admin'] }
    const sqlLog: string[] = []
    let permissionWrite: unknown
    state.transaction.mockImplementation(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => {
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          const text = String(sql)
          sqlLog.push(text)
          if (text.includes('DELETE FROM user_permissions') || (text.includes('role_permissions') && text.includes('DELETE'))) {
            throw new Error('legacy revoke touched a direct or role grant')
          }
          if (text.includes('pg_advisory_xact_lock') && String(params?.[0]) === 'namespace-admission:admin-1') {
            markStarted()
            await gate
            return { rows: [] }
          }
          if (text.includes('ORDER BY role_id ASC')) {
            return { rows: actor.roles.map((roleId) => ({ role_id: roleId })) }
          }
          if (text.includes('FROM user_roles')) return { rows: actor.roles.map((roleId) => ({ role_id: roleId })) }
          if (text.includes('FOR SHARE') || text.includes('pg_advisory_xact_lock')) return { rows: [{ id: params?.[0] }] }
          if (text.includes('FOR UPDATE')) {
            const id = String(params?.[0] ?? '')
            return {
              rows: [{
                id,
                role: id === 'admin-1' ? actor.role : 'user',
                activation_status: 'activated',
                is_active: true,
                access_generation: 3,
                deleted_at: null,
                purged_at: null,
              }],
            }
          }
          if (text.includes('pg_typeof')) return { rows: [{ permissions_type: 'jsonb', permissions: ['workflow:read'] }] }
          if (text.includes('SET permissions') || text.includes('SET access_generation') || text.includes('directory_deprovision')) {
            permissionWrite = params
            throw new Error('legacy revoke wrote after a role-only demotion')
          }
          throw new Error(`unexpected sql ${text.slice(0, 120)}`)
        },
      }
      return handler(client)
    })

    const pending = invokeLegacyRevoke({ userId: 'user-9', permission: 'workflow:read' })
    await started
    actor.roles = []
    release()
    const response = await pending

    expect(actor.role).toBe('admin')
    expect(response.statusCode).toBe(403)
    expect((response.body as { code?: string }).code).toBe('FORBIDDEN')
    expect(permissionWrite).toBeUndefined()
    expect(sqlLog.some((sql) => sql.includes('SET permissions'))).toBe(false)
    expect(sqlLog.some((sql) => sql.includes('directory_deprovision'))).toBe(false)
    expect(sqlLog.some((sql) => sql.includes('SET access_generation'))).toBe(false)
    expect(state.auditLog).not.toHaveBeenCalled()
    expect(getPermCacheStatus().cacheSize).toBe(0)
  })

  it('allows a live user_roles admin whose users.role is user', async () => {
    state.transaction.mockImplementation(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => {
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          const text = String(sql)
          if (text.includes('ORDER BY role_id ASC')) return { rows: [{ role_id: 'admin' }] }
          if (text.includes('FROM user_roles')) return { rows: [{ role_id: 'attendance_employee' }] }
          if (text.includes('FOR SHARE') || text.includes('pg_advisory_xact_lock')) return { rows: [] }
          if (text.includes('FOR UPDATE')) {
            const id = String(params?.[0] ?? '')
            return {
              rows: [{
                id,
                role: 'user',
                activation_status: 'activated',
                is_active: true,
                access_generation: 4,
                deleted_at: null,
                purged_at: null,
              }],
            }
          }
          if (text.includes('SET permissions')) return { rows: [{ id: params?.[0] }], rowCount: 1 }
          if (text.includes('pg_typeof')) return { rows: [{ permissions_type: 'jsonb', permissions: ['workflow:read'] }] }
          if (text.includes('directory_deprovision')) return { rows: [] }
          if (text.includes('SET access_generation')) return { rows: [{ access_generation: 5 }] }
          throw new Error(`unexpected sql ${text.slice(0, 120)}`)
        },
      }
      return handler(client)
    })

    const response = await invokeLegacyRevoke({ userId: 'user-9', permission: 'workflow:read' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      success: true,
      userId: 'user-9',
      permission: 'workflow:read',
      changed: true,
    })
  })

  it('rolls back the legacy column and deprovision evidence when the generation write fails', async () => {
    const database = {
      permissions: ['  workflow:read ', 'workflow:read', 'keep'],
      effects: 'applied',
      events: 'applied',
      generation: 4,
    }
    const observed = { wrotePermissions: false, wroteEvidence: false, written: undefined as unknown }
    state.transaction.mockImplementation(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => {
      const snapshot = {
        permissions: [...database.permissions],
        effects: database.effects,
        events: database.events,
        generation: database.generation,
      }
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          const text = String(sql)
          if (text.includes('ORDER BY role_id ASC')) return { rows: [{ role_id: 'admin' }] }
          if (text.includes('FROM user_roles')) return { rows: [{ role_id: 'attendance_employee' }] }
          if (text.includes('FOR SHARE') || text.includes('pg_advisory_xact_lock')) return { rows: [] }
          if (text.includes('FOR UPDATE')) {
            const id = String(params?.[0] ?? '')
            return {
              rows: [{
                id,
                role: id === 'admin-1' ? 'admin' : 'user',
                activation_status: 'activated',
                is_active: id === 'admin-1',
                access_generation: database.generation,
                deleted_at: null,
                purged_at: null,
              }],
            }
          }
          // The text[] write also names pg_typeof in its WHERE guard.
          if (text.includes('SET permissions')) {
            observed.wrotePermissions = true
            observed.written = params?.[1]
            database.permissions = [...(params?.[1] as unknown[])]
            return { rows: [{ id: params?.[0] }], rowCount: 1 }
          }
          if (text.includes('pg_typeof')) {
            return { rows: [{ permissions_type: 'text[]', permissions: database.permissions }] }
          }
          if (text.includes('directory_deprovision_effects')) {
            observed.wroteEvidence = true
            database.effects = 'superseded'
            return { rows: [] }
          }
          if (text.includes('directory_deprovision_events')) {
            database.events = 'superseded'
            return { rows: [] }
          }
          if (text.includes('SET access_generation')) {
            database.generation += 1
            throw new Error('injected legacy generation failure')
          }
          throw new Error(`unexpected sql ${text.slice(0, 120)}`)
        },
      }
      try {
        return await handler(client)
      } catch (error) {
        database.permissions = snapshot.permissions
        database.effects = snapshot.effects
        database.events = snapshot.events
        database.generation = snapshot.generation
        throw error
      }
    })

    const response = await invokeLegacyRevoke({ userId: 'user-9', permission: 'workflow:read' })

    expect(response.statusCode).toBe(500)
    expect(observed.wrotePermissions).toBe(true)
    expect(observed.wroteEvidence).toBe(true)
    expect(observed.written).toEqual(['keep'])
    expect(database).toEqual({
      permissions: ['  workflow:read ', 'workflow:read', 'keep'],
      effects: 'applied',
      events: 'applied',
      generation: 4,
    })
    expect(state.auditLog).not.toHaveBeenCalled()
  })

  it('rejects a non-string permission before opening a transaction', async () => {
    const response = await invokeLegacyRevoke({ userId: 'user-9', permission: 12 })
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ error: 'userId and permission must be strings' })
    expect(state.transaction).not.toHaveBeenCalled()
  })
})
