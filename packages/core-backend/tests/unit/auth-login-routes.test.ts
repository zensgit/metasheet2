import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authServiceMocks = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  refreshToken: vi.fn(),
  verifyToken: vi.fn(),
  createToken: vi.fn(),
  readTokenPayload: vi.fn(),
}))

const inviteTokenMocks = vi.hoisted(() => ({
  verifyInviteToken: vi.fn(),
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

const bcryptMocks = vi.hoisted(() => ({
  hash: vi.fn(),
  compare: vi.fn(),
}))

const sessionMocks = vi.hoisted(() => ({
  revokeUserSessions: vi.fn(),
}))

const sessionRegistryMocks = vi.hoisted(() => ({
  createUserSession: vi.fn(),
  listUserSessions: vi.fn(),
  getUserSession: vi.fn(),
  revokeUserSession: vi.fn(),
  touchUserSession: vi.fn(),
}))

const dingtalkOauthMocks = vi.hoisted(() => ({
  isDingTalkConfigured: vi.fn(),
  getDingTalkRuntimeStatus: vi.fn(),
  generateState: vi.fn(),
  buildAuthUrl: vi.fn(),
  validateState: vi.fn(),
  exchangeCodeForUser: vi.fn(),
  exchangeCodeForDingTalkProfile: vi.fn(),
  bindDingTalkIdentityToUser: vi.fn(),
  DingTalkLoginPolicyError: class DingTalkLoginPolicyError extends Error {
    statusCode: number
    code: string

    constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
      super(message)
      this.name = 'DingTalkLoginPolicyError'
      this.statusCode = options.statusCode ?? 403
      this.code = options.code ?? 'policy_denied'
    }
  },
}))

const dingtalkClientMocks = vi.hoisted(() => ({
  DingTalkRequestError: class DingTalkRequestError extends Error {
    statusCode: number
    responseBody: Record<string, unknown> | null

    constructor(message: string, statusCode = 502, responseBody: Record<string, unknown> | null = null) {
      super(message)
      this.name = 'DingTalkRequestError'
      this.statusCode = statusCode
      this.responseBody = responseBody
    }
  },
}))

const rbacMocks = vi.hoisted(() => ({
  listUserPermissions: vi.fn(),
}))

vi.mock('../../src/auth/AuthService', () => ({
  authService: authServiceMocks,
}))

vi.mock('../../src/auth/invite-tokens', () => ({
  verifyInviteToken: inviteTokenMocks.verifyInviteToken,
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
}))

vi.mock('bcryptjs', () => bcryptMocks)

vi.mock('../../src/auth/session-revocation', () => ({
  revokeUserSessions: sessionMocks.revokeUserSessions,
}))

vi.mock('../../src/auth/session-registry', () => ({
  createUserSession: sessionRegistryMocks.createUserSession,
  listUserSessions: sessionRegistryMocks.listUserSessions,
  getUserSession: sessionRegistryMocks.getUserSession,
  revokeUserSession: sessionRegistryMocks.revokeUserSession,
  touchUserSession: sessionRegistryMocks.touchUserSession,
}))

vi.mock('../../src/auth/dingtalk-oauth', () => ({
  isDingTalkConfigured: dingtalkOauthMocks.isDingTalkConfigured,
  getDingTalkRuntimeStatus: dingtalkOauthMocks.getDingTalkRuntimeStatus,
  generateState: dingtalkOauthMocks.generateState,
  buildAuthUrl: dingtalkOauthMocks.buildAuthUrl,
  validateState: dingtalkOauthMocks.validateState,
  exchangeCodeForUser: dingtalkOauthMocks.exchangeCodeForUser,
  exchangeCodeForDingTalkProfile: dingtalkOauthMocks.exchangeCodeForDingTalkProfile,
  bindDingTalkIdentityToUser: dingtalkOauthMocks.bindDingTalkIdentityToUser,
  DingTalkLoginPolicyError: dingtalkOauthMocks.DingTalkLoginPolicyError,
}))

vi.mock('../../src/rbac/service', () => ({
  listUserPermissions: rbacMocks.listUserPermissions,
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  DingTalkRequestError: dingtalkClientMocks.DingTalkRequestError,
}))

import { authRouter } from '../../src/routes/auth'

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
  } as Response & {
    statusCode: number
    body: unknown
    headersSent: boolean
  }
}

