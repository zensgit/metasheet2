import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authUser: {
    id: 'admin-1',
    role: 'user',
  },
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
}))

const bcryptMocks = vi.hoisted(() => ({
  hash: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

const inviteMocks = vi.hoisted(() => ({
  issueInviteToken: vi.fn(() => 'invite-token-fixed'),
  isInviteTokenExpired: vi.fn((token: string) => token === 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiaW52aXRlIiwiZXhwIjoxfQ.sig'),
}))

const externalAuthGrantMocks = vi.hoisted(() => ({
  isUserExternalAuthEnabled: vi.fn(),
  upsertUserExternalAuthGrant: vi.fn(),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: (error?: unknown) => void) => {
    req.user = state.authUser as never
    next()
  },
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
  listUserPermissions: rbacMocks.listUserPermissions,
  invalidateUserPerms: rbacMocks.invalidateUserPerms,
}))

vi.mock('bcryptjs', () => bcryptMocks)

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

vi.mock('../../src/auth/invite-tokens', () => ({
  issueInviteToken: inviteMocks.issueInviteToken,
  isInviteTokenExpired: inviteMocks.isInviteTokenExpired,
}))

vi.mock('../../src/auth/external-auth-grants', () => ({
  isUserExternalAuthEnabled: externalAuthGrantMocks.isUserExternalAuthEnabled,
  upsertUserExternalAuthGrant: externalAuthGrantMocks.upsertUserExternalAuthGrant,
}))

import { adminUsersRouter } from '../../src/routes/admin-users'

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    headers: {} as Record<string, string>,
    textBody: '',
    status(code: number) {
      this.statusCode = code
      return this
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = String(value)
      return this
    },
    write(chunk: unknown) {
      this.textBody += String(chunk)
      return true
    },
    end(chunk?: unknown) {
      if (chunk != null) this.textBody += String(chunk)
      this.headersSent = true
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
  } as Response & {
    statusCode: number
    body: unknown
    headersSent: boolean
    headers: Record<string, string>
    textBody: string
  }
}

async function invokeRoute(
  method: 'get' | 'post' | 'patch',
  path: string,
  options: {
    query?: Record<string, unknown>
    params?: Record<string, string>
    body?: Record<string, unknown>
  } = {},
) {
  const router = adminUsersRouter()
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: {},
    query: options.query ?? {},
    params: options.params ?? {},
    body: options.body ?? {},
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

describe('admin-users routes', () => {
  beforeEach(() => {
    state.authUser = {
      id: 'admin-1',
      role: 'user',
    }
    pgMocks.query.mockReset()
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.invalidateUserPerms.mockReset()
    bcryptMocks.hash.mockReset()
    auditMocks.auditLog.mockReset()
    inviteMocks.issueInviteToken.mockClear()
    inviteMocks.isInviteTokenExpired.mockClear()
    inviteMocks.isInviteTokenExpired.mockImplementation((token: string) => token === 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiaW52aXRlIiwiZXhwIjoxfQ.sig')
    externalAuthGrantMocks.isUserExternalAuthEnabled.mockReset().mockResolvedValue(false)
    externalAuthGrantMocks.upsertUserExternalAuthGrant.mockReset()
  })

  it('lists users with pagination payload', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
            is_admin: false,
            last_login_at: null,
            created_at: '2026-03-12T00:00:00.000Z',
            updated_at: '2026-03-12T00:00:00.000Z',
          },
        ],
      })

    const response = await invokeRoute('get', '/api/admin/users', {
      query: { q: 'alpha', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        total: 2,
        page: 1,
        pageSize: 20,
        query: 'alpha',
      },
    })
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      id: 'user-1',
      email: 'alpha@example.com',
    })
  })

  it('rejects non-admin requests', async () => {
    state.authUser = {
      id: 'user-2',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)

    const response = await invokeRoute('get', '/api/admin/users')

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('FORBIDDEN')
  })

  it('returns user access details', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read', 'workflow:read'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }, { role_id: 'workflow_operator' }],
      })

    const response = await invokeRoute('get', '/api/admin/users/:userId/access', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.roles).toEqual(['attendance_employee', 'workflow_operator'])
    expect((response.body as Record<string, any>).data.permissions).toEqual(['attendance:read', 'workflow:read'])
    expect((response.body as Record<string, any>).data.isAdmin).toBe(false)
  })

  it('assigns a role and invalidates cached permissions', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:admin'])
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_admin' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_admin' }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/assign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_admin' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.changedRoleId).toBe('attendance_admin')
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'grant',
      resourceType: 'user-role',
      resourceId: 'user-1:attendance_admin',
    }))
  })

  it('unassigns a role and writes an audit entry', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/unassign', {
      params: { userId: 'user-1' },
      body: { roleId: 'attendance_admin' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.changedRoleId).toBe('attendance_admin')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-role',
      resourceId: 'user-1:attendance_admin',
    }))
  })

  it('lists role catalog with permissions and member counts', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'attendance_admin',
          name: 'Attendance Admin',
          permissions: ['attendance:admin', 'attendance:read'],
          member_count: 3,
        },
      ],
    })

    const response = await invokeRoute('get', '/api/admin/roles')

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      id: 'attendance_admin',
      name: 'Attendance Admin',
      memberCount: 3,
      permissions: ['attendance:admin', 'attendance:read'],
    })
  })

  it('lists access presets for admin user provisioning', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('get', '/api/admin/access-presets')

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.items.some((item: Record<string, unknown>) => item.id === 'attendance-employee')).toBe(true)
  })

  it('filters access presets by product mode', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('get', '/api/admin/access-presets', {
      query: { mode: 'attendance' },
    })

    expect(response.statusCode).toBe(200)
    const items = (response.body as Record<string, any>).data.items as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.productMode === 'attendance')).toBe(true)
  })

  it('updates user active status', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:01:00.000Z',
          updated_at: '2026-03-12T00:01:00.000Z',
          updated_by: 'admin-1',
          reason: 'user-disabled',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: false,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }],
      })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/status', {
      params: { userId: 'user-1' },
      body: { isActive: false },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user.is_active).toBe(false)
    expect(auditMocks.auditLog).toHaveBeenCalled()
  })

  it('creates a user with preset-driven onboarding metadata', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    bcryptMocks.hash.mockResolvedValue('hashed-initial-password')
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'attendance_employee' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-new',
          email: 'new@example.com',
          name: 'New User',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-new',
          email: 'new@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-token-fixed',
          status: 'pending',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'new@example.com',
        name: 'New User',
        password: 'WelcomePass9A',
        presetId: 'attendance-employee',
        isActive: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user.email).toBe('new@example.com')
    expect((response.body as Record<string, any>).data.roles).toEqual(['attendance_employee'])
    expect((response.body as Record<string, any>).data.onboarding.productMode).toBe('attendance')
    expect((response.body as Record<string, any>).data.inviteToken).toBe('invite-token-fixed')
    expect(String((response.body as Record<string, any>).data.onboarding.acceptInviteUrl)).toContain('invite-token-fixed')
    expect(String((response.body as Record<string, any>).data.onboarding.inviteMessage)).toContain('推荐入口：/attendance')
    expect(bcryptMocks.hash).toHaveBeenCalledWith('WelcomePass9A', 10)
    expect(auditMocks.auditLog).toHaveBeenCalled()
  })

  it('can authorize DingTalk login for a managed user', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    externalAuthGrantMocks.upsertUserExternalAuthGrant.mockResolvedValue({
      id: 'grant-1',
      provider: 'dingtalk',
      userId: 'user-1',
      enabled: true,
      grantedBy: 'admin-1',
      createdAt: '2026-03-12T00:00:00.000Z',
      updatedAt: '2026-03-12T00:05:00.000Z',
    })
    externalAuthGrantMocks.isUserExternalAuthEnabled.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/dingtalk-auth', {
      params: { userId: 'user-1' },
      body: { enabled: true },
    })

    expect(response.statusCode).toBe(200)
    expect(externalAuthGrantMocks.upsertUserExternalAuthGrant).toHaveBeenCalledWith({
      provider: 'dingtalk',
      userId: 'user-1',
      enabled: true,
      grantedBy: 'admin-1',
    })
    expect((response.body as Record<string, any>).data.dingtalkAuthEnabled).toBe(true)
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'user-external-auth',
      resourceId: 'user-1:dingtalk',
    }))
  })

  it('rejects create user requests when password policy fails', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('post', '/api/admin/users', {
      body: {
        email: 'weak@example.com',
        name: 'Weak Password User',
        password: 'weak',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error.code).toBe('PASSWORD_POLICY_FAILED')
  })

  it('resets password and returns temporary password', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    bcryptMocks.hash.mockResolvedValue('hashed-temp-password')
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:02:00.000Z',
          updated_at: '2026-03-12T00:02:00.000Z',
          updated_by: 'admin-1',
          reason: 'password-reset',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/:userId/reset-password', {
      params: { userId: 'user-1' },
      body: { password: 'TempPass9A' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.temporaryPassword).toBe('TempPass9A')
    expect(bcryptMocks.hash).toHaveBeenCalledWith('TempPass9A', 10)
    expect(auditMocks.auditLog).toHaveBeenCalled()
  })

  it('revokes all sessions for a user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:03:00.000Z',
          updated_at: '2026-03-12T00:03:00.000Z',
          updated_by: 'admin-1',
          reason: 'admin-force-logout',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/revoke-sessions', {
      params: { userId: 'user-1' },
      body: { reason: 'admin-force-logout' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.userId).toBe('user-1')
    expect((response.body as Record<string, any>).data.reason).toBe('admin-force-logout')
    expect((response.body as Record<string, any>).data.revokedAfter).toBe('2026-03-12T00:03:00.000Z')
    expect(auditMocks.auditLog).toHaveBeenCalled()
  })

  it('defaults session revoke reason when not provided', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'beta@example.com',
          name: 'Beta',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:04:00.000Z',
          updated_at: '2026-03-12T00:04:00.000Z',
          updated_by: 'admin-1',
          reason: 'admin-force-logout',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/revoke-sessions', {
      params: { userId: 'user-2' },
      body: {},
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.userId).toBe('user-2')
    expect((response.body as Record<string, any>).data.reason).toBe('admin-force-logout')
    expect((response.body as Record<string, any>).data.revokedAfter).toBe('2026-03-12T00:04:00.000Z')
  })

  it('trims and truncates session revoke reason for all sessions', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'beta@example.com',
          name: 'Beta',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:07:00.000Z',
          updated_at: '2026-03-12T00:07:00.000Z',
          updated_by: 'admin-1',
          reason: 'x'.repeat(255),
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/revoke-sessions', {
      params: { userId: 'user-2' },
      body: { reason: `   ${'x'.repeat(255)}extra-extra-extra   ` },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.reason).toHaveLength(255)
    expect((response.body as Record<string, any>).data.reason).toBe('x'.repeat(255))
  })

  it('defaults reason when all-session revoke reason is blank', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'beta@example.com',
          name: 'Beta',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:08:00.000Z',
          updated_at: '2026-03-12T00:08:00.000Z',
          updated_by: 'admin-1',
          reason: 'admin-force-logout',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/revoke-sessions', {
      params: { userId: 'user-2' },
      body: { reason: '   ' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.reason).toBe('admin-force-logout')
  })

  it('returns bad request when all-session revoke missing user id', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const response = await invokeRoute('post', '/api/admin/users/:userId/revoke-sessions', {
      params: {},
      body: {},
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('USER_ID_REQUIRED')
  })

  it('trims user id before revoking all sessions', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'beta@example.com',
          name: 'Beta',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          revoked_after: '2026-03-12T00:09:00.000Z',
          updated_at: '2026-03-12T00:09:00.000Z',
          updated_by: 'admin-1',
          reason: 'admin-force-logout',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/revoke-sessions', {
      params: { userId: '  user-2  ' },
      body: { reason: 'admin-force-logout' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM users'),
      ['user-2'],
    )
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO user_session_revocations'),
      ['user-2', 'admin-1', 'admin-force-logout'],
    )
  })

  it('returns null revokedAfter when no sessions were revoked', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'beta@example.com',
          name: 'Beta',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/:userId/revoke-sessions', {
      params: { userId: 'user-2' },
      body: { reason: 'maintenance' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.userId).toBe('user-2')
    expect((response.body as Record<string, any>).data.reason).toBe('maintenance')
    expect((response.body as Record<string, any>).data.revokedAfter).toBeNull()
  })

  it('returns server error when all-session revoke operation fails', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'beta@example.com',
          name: 'Beta',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockRejectedValueOnce(new Error('revocation store error'))

    const response = await invokeRoute('post', '/api/admin/users/:userId/revoke-sessions', {
      params: { userId: 'user-2' },
      body: { reason: 'maintenance' },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('SESSION_REVOKE_FAILED')
  })

  it('lists single sessions for a user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-1',
          user_id: 'user-1',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/users/:userId/sessions', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      id: 'sess-1',
      userId: 'user-1',
      ipAddress: '127.0.0.1',
    })
  })

  it('returns 404 when listing sessions for missing user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/users/:userId/sessions', {
      params: { userId: 'missing-user' },
    })

    expect(response.statusCode).toBe(404)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('NOT_FOUND')
  })

  it('returns empty session list for user without active sessions', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-empty',
          email: 'empty@example.com',
          name: 'Empty User',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/users/:userId/sessions', {
      params: { userId: 'user-empty' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.userId).toBe('user-empty')
    expect((response.body as Record<string, any>).data.items).toEqual([])
  })

  it('returns bad request when listing sessions without user id', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const response = await invokeRoute('get', '/api/admin/users/:userId/sessions', {
      params: {},
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('USER_ID_REQUIRED')
  })

  it('trims user id when listing sessions', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/users/:userId/sessions', {
      params: { userId: '  user-1 ' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM users'),
      ['user-1'],
    )
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM user_sessions'),
      ['user-1'],
    )
  })

  it('returns server error when listing user sessions fails', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockRejectedValueOnce(new Error('session lookup failed'))

    const response = await invokeRoute('get', '/api/admin/users/:userId/sessions', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('SESSION_LIST_FAILED')
  })

  it('revokes a single session with default reason', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-3',
          email: 'gamma@example.com',
          name: 'Gamma',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-3',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-3',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: '2026-03-12T08:45:00.000Z',
          revoked_by: 'admin-1',
          revoke_reason: 'admin-force-single-session-logout',
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:45:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'user-3', sessionId: 'sess-3' },
      body: {},
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.userId).toBe('user-3')
    expect((response.body as Record<string, any>).data.sessionId).toBe('sess-3')
    expect((response.body as Record<string, any>).data.reason).toBe('admin-force-single-session-logout')
    expect((response.body as Record<string, any>).data.revokedAt).toBe('2026-03-12T08:45:00.000Z')
  })

  it('trims and truncates session revoke reason for single session', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-3',
          email: 'gamma@example.com',
          name: 'Gamma',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-4',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-4',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: '2026-03-12T08:50:00.000Z',
          revoked_by: 'admin-1',
          revoke_reason: 'x'.repeat(255),
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:50:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'user-3', sessionId: 'sess-4' },
      body: { reason: `   ${'x'.repeat(255)}extra-extra-extra   ` },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.sessionId).toBe('sess-4')
    expect((response.body as Record<string, any>).data.reason).toHaveLength(255)
    expect((response.body as Record<string, any>).data.reason).toBe('x'.repeat(255))
    expect((response.body as Record<string, any>).data.revokedAt).toBe('2026-03-12T08:50:00.000Z')
  })

  it('returns bad request when single-session revoke missing ids', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'user-1' },
      body: {},
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('SESSION_ID_REQUIRED')
  })

  it('returns bad request when single-session revoke missing user id', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { sessionId: 'sess-1' },
      body: { reason: 'check' },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('USER_ID_REQUIRED')
  })

  it('defaults reason when single-session revoke reason is not a string', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-3',
          email: 'gamma@example.com',
          name: 'Gamma',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-5',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-5',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: '2026-03-12T08:55:00.000Z',
          revoked_by: 'admin-1',
          revoke_reason: 'admin-force-single-session-logout',
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:55:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'user-3', sessionId: 'sess-5' },
      body: { reason: 999 },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.reason).toBe('admin-force-single-session-logout')
    expect((response.body as Record<string, any>).data.sessionId).toBe('sess-5')
  })

  it('returns 404 when session disappears before revoke operation', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-3',
          email: 'gamma@example.com',
          name: 'Gamma',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-stale',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'user-3', sessionId: 'sess-stale' },
      body: { reason: 'admin-force-single-session-logout' },
    })

    expect(response.statusCode).toBe(404)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('NOT_FOUND')
  })

  it('trims identifiers before revoking a single session', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-3',
          email: 'gamma@example.com',
          name: 'Gamma',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-3',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-3',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-12T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: '2026-03-12T08:30:00.000Z',
          revoked_by: 'admin-1',
          revoke_reason: 'admin-force-single-session-logout',
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:30:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: '  user-3  ', sessionId: '  sess-3  ' },
      body: { reason: 'admin-force-single-session-logout' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.sessionId).toBe('sess-3')
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM users'),
      ['user-3'],
    )
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM user_sessions'),
      ['sess-3'],
    )
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE user_sessions'),
      ['sess-3', 'admin-1', 'admin-force-single-session-logout'],
    )
  })

  it('returns server error when single-session revoke operation fails', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-3',
          email: 'gamma@example.com',
          name: 'Gamma',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-3',
          user_id: 'user-3',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })
      .mockRejectedValueOnce(new Error('session revoke failed'))

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'user-3', sessionId: 'sess-3' },
      body: { reason: 'admin-force-single-session-logout' },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('SESSION_REVOKE_FAILED')
  })

  it('returns 404 when session user does not exist', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'missing-user', sessionId: 'sess-3' },
      body: { reason: 'manual-check' },
    })

    expect(response.statusCode).toBe(404)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('NOT_FOUND')
  })

  it('returns 404 when session belongs to another user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-other',
          user_id: 'user-2',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'user-1', sessionId: 'sess-other' },
      body: { reason: 'manual-match-check' },
    })

    expect(response.statusCode).toBe(404)
    expect((response.body as Record<string, any>).ok).toBe(false)
    expect((response.body as Record<string, any>).error.code).toBe('NOT_FOUND')
  })

  it('revokes a single session for a user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-1',
          user_id: 'user-1',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'sess-1',
          user_id: 'user-1',
          issued_at: '2026-03-12T00:00:00.000Z',
          expires_at: '2026-03-13T00:00:00.000Z',
          last_seen_at: '2026-03-12T08:00:00.000Z',
          revoked_at: '2026-03-12T08:30:00.000Z',
          revoked_by: 'admin-1',
          revoke_reason: 'admin-force-single-session-logout',
          ip_address: '127.0.0.1',
          user_agent: 'Vitest',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T08:30:00.000Z',
        }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/sessions/:sessionId/revoke', {
      params: { userId: 'user-1', sessionId: 'sess-1' },
      body: { reason: 'admin-force-single-session-logout' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).ok).toBe(true)
    expect((response.body as Record<string, any>).data.sessionId).toBe('sess-1')
    expect((response.body as Record<string, any>).data.revokedAt).toBe('2026-03-12T08:30:00.000Z')
    expect((response.body as Record<string, any>).data.reason).toBe('admin-force-single-session-logout')
    expect(auditMocks.auditLog).toHaveBeenCalled()
  })

  it('lists admin audit activity for IAM resources', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 2 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          created_at: '2026-03-12T00:04:00.000Z',
          event_type: 'CREATE',
          event_category: 'SYSTEM',
          event_severity: 'INFO',
          action: 'create',
          resource_type: 'user',
          resource_id: 'user-1',
          user_id: null,
          user_name: null,
          user_email: null,
          action_details: { email: 'alpha@example.com', adminUserId: 'admin-1' },
          error_code: null,
        }],
      })

    const response = await invokeRoute('get', '/api/admin/audit-activity', {
      query: { q: 'alpha', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.total).toBe(2)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      resource_type: 'user',
      action: 'create',
    })
  })

  it('lists invite ledger records', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-token-fixed',
          status: 'pending',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          user_name: 'Alpha',
          invited_by_email: 'admin@example.com',
          invited_by_name: 'Admin',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/invites', {
      query: { userId: 'user-1', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.total).toBe(1)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      user_id: 'user-1',
      email: 'alpha@example.com',
      product_mode: 'attendance',
      status: 'pending',
    })
  })

  it('marks expired invite tokens as expired in invite ledger responses', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-expired',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiaW52aXRlIiwiZXhwIjoxfQ.sig',
          status: 'pending',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          user_name: 'Alpha',
          invited_by_email: 'admin@example.com',
          invited_by_name: 'Admin',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/invites')

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      id: 'invite-expired',
      status: 'expired',
    })
  })

  it('resends invite and returns refreshed onboarding metadata', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-token-old',
          status: 'revoked',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:10:00.000Z',
          user_name: 'Alpha',
          invited_by_email: 'admin@example.com',
          invited_by_name: 'Admin',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-token-fixed',
          status: 'pending',
          accepted_at: null,
          consumed_by: null,
          last_sent_at: '2026-03-12T00:20:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:20:00.000Z',
          user_name: null,
          invited_by_email: null,
          invited_by_name: null,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/invites/:inviteId/resend', {
      params: { inviteId: 'invite-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'invite-1',
      status: 'pending',
      invite_token: 'invite-token-fixed',
    })
    expect((response.body as Record<string, any>).data.inviteToken).toBe('invite-token-fixed')
    expect(String((response.body as Record<string, any>).data.onboarding.acceptInviteUrl)).toContain('invite-token-fixed')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update',
      resourceType: 'user-invite',
      resourceId: 'invite-1',
    }))
  })

  it('revokes a pending invite and writes an audit entry', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'invite-1',
        user_id: 'user-1',
        email: 'alpha@example.com',
        preset_id: 'attendance-employee',
        product_mode: 'attendance',
        role_id: 'attendance_employee',
        invited_by: 'admin-1',
        invite_token: 'invite-token-fixed',
        status: 'revoked',
        accepted_at: null,
        consumed_by: null,
        last_sent_at: '2026-03-12T00:00:00.000Z',
        created_at: '2026-03-12T00:00:00.000Z',
        updated_at: '2026-03-12T00:10:00.000Z',
        user_name: null,
        invited_by_email: null,
        invited_by_name: null,
      }],
    })

    const response = await invokeRoute('post', '/api/admin/invites/:inviteId/revoke', {
      params: { inviteId: 'invite-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'invite-1',
      status: 'revoked',
      email: 'alpha@example.com',
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-invite',
      resourceId: 'invite-1',
    }))
  })

  it('exports admin audit activity as csv', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 1,
        created_at: '2026-03-12T00:04:00.000Z',
        event_type: 'CREATE',
        event_category: 'SYSTEM',
        event_severity: 'INFO',
        action: 'create',
        resource_type: 'user',
        resource_id: 'user-1',
        user_id: null,
        user_name: 'Alpha',
        user_email: 'alpha@example.com',
        action_details: { adminUserId: 'admin-1' },
        error_code: null,
      }],
    })

    const response = await invokeRoute('get', '/api/admin/audit-activity/export.csv', {
      query: { q: 'alpha', resourceType: 'user', action: 'create', limit: '10' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.textBody).toContain('id,created_at,resource_type,resource_id,action')
    expect(response.textBody).toContain('alpha@example.com')
  })

  it('applies date filters to admin audit activity queries', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 0 }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/audit-activity', {
      query: { from: '2026-03-10', to: '2026-03-12', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('created_at >=')
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('created_at <=')
    expect(pgMocks.query.mock.calls[0]?.[1]?.slice(0, 3)).toEqual([
      ['user', 'user-role', 'user-password', 'user-session', 'user-invite', 'user-external-auth', 'role', 'permission', 'permission-template'],
      '2026-03-10T00:00:00.000Z',
      '2026-03-12T23:59:59.999Z',
    ])
  })

  it('lists forced session revocation history', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          user_id: 'user-1',
          revoked_after: '2026-03-12T00:03:00.000Z',
          updated_at: '2026-03-12T00:03:00.000Z',
          updated_by: 'admin-1',
          reason: 'admin-force-logout',
          user_email: 'alpha@example.com',
          user_name: 'Alpha',
          updated_by_email: 'admin@example.com',
          updated_by_name: 'Admin',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/session-revocations', {
      query: { q: 'alpha', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.items[0]).toMatchObject({
      user_id: 'user-1',
      reason: 'admin-force-logout',
      user_email: 'alpha@example.com',
      updated_by_email: 'admin@example.com',
    })
  })

  it('applies date filters to session revocation queries', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ c: 0 }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/session-revocations', {
      query: { from: '2026-03-10', to: '2026-03-12', page: '1', pageSize: '20' },
    })

    expect(response.statusCode).toBe(200)
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('usr.updated_at >=')
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('usr.updated_at <=')
    expect(pgMocks.query.mock.calls[0]?.[1]?.slice(0, 2)).toEqual([
      '2026-03-10T00:00:00.000Z',
      '2026-03-12T23:59:59.999Z',
    ])
  })
})
