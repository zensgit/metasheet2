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

const namespaceAdmissionMocks = vi.hoisted(() => ({
  deriveDelegatedAdminNamespace: vi.fn(),
  disableNamespaceAdmissionsWithoutRoles: vi.fn(),
  isNamespaceAdmissionControlledResource: vi.fn(),
  listRoleNamespaces: vi.fn(),
  listUserNamespaceAdmissionSnapshots: vi.fn(),
  normalizeNamespace: vi.fn(),
  roleIdMatchesNamespaces: vi.fn(),
  setUserNamespaceAdmission: vi.fn(),
}))

const inviteMocks = vi.hoisted(() => ({
  issueInviteToken: vi.fn(() => 'invite-token-fixed'),
  isInviteTokenExpired: vi.fn((token: string) => token === 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiaW52aXRlIiwiZXhwIjoxfQ.sig'),
}))

const dingtalkOauthMocks = vi.hoisted(() => ({
  getDingTalkRuntimeStatus: vi.fn(),
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

vi.mock('../../src/rbac/namespace-admission', () => ({
  deriveDelegatedAdminNamespace: namespaceAdmissionMocks.deriveDelegatedAdminNamespace,
  disableNamespaceAdmissionsWithoutRoles: namespaceAdmissionMocks.disableNamespaceAdmissionsWithoutRoles,
  isNamespaceAdmissionControlledResource: namespaceAdmissionMocks.isNamespaceAdmissionControlledResource,
  listRoleNamespaces: namespaceAdmissionMocks.listRoleNamespaces,
  listUserNamespaceAdmissionSnapshots: namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots,
  normalizeNamespace: namespaceAdmissionMocks.normalizeNamespace,
  roleIdMatchesNamespaces: namespaceAdmissionMocks.roleIdMatchesNamespaces,
  setUserNamespaceAdmission: namespaceAdmissionMocks.setUserNamespaceAdmission,
}))

vi.mock('../../src/auth/invite-tokens', () => ({
  issueInviteToken: inviteMocks.issueInviteToken,
  isInviteTokenExpired: inviteMocks.isInviteTokenExpired,
}))

vi.mock('../../src/auth/dingtalk-oauth', () => ({
  getDingTalkRuntimeStatus: dingtalkOauthMocks.getDingTalkRuntimeStatus,
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
    vi.unstubAllEnvs()
    state.authUser = {
      id: 'admin-1',
      role: 'user',
    }
    pgMocks.query.mockReset()
    pgMocks.query.mockResolvedValue({ rows: [] })
    rbacMocks.isAdmin.mockReset()
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.listUserPermissions.mockResolvedValue([])
    rbacMocks.invalidateUserPerms.mockReset()
    bcryptMocks.hash.mockReset()
    auditMocks.auditLog.mockReset()
    namespaceAdmissionMocks.deriveDelegatedAdminNamespace.mockReset()
    namespaceAdmissionMocks.deriveDelegatedAdminNamespace.mockImplementation((roleId: string) => (
      typeof roleId === 'string' && roleId.endsWith('_admin') && roleId !== 'admin'
        ? roleId.slice(0, -'_admin'.length)
        : null
    ))
    namespaceAdmissionMocks.disableNamespaceAdmissionsWithoutRoles.mockReset()
    namespaceAdmissionMocks.disableNamespaceAdmissionsWithoutRoles.mockResolvedValue([])
    namespaceAdmissionMocks.isNamespaceAdmissionControlledResource.mockReset()
    namespaceAdmissionMocks.isNamespaceAdmissionControlledResource.mockImplementation((namespace: string) => Boolean(namespace))
    namespaceAdmissionMocks.listRoleNamespaces.mockReset()
    namespaceAdmissionMocks.listRoleNamespaces.mockResolvedValue([])
    namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots.mockReset()
    namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots.mockResolvedValue([])
    namespaceAdmissionMocks.normalizeNamespace.mockReset()
    namespaceAdmissionMocks.normalizeNamespace.mockImplementation((value: unknown) => String(value ?? '').trim())
    namespaceAdmissionMocks.roleIdMatchesNamespaces.mockReset()
    namespaceAdmissionMocks.roleIdMatchesNamespaces.mockImplementation((roleId: string, namespaces: string[]) => (
      Array.isArray(namespaces) && namespaces.some((namespace) => roleId === namespace || roleId.startsWith(`${namespace}_`))
    ))
    namespaceAdmissionMocks.setUserNamespaceAdmission.mockReset()
    namespaceAdmissionMocks.setUserNamespaceAdmission.mockResolvedValue([])
    inviteMocks.issueInviteToken.mockClear()
    inviteMocks.isInviteTokenExpired.mockClear()
    inviteMocks.isInviteTokenExpired.mockImplementation((token: string) => token === 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiaW52aXRlIiwiZXhwIjoxfQ.sig')
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReset()
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue({
      configured: true,
      available: true,
      corpId: 'ding-corp',
      allowedCorpIds: [],
      requireGrant: false,
      autoLinkEmail: true,
      autoProvision: false,
      unavailableReason: null,
    })
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

  it('returns dingtalk access details for a user', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '0')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '0')
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue({
      configured: true,
      available: true,
      corpId: 'ding-corp',
      allowedCorpIds: ['ding-corp'],
      requireGrant: true,
      autoLinkEmail: false,
      autoProvision: false,
      unavailableReason: null,
    })
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
          enabled: true,
          granted_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          corp_id: 'ding-corp',
          last_login_at: '2026-03-13T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          linked_count: 2,
        }],
      })

    const response = await invokeRoute('get', '/api/admin/users/:userId/dingtalk-access', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      userId: 'user-1',
      requireGrant: true,
      autoLinkEmail: false,
      autoProvision: false,
      server: {
        configured: true,
        available: true,
        corpId: 'ding-corp',
        requireGrant: true,
        autoLinkEmail: false,
        autoProvision: false,
        unavailableReason: null,
      },
      directory: {
        linked: true,
        linkedCount: 2,
      },
      grant: { exists: true, enabled: true },
      identity: { exists: true, corpId: 'ding-corp' },
    })
  })

  it('returns member admission snapshot for a user', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_LINK_EMAIL', '1')
    vi.stubEnv('DINGTALK_AUTH_AUTO_PROVISION', '0')
    rbacMocks.isAdmin.mockResolvedValue(true)
    namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: true,
        effective: true,
        hasRole: true,
        source: 'seed_backfill',
        grantedBy: null,
        updatedBy: null,
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:00:00.000Z',
      },
    ])
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
        rows: [{ role_id: 'attendance_employee' }, { role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          directory_account_id: 'account-1',
          external_user_id: 'ding-user-1',
          account_name: 'Alpha',
          account_email: 'alpha@example.com',
          account_mobile: '13800000000',
          account_is_active: true,
          account_updated_at: '2026-03-13T00:00:00.000Z',
          link_status: 'linked',
          match_strategy: 'external_identity',
          reviewed_by: null,
          review_note: null,
          link_updated_at: '2026-03-13T00:00:00.000Z',
          department_paths: ['总部 / 研发部'],
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          enabled: true,
          granted_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          corp_id: 'ding-corp',
          last_login_at: '2026-03-13T00:00:00.000Z',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/users/:userId/member-admission', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      userId: 'user-1',
      accountEnabled: true,
      platformAdminEnabled: false,
      attendanceAdminEnabled: false,
      businessRoleIds: ['crm_admin'],
      directoryMemberships: [
        expect.objectContaining({
          integrationId: 'integration-1',
          integrationName: 'DingTalk CN',
          linkStatus: 'linked',
          matchStrategy: 'external_identity',
          departmentPaths: ['总部 / 研发部'],
        }),
      ],
      dingtalk: {
        grant: { exists: true, enabled: true },
        identity: { exists: true, corpId: 'ding-corp' },
      },
      namespaceAdmissions: [
        expect.objectContaining({
          namespace: 'crm',
          enabled: true,
          effective: true,
          hasRole: true,
        }),
      ],
    })
  })

  it('returns delegated role summary for a plugin admin', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }, { role_id: 'attendance_employee' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'crm_admin',
          name: 'CRM Admin',
          permissions: ['crm:read', 'crm:write', 'crm:admin'],
        }, {
          id: 'crm_operator',
          name: 'CRM Operator',
          permissions: ['crm:read', 'crm:write'],
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('get', '/api/admin/role-delegation/summary')

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      isPlatformAdmin: false,
      delegableNamespaces: ['crm'],
      roleCatalog: [
        { id: 'crm_admin' },
        { id: 'crm_operator' },
      ],
      scopeAssignments: [
        expect.objectContaining({
          namespace: 'crm',
          departmentFullPath: '总部 / 研发部',
        }),
      ],
    })
  })

  it('filters delegated access member groups to the actor-visible delegated groups', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    namespaceAdmissionMocks.listUserNamespaceAdmissionSnapshots.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: true,
        effective: true,
        hasRole: true,
        source: 'platform_admin',
        grantedBy: 'admin-1',
        updatedBy: 'admin-1',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:00:00.000Z',
      },
    ])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          group_id: 'group-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          group_name: 'CRM 经理层',
          group_description: 'CRM 可见组',
          member_count: 2,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
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
          id: 'group-1',
          name: 'CRM 经理层',
          description: 'CRM 可见组',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          member_count: 2,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_operator' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'crm_admin',
          name: 'CRM Admin',
          permissions: ['crm:read', 'crm:write', 'crm:admin'],
        }, {
          id: 'crm_operator',
          name: 'CRM Operator',
          permissions: ['crm:read', 'crm:write'],
        }],
      })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users/:userId/access', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.memberGroups).toEqual([
      expect.objectContaining({
        id: 'group-1',
        name: 'CRM 经理层',
      }),
    ])
    expect((response.body as Record<string, any>).data.namespaceAdmissions).toEqual([
      expect.objectContaining({
        namespace: 'crm',
        enabled: true,
      }),
    ])
  })

  it('updates platform namespace admission and writes audit log', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    namespaceAdmissionMocks.setUserNamespaceAdmission.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: true,
        effective: true,
        hasRole: true,
        source: 'platform_admin',
        grantedBy: 'admin-1',
        updatedBy: 'admin-1',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:05:00.000Z',
      },
    ])
    pgMocks.query.mockResolvedValueOnce({
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

    const response = await invokeRoute('patch', '/api/admin/users/:userId/namespaces/:namespace/admission', {
      params: { userId: 'user-1', namespace: 'crm' },
      body: { enabled: true },
    })

    expect(response.statusCode).toBe(200)
    expect(namespaceAdmissionMocks.setUserNamespaceAdmission).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      namespace: 'crm',
      enabled: true,
      actorId: 'admin-1',
      source: 'platform_admin',
    }))
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'grant',
      resourceType: 'user-namespace-admission',
      resourceId: 'user-1:crm',
    }))
  })

  it('updates namespace admission in bulk and records an audit entry per user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    namespaceAdmissionMocks.setUserNamespaceAdmission.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: false,
        effective: false,
        hasRole: true,
        source: 'platform_admin',
        grantedBy: null,
        updatedBy: 'admin-1',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:05:00.000Z',
      },
    ])
    pgMocks.query.mockResolvedValueOnce({
      rows: [
        { id: 'user-1' },
        { id: 'user-2' },
      ],
    })

    const response = await invokeRoute('post', '/api/admin/users/namespaces/:namespace/admission/bulk', {
      params: { namespace: 'crm' },
      body: {
        userIds: ['user-1', 'user-2', 'user-1'],
        enabled: false,
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      namespace: 'crm',
      enabled: false,
      updatedCount: 2,
      userIds: ['user-1', 'user-2'],
    })
    expect(namespaceAdmissionMocks.setUserNamespaceAdmission).toHaveBeenCalledTimes(2)
    expect(namespaceAdmissionMocks.setUserNamespaceAdmission).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userId: 'user-1',
      namespace: 'crm',
      enabled: false,
      actorId: 'admin-1',
      source: 'platform_admin',
    }))
    expect(namespaceAdmissionMocks.setUserNamespaceAdmission).toHaveBeenNthCalledWith(2, expect.objectContaining({
      userId: 'user-2',
      namespace: 'crm',
      enabled: false,
      actorId: 'admin-1',
      source: 'platform_admin',
    }))
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-2')
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(2)
    expect(auditMocks.auditLog).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-namespace-admission',
      resourceId: 'user-1:crm',
      meta: expect.objectContaining({
        mode: 'bulk',
        selectionSize: 2,
      }),
    }))
    expect(auditMocks.auditLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-namespace-admission',
      resourceId: 'user-2:crm',
      meta: expect.objectContaining({
        mode: 'bulk',
        selectionSize: 2,
      }),
    }))
  })

  it('updates delegated namespace admission within visible scope', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    namespaceAdmissionMocks.setUserNamespaceAdmission.mockResolvedValue([
      {
        namespace: 'crm',
        enabled: true,
        effective: true,
        hasRole: true,
        source: 'delegated_admin',
        grantedBy: 'crm-admin-1',
        updatedBy: 'crm-admin-1',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:05:00.000Z',
      },
    ])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
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
        rows: [{
          id: 'scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })

    const response = await invokeRoute('patch', '/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission', {
      params: { userId: 'user-1', namespace: 'crm' },
      body: { enabled: true },
    })

    expect(response.statusCode).toBe(200)
    expect(namespaceAdmissionMocks.setUserNamespaceAdmission).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      namespace: 'crm',
      enabled: true,
      actorId: 'crm-admin-1',
      source: 'delegated_admin',
    }))
  })

  it('rejects delegated role assignment outside allowed namespaces', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
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
      .mockResolvedValueOnce({ rows: [{ id: 'qa_admin' }] })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'qa_admin' },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_DELEGATION_FORBIDDEN')
  })

  it('rejects delegated role assignment when the user is outside the namespace-specific department scope', async () => {
    state.authUser = {
      id: 'plugin-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }, { role_id: 'qa_admin' }],
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
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-qa-1',
          admin_user_id: 'plugin-admin-1',
          namespace: 'qa',
          directory_department_id: 'dept-9',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1099',
          department_name: '质控部',
          department_full_path: '总部 / 质控部',
          department_is_active: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: false }] })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'crm_operator' },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_DELEGATION_USER_OUT_OF_SCOPE')
  })

  it('assigns delegated role within allowed namespaces', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['crm:read', 'crm:write'])
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
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
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
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
        rows: [{ role_id: 'crm_operator' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'crm_admin',
          name: 'CRM Admin',
          permissions: ['crm:read', 'crm:write', 'crm:admin'],
        }, {
          id: 'crm_operator',
          name: 'CRM Operator',
          permissions: ['crm:read', 'crm:write'],
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'crm_operator' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      isPlatformAdmin: false,
      delegableNamespaces: ['crm'],
      scopeAssignments: [
        expect.objectContaining({
          namespace: 'crm',
          departmentFullPath: '总部 / 研发部',
        }),
      ],
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'user-1:crm_operator',
      meta: expect.objectContaining({
        delegated: true,
        delegableNamespaces: ['crm'],
      }),
    }))
  })

  it('assigns delegated role when the target user is inside a delegated member group scope', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
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
      .mockResolvedValueOnce({ rows: [{ id: 'crm_operator' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-scope-1',
          admin_user_id: 'crm-admin-1',
          namespace: 'crm',
          group_id: 'group-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          group_name: '制造中心',
          group_description: '制造中心成员集',
          member_count: 3,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
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
        rows: [{ role_id: 'crm_operator' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-1',
          name: '制造中心',
          description: '制造中心成员集',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          member_count: 3,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'crm_admin',
          name: 'CRM Admin',
          permissions: ['crm:read', 'crm:write', 'crm:admin'],
        }, {
          id: 'crm_operator',
          name: 'CRM Operator',
          permissions: ['crm:read', 'crm:write'],
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { roleId: 'crm_operator' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('blocks delegated role access when no department scope is configured', async () => {
    state.authUser = {
      id: 'crm-admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users/:userId/access', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_DELEGATION_SCOPE_REQUIRED')
  })

  it('lists delegated admin scopes for a selected user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }, { role_id: 'crm_operator' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('get', '/api/admin/role-delegation/users/:userId/scopes', {
      params: { userId: 'user-2' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      adminNamespaces: ['crm'],
      scopeAssignments: [
        expect.objectContaining({
          namespace: 'crm',
          directoryDepartmentId: 'dept-1',
        }),
      ],
    })
  })

  it('assigns a delegated admin department scope', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'dept-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '研发部',
          department_full_path: '总部 / 研发部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', directoryDepartmentId: 'dept-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      adminNamespaces: ['crm'],
      scopeAssignments: [
        expect.objectContaining({
          namespace: 'crm',
          directoryDepartmentId: 'dept-1',
        }),
      ],
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'delegated-admin-scope',
      resourceId: 'user-2:crm:dept-1',
    }))
  })

  it('creates an organization scope template', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'template-1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'template-1',
          name: '华东销售',
          description: '华东销售线模板',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          department_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/role-delegation/scope-templates', {
      body: { name: '华东销售', description: '华东销售线模板' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'template-1',
      name: '华东销售',
      departmentCount: 0,
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'template:template-1',
    }))
  })

  it('returns 409 when creating a duplicate scope template name', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockRejectedValueOnce({
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_delegated_role_scope_templates_name"',
    })

    const response = await invokeRoute('post', '/api/admin/role-delegation/scope-templates', {
      body: { name: '华东销售', description: '华东销售线模板' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('ROLE_DELEGATION_SCOPE_TEMPLATE_NAME_CONFLICT')
  })

  it('creates a platform member group', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'group-1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-1',
          name: '制造中心',
          description: '制造中心成员集',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
          member_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/role-delegation/member-groups', {
      body: { name: '制造中心', description: '制造中心成员集' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'group-1',
      name: '制造中心',
      memberCount: 0,
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'platform-member-group',
      resourceId: 'group:group-1',
    }))
  })

  it('returns 409 when creating a duplicate platform member group name', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query.mockRejectedValueOnce({
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_platform_member_groups_name"',
    })

    const response = await invokeRoute('post', '/api/admin/role-delegation/member-groups', {
      body: { name: '制造中心', description: '制造中心成员集' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('PLATFORM_MEMBER_GROUP_NAME_CONFLICT')
  })

  it('assigns a user to a platform member group', async () => {
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
      .mockResolvedValueOnce({ rows: [{ id: 'group-1' }] })
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

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/member-groups/:action(assign|unassign)', {
      params: { userId: 'user-1', action: 'assign' },
      body: { groupId: 'group-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'platform-member-group',
      resourceId: 'group-1:user-1',
    }))
  })

  it('assigns a platform member group to a delegated admin namespace', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'group-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          group_id: 'group-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          group_name: '制造中心',
          group_description: '制造中心成员集',
          member_count: 3,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scope-groups/:action(assign|unassign)', {
      params: { userId: 'user-2', action: 'assign' },
      body: { namespace: 'crm', groupId: 'group-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.groupAssignments).toMatchObject([
      expect.objectContaining({
        namespace: 'crm',
        groupId: 'group-1',
        name: '制造中心',
      }),
    ])
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'delegated-admin-group-scope',
      resourceId: 'user-2:crm:group:group-1',
    }))
  })

  it('applies template member groups to a delegated admin namespace', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'template-1',
          name: '华东销售',
          description: '华东销售线模板',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          department_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          template_id: 'template-1',
          group_id: 'group-1',
          group_name: '华东销售经理',
          group_description: '固定经理层',
          member_count: 2,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'group-scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          group_id: 'group-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:10:00.000Z',
          group_name: '华东销售经理',
          group_description: '固定经理层',
          member_count: 2,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scope-templates/apply', {
      params: { userId: 'user-2' },
      body: { namespace: 'crm', templateId: 'template-1', mode: 'replace' },
    })

    expect(response.statusCode).toBe(200)
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'user-2:crm:template:template-1',
      meta: expect.objectContaining({
        memberGroupCount: 1,
      }),
    }))
  })

  it('adds a department to a scope template', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'template-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'dept-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'template-1',
          name: '华东销售',
          description: '华东销售线模板',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          department_count: 1,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          template_id: 'template-1',
          directory_department_id: 'dept-1',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '销售部',
          department_full_path: '总部 / 销售部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/scope-templates/:templateId/departments/:action(assign|unassign)', {
      params: { templateId: 'template-1', action: 'assign' },
      body: { directoryDepartmentId: 'dept-1' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.item).toMatchObject({
      id: 'template-1',
      departmentCount: 1,
      departments: [
        expect.objectContaining({
          directoryDepartmentId: 'dept-1',
          departmentFullPath: '总部 / 销售部',
        }),
      ],
    })
  })

  it('applies a scope template to a delegated admin namespace', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-2',
          email: 'plugin-admin@example.com',
          name: 'Plugin Admin',
          role: 'user',
          is_active: true,
          is_admin: false,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'crm_admin' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'template-1',
          name: '华东销售',
          description: '华东销售线模板',
          created_by: 'admin-1',
          updated_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
          department_count: 1,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          template_id: 'template-1',
          directory_department_id: 'dept-1',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '销售部',
          department_full_path: '总部 / 销售部',
          department_is_active: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'scope-1',
          admin_user_id: 'user-2',
          namespace: 'crm',
          directory_department_id: 'dept-1',
          created_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:10:00.000Z',
          integration_id: 'integration-1',
          integration_name: 'DingTalk CN',
          provider: 'dingtalk',
          corp_id: 'ding-corp',
          external_department_id: '1001',
          department_name: '销售部',
          department_full_path: '总部 / 销售部',
          department_is_active: true,
        }],
      })

    const response = await invokeRoute('post', '/api/admin/role-delegation/users/:userId/scope-templates/apply', {
      params: { userId: 'user-2' },
      body: { namespace: 'crm', templateId: 'template-1', mode: 'replace' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.adminNamespaces).toEqual(['crm'])
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'user-2:crm:template:template-1',
      meta: expect.objectContaining({
        templateId: 'template-1',
        mode: 'replace',
      }),
    }))
  })

  it('updates dingtalk grant and records an audit entry', async () => {
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
      .mockResolvedValueOnce({
        rows: [{
          enabled: true,
          granted_by: 'admin-1',
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('patch', '/api/admin/users/:userId/dingtalk-grant', {
      params: { userId: 'user-1' },
      body: { enabled: true },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.grant).toMatchObject({
      exists: true,
      enabled: true,
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'grant',
      resourceType: 'user-auth-grant',
      resourceId: 'user-1:dingtalk',
    }))
  })

  it('updates dingtalk grants in bulk and records an audit entry per user', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'user-1' },
          { id: 'user-2' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/api/admin/users/dingtalk-grants/bulk', {
      body: {
        userIds: ['user-1', 'user-2', 'user-1'],
        enabled: false,
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      enabled: false,
      updatedCount: 2,
      userIds: ['user-1', 'user-2'],
    })
    expect(String(pgMocks.query.mock.calls[1]?.[0] || '')).toContain('INSERT INTO user_external_auth_grants')
    expect(pgMocks.query.mock.calls[1]?.[1]).toEqual(['dingtalk', false, 'admin-1', ['user-1', 'user-2']])
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(2)
    expect(auditMocks.auditLog).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-auth-grant',
      resourceId: 'user-1:dingtalk',
      meta: expect.objectContaining({
        enabled: false,
        mode: 'bulk',
        selectionSize: 2,
      }),
    }))
    expect(auditMocks.auditLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'revoke',
      resourceType: 'user-auth-grant',
      resourceId: 'user-2:dingtalk',
      meta: expect.objectContaining({
        enabled: false,
        mode: 'bulk',
        selectionSize: 2,
      }),
    }))
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

  it('assigns platform admin and syncs legacy admin columns', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
    rbacMocks.listUserPermissions.mockResolvedValue(['admin:all'])
    pgMocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'admin' }] })
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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'admin',
          is_active: true,
          is_admin: true,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'admin' }, { role_id: 'attendance_employee' }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/assign', {
      params: { userId: 'user-1' },
      body: { roleId: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      role: 'admin',
      is_admin: true,
    })
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SET role = CASE'),
      ['user-1', true],
    )
  })

  it('unassigns a role and writes an audit entry', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read'])
    namespaceAdmissionMocks.listRoleNamespaces.mockResolvedValue(['attendance'])
    namespaceAdmissionMocks.disableNamespaceAdmissionsWithoutRoles.mockResolvedValue(['attendance'])
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
      meta: expect.objectContaining({
        disabledNamespaces: ['attendance'],
      }),
    }))
  })

  it('unassigns platform admin and clears legacy admin columns', async () => {
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
          role: 'admin',
          is_active: true,
          is_admin: true,
          last_login_at: null,
          created_at: '2026-03-12T00:00:00.000Z',
          updated_at: '2026-03-12T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
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
          updated_at: '2026-03-12T00:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ role_id: 'attendance_employee' }],
      })

    const response = await invokeRoute('post', '/api/admin/users/:userId/roles/unassign', {
      params: { userId: 'user-1' },
      body: { roleId: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      role: 'user',
      is_admin: false,
    })
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SET role = CASE'),
      ['user-1', false],
    )
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
    expect((response.body as Record<string, any>).data.userId).toBe('user-1')
    expect((response.body as Record<string, any>).data.reason).toBe('admin-force-logout')
    expect(auditMocks.auditLog).toHaveBeenCalled()
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
    expect((response.body as Record<string, any>).data.sessionId).toBe('sess-1')
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
      ['user', 'user-role', 'user-auth-grant', 'user-namespace-admission', 'user-password', 'user-session', 'user-invite', 'role', 'permission', 'permission-template', 'delegated-admin-scope', 'delegated-admin-scope-template', 'platform-member-group', 'delegated-admin-group-scope'],
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