async function invokeRoute(
  method: 'get' | 'post',
  path: string,
  options: {
    headers?: Record<string, string>
    query?: Record<string, unknown>
    params?: Record<string, string>
    body?: Record<string, unknown>
  } = {},
) {
  const layer = authRouter.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: options.headers ?? {},
    query: options.query ?? {},
    params: options.params ?? {},
    body: options.body ?? {},
    user: undefined,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
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

describe('auth login routes', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    authServiceMocks.login.mockReset()
    authServiceMocks.register.mockReset()
    authServiceMocks.refreshToken.mockReset()
    authServiceMocks.verifyToken.mockReset()
    authServiceMocks.createToken.mockReset()
    authServiceMocks.readTokenPayload.mockReset()
    inviteTokenMocks.verifyInviteToken.mockReset()
    pgMocks.query.mockReset()
    bcryptMocks.hash.mockReset()
    bcryptMocks.compare.mockReset()
    sessionMocks.revokeUserSessions.mockReset()
    sessionRegistryMocks.createUserSession.mockReset()
    sessionRegistryMocks.listUserSessions.mockReset()
    sessionRegistryMocks.getUserSession.mockReset()
    sessionRegistryMocks.revokeUserSession.mockReset()
    sessionRegistryMocks.touchUserSession.mockReset()
    dingtalkOauthMocks.isDingTalkConfigured.mockReset()
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReset()
    dingtalkOauthMocks.generateState.mockReset()
    dingtalkOauthMocks.buildAuthUrl.mockReset()
    dingtalkOauthMocks.validateState.mockReset()
    dingtalkOauthMocks.exchangeCodeForUser.mockReset()
    dingtalkOauthMocks.exchangeCodeForDingTalkProfile.mockReset()
    dingtalkOauthMocks.bindDingTalkIdentityToUser.mockReset()
    rbacMocks.listUserPermissions.mockReset()
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue({
      configured: true,
      available: true,
      corpId: 'ding-corp',
      allowedCorpIds: [],
      requireGrant: false,
      autoLinkEmail: false,
      autoProvision: false,
      unavailableReason: null,
    })
  })

  it('returns feature payload on successful login', async () => {
    authServiceMocks.login.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'admin@example.com',
        name: 'Admin',
        role: 'admin',
        permissions: ['attendance:admin', 'workflow:read'],
        created_at: new Date('2026-03-13T00:00:00.000Z'),
        updated_at: new Date('2026-03-13T00:00:00.000Z'),
      },
      token: 'jwt-login-token',
    })

    const response = await invokeRoute('post', '/login', {
      body: {
        email: 'admin@example.com',
        password: 'WelcomePass9A',
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.token).toBe('jwt-login-token')
    expect((response.body as Record<string, any>).data.features).toMatchObject({
      attendance: true,
      workflow: expect.any(Boolean),
      attendanceAdmin: true,
    })
  })

  it('forwards x-tenant-id into the normal login flow', async () => {
    authServiceMocks.login.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'admin@example.com',
        name: 'Admin',
        role: 'admin',
        permissions: ['attendance:admin'],
        tenantId: 'tenant_42',
        created_at: new Date('2026-03-13T00:00:00.000Z'),
        updated_at: new Date('2026-03-13T00:00:00.000Z'),
      },
      token: 'jwt-login-token',
    })

    const response = await invokeRoute('post', '/login', {
      headers: {
        'x-tenant-id': 'tenant_42',
      },
      body: {
        email: 'admin@example.com',
        password: 'WelcomePass9A',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(authServiceMocks.login).toHaveBeenCalledWith(
      'admin@example.com',
      'WelcomePass9A',
      expect.objectContaining({
        tenantId: 'tenant_42',
      }),
    )
  })

  it('forwards tenantId from the login request body into the normal login flow', async () => {
    authServiceMocks.login.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'admin@example.com',
        name: 'Admin',
        role: 'admin',
        permissions: ['attendance:admin'],
        tenantId: 'tenant_42',
        created_at: new Date('2026-03-13T00:00:00.000Z'),
        updated_at: new Date('2026-03-13T00:00:00.000Z'),
      },
      token: 'jwt-login-token',
    })

    const response = await invokeRoute('post', '/login', {
      body: {
        email: 'admin@example.com',
        password: 'WelcomePass9A',
        tenantId: 'tenant_42',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(authServiceMocks.login).toHaveBeenCalledWith(
      'admin@example.com',
      'WelcomePass9A',
      expect.objectContaining({
        tenantId: 'tenant_42',
      }),
    )
  })

  it('issues a dev token with an optional tenant claim', async () => {
    const response = await invokeRoute('get', '/dev-token', {
      query: {
        userId: 'dev-user',
        tenantId: 'tenant_42',
        roles: 'admin',
        perms: '*:*',
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).payload).toMatchObject({
      id: 'dev-user',
      tenantId: 'tenant_42',
      roles: ['admin'],
      perms: ['*:*'],
    })
    expect(sessionRegistryMocks.createUserSession).toHaveBeenCalledWith(
      'dev-user',
      expect.objectContaining({
        sessionId: expect.any(String),
        ipAddress: '127.0.0.1',
      }),
    )
  })

  it('returns feature payload on me for a valid token', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
      created_at: new Date('2026-03-13T00:00:00.000Z'),
      updated_at: new Date('2026-03-13T00:00:00.000Z'),
    })

    const response = await invokeRoute('get', '/me', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(authServiceMocks.verifyToken).toHaveBeenCalledWith('live-token')
    expect((response.body as Record<string, any>).data.features.attendance).toBe(true)
  })

  it('disables plm in feature payload when ENABLE_PLM=0', async () => {
    vi.stubEnv('PRODUCT_MODE', 'plm-workbench')
    vi.stubEnv('ENABLE_PLM', '0')

    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'admin',
      permissions: ['attendance:admin'],
      created_at: new Date('2026-03-13T00:00:00.000Z'),
      updated_at: new Date('2026-03-13T00:00:00.000Z'),
    })

    const response = await invokeRoute('get', '/me', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.features).toMatchObject({
      plm: false,
      mode: 'platform',
    })
  })

  it('lists current user sessions and exposes currentSessionId', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockReturnValue({
      sub: 'user-1',
      sid: 'session-current',
    })
    sessionRegistryMocks.listUserSessions.mockResolvedValue([
      {
        id: 'session-current',
        userId: 'user-1',
        issuedAt: '2026-03-13T08:00:00.000Z',
        expiresAt: '2026-03-14T08:00:00.000Z',
        lastSeenAt: '2026-03-13T08:30:00.000Z',
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
        ipAddress: '127.0.0.1',
        userAgent: 'Vitest',
        createdAt: '2026-03-13T08:00:00.000Z',
        updatedAt: '2026-03-13T08:30:00.000Z',
      },
    ])

    const response = await invokeRoute('get', '/sessions', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(authServiceMocks.readTokenPayload).toHaveBeenCalledWith('live-token')
    expect(sessionRegistryMocks.listUserSessions).toHaveBeenCalledWith('user-1')
    expect((response.body as Record<string, any>).data.currentSessionId).toBe('session-current')
    expect((response.body as Record<string, any>).data.items).toHaveLength(1)
  })

  it('revokes one owned session from the self-service session center', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    sessionRegistryMocks.getUserSession.mockResolvedValue({
      id: 'session-other',
      userId: 'user-1',
      issuedAt: '2026-03-13T08:00:00.000Z',
      expiresAt: '2026-03-14T08:00:00.000Z',
      lastSeenAt: '2026-03-13T08:30:00.000Z',
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      ipAddress: '127.0.0.1',
      userAgent: 'Vitest',
      createdAt: '2026-03-13T08:00:00.000Z',
      updatedAt: '2026-03-13T08:30:00.000Z',
    })
    sessionRegistryMocks.revokeUserSession.mockResolvedValue({
      id: 'session-other',
      userId: 'user-1',
      issuedAt: '2026-03-13T08:00:00.000Z',
      expiresAt: '2026-03-14T08:00:00.000Z',
      lastSeenAt: '2026-03-13T08:30:00.000Z',
      revokedAt: '2026-03-13T09:00:00.000Z',
      revokedBy: 'user-1',
      revokeReason: 'self-session-logout',
      ipAddress: '127.0.0.1',
      userAgent: 'Vitest',
      createdAt: '2026-03-13T08:00:00.000Z',
      updatedAt: '2026-03-13T09:00:00.000Z',
    })

    const response = await invokeRoute('post', '/sessions/:sessionId/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
      params: {
        sessionId: 'session-other',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(sessionRegistryMocks.getUserSession).toHaveBeenCalledWith('session-other')
    expect(sessionRegistryMocks.revokeUserSession).toHaveBeenCalledWith('session-other', {
      revokedBy: 'user-1',
      reason: 'self-session-logout',
    })
    expect((response.body as Record<string, any>).data.sessionId).toBe('session-other')
  })

  it('pings the current session and returns the refreshed record', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockReturnValue({
      sub: 'user-1',
      sid: 'session-current',
    })
    sessionRegistryMocks.touchUserSession.mockResolvedValue({
      id: 'session-current',
      userId: 'user-1',
      issuedAt: '2026-03-13T08:00:00.000Z',
      expiresAt: '2026-03-14T08:00:00.000Z',
      lastSeenAt: '2026-03-13T09:00:00.000Z',
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      ipAddress: '127.0.0.1',
      userAgent: 'Vitest Browser',
      createdAt: '2026-03-13T08:00:00.000Z',
      updatedAt: '2026-03-13T09:00:00.000Z',
    })

    const response = await invokeRoute('post', '/sessions/current/ping', {
      headers: {
        authorization: 'Bearer live-token',
        'user-agent': 'Vitest Browser',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(sessionRegistryMocks.touchUserSession).toHaveBeenCalledWith('session-current', {
      ipAddress: '127.0.0.1',
      userAgent: 'Vitest Browser',
      minIntervalMs: 60_000,
    })
    expect((response.body as Record<string, any>).data.sessionId).toBe('session-current')
    expect((response.body as Record<string, any>).data.lastSeenAt).toBe('2026-03-13T09:00:00.000Z')
  })

  it('prefers current-session revocation on logout when sid is present', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockReturnValue({
      sub: 'user-1',
      sid: 'session-current',
    })
    sessionRegistryMocks.revokeUserSession.mockResolvedValue({
      id: 'session-current',
      userId: 'user-1',
      issuedAt: '2026-03-13T08:00:00.000Z',
      expiresAt: '2026-03-14T08:00:00.000Z',
      lastSeenAt: '2026-03-13T08:30:00.000Z',
      revokedAt: '2026-03-13T09:00:00.000Z',
      revokedBy: 'user-1',
      revokeReason: 'self-logout',
      ipAddress: '127.0.0.1',
      userAgent: 'Vitest',
      createdAt: '2026-03-13T08:00:00.000Z',
      updatedAt: '2026-03-13T09:00:00.000Z',
    })

    const response = await invokeRoute('post', '/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(sessionRegistryMocks.revokeUserSession).toHaveBeenCalledWith('session-current', {
      revokedBy: 'user-1',
      reason: 'self-logout',
    })
    expect(sessionMocks.revokeUserSessions).not.toHaveBeenCalled()
    expect((response.body as Record<string, any>).data.scope).toBe('current-session')
  })

  it('returns the current-user DingTalk access snapshot', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          enabled: true,
          granted_by: 'admin-1',
          created_at: '2026-04-11T12:00:00.000Z',
          updated_at: '2026-04-11T12:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          corp_id: 'dingcorp',
          last_login_at: '2026-04-11T12:00:00.000Z',
          created_at: '2026-04-11T12:00:00.000Z',
          updated_at: '2026-04-11T12:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ linked_count: 1 }],
      })

    const response = await invokeRoute('get', '/dingtalk/access', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      available: true,
      userId: 'user-1',
      provider: 'dingtalk',
      directory: {
        linked: true,
        linkedCount: 1,
      },
      grant: {
        exists: true,
        enabled: true,
      },
      identity: {
        exists: true,
        corpId: 'dingcorp',
      },
    })
  })

  it('unbinds a self-managed DingTalk identity for the current user', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          corp_id: 'dingcorp',
          last_login_at: '2026-04-11T12:00:00.000Z',
          created_at: '2026-04-11T12:00:00.000Z',
          updated_at: '2026-04-11T12:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ linked_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ linked_count: 0 }] })

    const response = await invokeRoute('post', '/dingtalk/unbind', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('DELETE FROM user_external_identities'),
      ['dingtalk', 'user-1'],
    )
    expect((response.body as Record<string, any>).data.identity.exists).toBe(false)
    expect((response.body as Record<string, any>).data.directory.linked).toBe(false)
  })

  it('blocks DingTalk self-unbind when the identity is directory-managed', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          corp_id: 'dingcorp',
          last_login_at: '2026-04-11T12:00:00.000Z',
          created_at: '2026-04-11T12:00:00.000Z',
          updated_at: '2026-04-11T12:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ linked_count: 2 }] })

    const response = await invokeRoute('post', '/dingtalk/unbind', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error).toContain('directory-managed')
    expect(pgMocks.query).toHaveBeenCalledTimes(3)
  })

  it('requires authentication before issuing a DingTalk bind auth URL', async () => {
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    authServiceMocks.verifyToken.mockResolvedValue(null)

    const response = await invokeRoute('get', '/dingtalk/launch', {
      query: {
        intent: 'bind',
        redirect: '/settings?dingtalk=bound',
      },
    })

    expect(response.statusCode).toBe(401)
    expect(dingtalkOauthMocks.generateState).not.toHaveBeenCalled()
    expect(dingtalkOauthMocks.buildAuthUrl).not.toHaveBeenCalled()
  })

  it('builds a DingTalk bind auth URL tagged with the current user', async () => {
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    dingtalkOauthMocks.generateState.mockResolvedValue('state-bind-1')
    dingtalkOauthMocks.buildAuthUrl.mockReturnValue('https://login.dingtalk.test/oauth-bind')
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: [],
    })

    const response = await invokeRoute('get', '/dingtalk/launch', {
      query: {
        intent: 'bind',
        redirect: '/settings?dingtalk=bound',
      },
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(dingtalkOauthMocks.generateState).toHaveBeenCalledWith({
      redirectPath: '/settings?dingtalk=bound',
      intent: 'bind',
      bindUserId: 'user-1',
    })
    expect(dingtalkOauthMocks.buildAuthUrl).toHaveBeenCalledWith('state-bind-1')
    expect((response.body as Record<string, any>).data).toMatchObject({
      url: 'https://login.dingtalk.test/oauth-bind',
      state: 'state-bind-1',
      mode: 'bind',
    })
  })

  it('rejects a bind callback when no session token is provided', async () => {
    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: true,
      redirectPath: '/settings?dingtalk=bound',
      intent: 'bind',
      bindUserId: 'user-1',
    })
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)

    const response = await invokeRoute('post', '/dingtalk/callback', {
      body: {
        code: 'auth-code',
        state: 'state-bind-1',
      },
    })

    expect(response.statusCode).toBe(401)
    expect(dingtalkOauthMocks.exchangeCodeForDingTalkProfile).not.toHaveBeenCalled()
    expect(dingtalkOauthMocks.bindDingTalkIdentityToUser).not.toHaveBeenCalled()
  })

  it('rejects a bind callback when the session user does not match the bind target', async () => {
    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: true,
      redirectPath: '/settings?dingtalk=bound',
      intent: 'bind',
      bindUserId: 'user-1',
    })
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-other',
      email: 'other@example.com',
      name: 'Other',
      role: 'user',
      permissions: [],
    })

    const response = await invokeRoute('post', '/dingtalk/callback', {
      headers: {
        authorization: 'Bearer live-token',
      },
      body: {
        code: 'auth-code',
        state: 'state-bind-1',
      },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).code).toBe('bind_user_mismatch')
    expect(dingtalkOauthMocks.exchangeCodeForDingTalkProfile).not.toHaveBeenCalled()
    expect(dingtalkOauthMocks.bindDingTalkIdentityToUser).not.toHaveBeenCalled()
  })

  it('surfaces 409 when the DingTalk identity is already bound to another user', async () => {
    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: true,
      redirectPath: '/settings?dingtalk=bound',
      intent: 'bind',
      bindUserId: 'user-1',
    })
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: [],
    })
    dingtalkOauthMocks.exchangeCodeForDingTalkProfile.mockResolvedValue({
      openId: 'open-id-1',
      unionId: 'union-id-1',
      nick: 'Ding User',
      email: 'manager@example.com',
    })
    dingtalkOauthMocks.bindDingTalkIdentityToUser.mockRejectedValue(
      new dingtalkOauthMocks.DingTalkLoginPolicyError(
        'DingTalk identity is already bound to another local user',
        { statusCode: 409, code: 'identity_already_bound' },
      ),
    )

    const response = await invokeRoute('post', '/dingtalk/callback', {
      headers: {
        authorization: 'Bearer live-token',
      },
      body: {
        code: 'auth-code',
        state: 'state-bind-1',
      },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error).toContain('already bound')
  })

  it('binds a DingTalk identity to the current user without reissuing a token', async () => {
    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: true,
      redirectPath: '/settings?dingtalk=bound',
      intent: 'bind',
      bindUserId: 'user-1',
    })
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: [],
    })
    dingtalkOauthMocks.exchangeCodeForDingTalkProfile.mockResolvedValue({
      openId: 'open-id-1',
      unionId: 'union-id-1',
      nick: 'Ding User',
      email: 'manager@example.com',
    })
    dingtalkOauthMocks.bindDingTalkIdentityToUser.mockResolvedValue(undefined)
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          enabled: true,
          granted_by: 'user-1',
          created_at: '2026-04-11T12:00:00.000Z',
          updated_at: '2026-04-11T12:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          corp_id: 'dingcorp',
          last_login_at: null,
          created_at: '2026-04-11T12:00:00.000Z',
          updated_at: '2026-04-11T12:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ linked_count: 0 }] })

    const response = await invokeRoute('post', '/dingtalk/callback', {
      headers: {
        authorization: 'Bearer live-token',
      },
      body: {
        code: 'auth-code',
        state: 'state-bind-1',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(dingtalkOauthMocks.exchangeCodeForDingTalkProfile).toHaveBeenCalledWith('auth-code')
    expect(dingtalkOauthMocks.bindDingTalkIdentityToUser).toHaveBeenCalledWith(
      expect.objectContaining({
        localUserId: 'user-1',
        boundBy: 'user-1',
        enableGrant: true,
      }),
    )
    expect(authServiceMocks.createToken).not.toHaveBeenCalled()
    expect(sessionRegistryMocks.createUserSession).not.toHaveBeenCalled()
    expect((response.body as Record<string, any>).data).toMatchObject({
      mode: 'bind',
      bound: true,
      redirectPath: '/settings?dingtalk=bound',
      identity: expect.objectContaining({
        userId: 'user-1',
        identity: expect.objectContaining({ exists: true }),
      }),
    })
    expect((response.body as Record<string, any>).data.token).toBeUndefined()
  })

  it('builds a DingTalk auth URL and preserves a safe redirect path in state', async () => {
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    dingtalkOauthMocks.generateState.mockResolvedValue('state-1')
    dingtalkOauthMocks.buildAuthUrl.mockReturnValue('https://login.dingtalk.test/oauth')

    const response = await invokeRoute('get', '/dingtalk/launch', {
      query: {
        redirect: '/workflows?tab=mine',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(dingtalkOauthMocks.generateState).toHaveBeenCalledWith({
      redirectPath: '/workflows?tab=mine',
    })
    expect(dingtalkOauthMocks.buildAuthUrl).toHaveBeenCalledWith('state-1')
    expect((response.body as Record<string, any>).data.url).toBe('https://login.dingtalk.test/oauth')
  })

  it('supports probing DingTalk availability without generating OAuth state', async () => {
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue({
      configured: true,
      available: true,
      corpId: 'ding-corp',
      allowedCorpIds: ['ding-corp'],
      requireGrant: true,
      autoLinkEmail: true,
      autoProvision: false,
      unavailableReason: null,
    })

    const response = await invokeRoute('get', '/dingtalk/launch', {
      query: {
        probe: '1',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(dingtalkOauthMocks.generateState).not.toHaveBeenCalled()
    expect(dingtalkOauthMocks.buildAuthUrl).not.toHaveBeenCalled()
    expect((response.body as Record<string, any>).data).toEqual({
      configured: true,
      available: true,
      corpId: 'ding-corp',
      allowedCorpIds: ['ding-corp'],
      requireGrant: true,
      autoLinkEmail: true,
      autoProvision: false,
      unavailableReason: null,
    })
  })

  it('returns runtime status from probe even when DingTalk login is unavailable', async () => {
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(false)
    dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue({
      configured: true,
      available: false,
      corpId: 'ding-corp-blocked',
      allowedCorpIds: ['ding-corp-allowed'],
      requireGrant: false,
      autoLinkEmail: false,
      autoProvision: false,
      unavailableReason: 'corp_not_allowed',
    })

    const response = await invokeRoute('get', '/dingtalk/launch', {
      query: {
        probe: '1',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(dingtalkOauthMocks.generateState).not.toHaveBeenCalled()
    expect(dingtalkOauthMocks.buildAuthUrl).not.toHaveBeenCalled()
    expect((response.body as Record<string, any>).data).toMatchObject({
      available: false,
      unavailableReason: 'corp_not_allowed',
    })
  })

  it('exchanges a DingTalk callback into a local session token', async () => {
    const expSeconds = Math.floor(new Date('2026-04-08T10:00:00.000Z').getTime() / 1000)

    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: true,
      redirectPath: '/attendance',
    })
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    dingtalkOauthMocks.exchangeCodeForUser.mockResolvedValue({
      dingtalkUser: {
        openId: 'open-id-1',
        unionId: 'union-id-1',
        nick: 'Ding User',
        email: 'manager@example.com',
      },
      localUserId: 'user-1',
      localUserEmail: 'manager@example.com',
      localUserName: 'Manager',
      localUserRole: 'admin',
      isNewUser: false,
    })
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:admin', 'workflow:read'])
    authServiceMocks.createToken.mockReturnValue('jwt-dingtalk-token')
    authServiceMocks.readTokenPayload.mockReturnValue({
      exp: expSeconds,
    })
    sessionRegistryMocks.createUserSession.mockResolvedValue(undefined)
    pgMocks.query.mockResolvedValue({ rows: [] })

    const response = await invokeRoute('post', '/dingtalk/callback', {
      headers: {
        'x-tenant-id': 'tenant_42',
        'user-agent': 'Vitest Browser',
      },
      body: {
        code: 'auth-code',
        state: 'state-1',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(dingtalkOauthMocks.validateState).toHaveBeenCalledWith('state-1')
    expect(dingtalkOauthMocks.exchangeCodeForUser).toHaveBeenCalledWith('auth-code')
    expect(rbacMocks.listUserPermissions).toHaveBeenCalledWith('user-1')
    expect(authServiceMocks.createToken).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user-1',
        email: 'manager@example.com',
        role: 'admin',
        permissions: ['attendance:admin', 'workflow:read'],
        tenantId: 'tenant_42',
      }),
      expect.objectContaining({ sid: expect.any(String) }),
    )
    expect(sessionRegistryMocks.createUserSession).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        ipAddress: '127.0.0.1',
        userAgent: 'Vitest Browser',
      }),
    )
    expect((response.body as Record<string, any>).data).toMatchObject({
      token: 'jwt-dingtalk-token',
      redirectPath: '/attendance',
      user: {
        id: 'user-1',
        email: 'manager@example.com',
        role: 'admin',
      },
    })
  })

  it('rejects DingTalk callback when state validation fails', async () => {
    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: false,
      error: 'State parameter has expired',
    })

    const response = await invokeRoute('post', '/dingtalk/callback', {
      body: {
        code: 'auth-code',
        state: 'expired-state',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error).toBe('State parameter has expired')
    expect(dingtalkOauthMocks.exchangeCodeForUser).not.toHaveBeenCalled()
  })

  it('surfaces disabled-local-user errors from the DingTalk callback exchange', async () => {
    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: true,
      redirectPath: '/attendance',
    })
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    dingtalkOauthMocks.exchangeCodeForUser.mockRejectedValue(
      new dingtalkOauthMocks.DingTalkLoginPolicyError('DingTalk login is disabled for this user', {
        statusCode: 403,
        code: 'local_user_disabled',
      }),
    )

    const response = await invokeRoute('post', '/dingtalk/callback', {
      body: {
        code: 'auth-code',
        state: 'state-1',
      },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error).toBe('DingTalk login is disabled for this user')
    expect(rbacMocks.listUserPermissions).not.toHaveBeenCalled()
  })

  it('keeps upstream DingTalk request failures mapped to 502', async () => {
    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: true,
      redirectPath: '/attendance',
    })
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    dingtalkOauthMocks.exchangeCodeForUser.mockRejectedValue(
      new dingtalkClientMocks.DingTalkRequestError('Failed to obtain access token from DingTalk', 401, {
        error: 'invalid_client',
      }),
    )

    const response = await invokeRoute('post', '/dingtalk/callback', {
      body: {
        code: 'auth-code',
        state: 'state-1',
      },
    })

    expect(response.statusCode).toBe(502)
    expect((response.body as Record<string, any>).error).toBe('Failed to obtain access token from DingTalk')
  })

  it('maps unexpected local callback failures to 500', async () => {
    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: true,
      redirectPath: '/attendance',
    })
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    dingtalkOauthMocks.exchangeCodeForUser.mockRejectedValue(new Error('session registry unavailable'))

    const response = await invokeRoute('post', '/dingtalk/callback', {
      body: {
        code: 'auth-code',
        state: 'state-1',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('DingTalk authentication failed')
  })

  it('returns 409 for local auto-provision email conflicts', async () => {
    dingtalkOauthMocks.validateState.mockResolvedValue({
      valid: true,
      redirectPath: '/attendance',
    })
    dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
    dingtalkOauthMocks.exchangeCodeForUser.mockRejectedValue(
      new dingtalkOauthMocks.DingTalkLoginPolicyError(
        'Refusing to auto-provision DingTalk user because a local account already exists with the same email',
        {
          statusCode: 409,
          code: 'auto_provision_email_conflict',
        },
      ),
    )

    const response = await invokeRoute('post', '/dingtalk/callback', {
      body: {
        code: 'auth-code',
        state: 'state-1',
      },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error).toContain('same email')
  })
})
