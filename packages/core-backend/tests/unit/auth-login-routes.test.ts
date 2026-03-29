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
  refreshUserSessionExpiry: vi.fn(),
  revokeUserSession: vi.fn(),
  touchUserSession: vi.fn(),
  revokeOtherUserSessions: vi.fn(),
}))

const dingTalkAuthMocks = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  verifyState: vi.fn(),
  exchangeCode: vi.fn(),
  getProvisioningConfig: vi.fn(),
}))

const MockDingTalkAuthExchangeError = vi.hoisted(() => class extends Error {
  stage: 'token' | 'user-info'
  status: number
  details?: Record<string, unknown>

  constructor(
    stage: 'token' | 'user-info',
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.stage = stage
    this.status = status
    this.details = details
  }
})

const externalIdentityMocks = vi.hoisted(() => ({
  buildDingTalkExternalKey: vi.fn(),
  findDingTalkExternalIdentity: vi.fn(),
  listUserExternalIdentities: vi.fn(),
  upsertExternalIdentity: vi.fn(),
  deleteUserExternalIdentity: vi.fn(),
  touchExternalIdentityLogin: vi.fn(),
}))

const externalAuthGrantMocks = vi.hoisted(() => ({
  isUserExternalAuthEnabled: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

const directorySyncMocks = vi.hoisted(() => ({
  captureUnboundLoginForReview: vi.fn(),
}))

vi.mock('../../src/auth/AuthService', () => ({
  authService: authServiceMocks,
}))

vi.mock('../../src/auth/invite-tokens', () => ({
  verifyInviteToken: inviteTokenMocks.verifyInviteToken,
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: vi.fn(async (handler: (client: { query: typeof pgMocks.query }) => Promise<unknown>) => handler({ query: pgMocks.query })),
  pool: {},
}))

vi.mock('bcryptjs', () => bcryptMocks)

vi.mock('../../src/auth/session-revocation', () => ({
  revokeUserSessions: sessionMocks.revokeUserSessions,
}))

vi.mock('../../src/auth/session-registry', () => ({
  createUserSession: sessionRegistryMocks.createUserSession,
  listUserSessions: sessionRegistryMocks.listUserSessions,
  getUserSession: sessionRegistryMocks.getUserSession,
  refreshUserSessionExpiry: sessionRegistryMocks.refreshUserSessionExpiry,
  revokeUserSession: sessionRegistryMocks.revokeUserSession,
  touchUserSession: sessionRegistryMocks.touchUserSession,
  revokeOtherUserSessions: sessionRegistryMocks.revokeOtherUserSessions,
}))

vi.mock('../../src/auth/dingtalk-auth', () => ({
  dingTalkAuthService: dingTalkAuthMocks,
  DingTalkAuthExchangeError: MockDingTalkAuthExchangeError,
  isDingTalkAuthExchangeError: (error: unknown) => error instanceof MockDingTalkAuthExchangeError,
}))

vi.mock('../../src/auth/external-identities', () => ({
  buildDingTalkExternalKey: externalIdentityMocks.buildDingTalkExternalKey,
  findDingTalkExternalIdentity: externalIdentityMocks.findDingTalkExternalIdentity,
  listUserExternalIdentities: externalIdentityMocks.listUserExternalIdentities,
  upsertExternalIdentity: externalIdentityMocks.upsertExternalIdentity,
  deleteUserExternalIdentity: externalIdentityMocks.deleteUserExternalIdentity,
  touchExternalIdentityLogin: externalIdentityMocks.touchExternalIdentityLogin,
}))

vi.mock('../../src/auth/external-auth-grants', () => ({
  isUserExternalAuthEnabled: externalAuthGrantMocks.isUserExternalAuthEnabled,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

vi.mock('../../src/directory/directory-sync', () => ({
  directorySyncService: directorySyncMocks,
}))

import { authRouter, resetAuthRouteRateLimitsForTests } from '../../src/routes/auth'

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
    ip?: string
  } = {},
) {
  const layer = authRouter.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const requestIp = options.ip ?? '127.0.0.1'
  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: options.headers ?? {},
    query: options.query ?? {},
    params: options.params ?? {},
    body: options.body ?? {},
    user: undefined,
    ip: requestIp,
    socket: { remoteAddress: requestIp },
  } as unknown as Request

  const res = createMockResponse()

  for (const routeLayer of layer.route.stack) {
    if (res.headersSent) break

    await new Promise<void>((resolve, reject) => {
      try {
        const maybePromise = routeLayer.handle(req, res, (error?: unknown) => {
          if (error) reject(error)
          else resolve()
        })
        if (maybePromise && typeof maybePromise.then === 'function') {
          Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
        } else if (routeLayer.handle.length < 3 || res.headersSent) {
          resolve()
        }
      } catch (error) {
        reject(error)
      }
    })

    if (res.headersSent) break
  }

  return res
}

describe('auth login routes', () => {
  beforeEach(() => {
    resetAuthRouteRateLimitsForTests()
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
    sessionRegistryMocks.refreshUserSessionExpiry.mockReset()
    sessionRegistryMocks.revokeUserSession.mockReset()
    sessionRegistryMocks.touchUserSession.mockReset()
    sessionRegistryMocks.revokeOtherUserSessions.mockReset()
    dingTalkAuthMocks.isConfigured.mockReset()
    dingTalkAuthMocks.buildAuthorizeUrl.mockReset()
    dingTalkAuthMocks.verifyState.mockReset()
    dingTalkAuthMocks.exchangeCode.mockReset()
    dingTalkAuthMocks.getProvisioningConfig.mockReset()
    externalIdentityMocks.buildDingTalkExternalKey.mockReset()
    externalIdentityMocks.findDingTalkExternalIdentity.mockReset()
    externalIdentityMocks.listUserExternalIdentities.mockReset()
    externalIdentityMocks.upsertExternalIdentity.mockReset()
    externalIdentityMocks.deleteUserExternalIdentity.mockReset()
    externalIdentityMocks.touchExternalIdentityLogin.mockReset()
    externalAuthGrantMocks.isUserExternalAuthEnabled.mockReset().mockResolvedValue(true)
    auditMocks.auditLog.mockReset()
    directorySyncMocks.captureUnboundLoginForReview.mockReset().mockResolvedValue(null)
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
    authServiceMocks.createToken.mockReturnValue('jwt-session-token')
    authServiceMocks.readTokenPayload.mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 })
    sessionRegistryMocks.createUserSession.mockResolvedValue({ id: 'session-1' })

    const response = await invokeRoute('post', '/login', {
      body: {
        email: 'admin@example.com',
        password: 'WelcomePass9A',
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.token).toBe('jwt-session-token')
    expect((response.body as Record<string, any>).data.features).toMatchObject({
      attendance: true,
      workflow: expect.any(Boolean),
      platformAdmin: true,
      attendanceAdmin: true,
    })
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
    expect((response.body as Record<string, any>).data.features.platformAdmin).toBe(false)
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

  it('returns 401 when list sessions without token', async () => {
    const response = await invokeRoute('get', '/sessions')

    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error).toBe('No token provided')
  })

  it('returns DingTalk login URL when configured', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.buildAuthorizeUrl.mockReturnValue({
      url: 'https://login.dingtalk.com/oauth2/auth?state=abc',
      state: 'abc',
      redirect: '/settings',
    })

    const response = await invokeRoute('get', '/dingtalk/login-url', {
      query: { redirect: '/settings' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      provider: 'dingtalk',
      url: 'https://login.dingtalk.com/oauth2/auth?state=abc',
      loginUrl: 'https://login.dingtalk.com/oauth2/auth?state=abc',
      state: 'abc',
      redirect: '/settings',
    })
  })

  it('rate limits DingTalk login-url requests per IP', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.buildAuthorizeUrl.mockReturnValue({
      url: 'https://login.dingtalk.com/oauth2/auth?state=abc',
      state: 'abc',
      redirect: '/settings',
    })

    let response = await invokeRoute('get', '/dingtalk/login-url', {
      query: { redirect: '/settings' },
      ip: '10.0.0.8',
    })

    expect(response.statusCode).toBe(200)

    for (let attempt = 0; attempt < 20; attempt++) {
      response = await invokeRoute('get', '/dingtalk/login-url', {
        query: { redirect: '/settings' },
        ip: '10.0.0.8',
      })
    }

    expect(response.statusCode).toBe(429)
    expect((response.body as Record<string, any>).error).toContain('Too many DingTalk login attempts')
  })

  it('returns DingTalk bind URL for the current user', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.buildAuthorizeUrl.mockReturnValue({
      url: 'https://login.dingtalk.com/oauth2/auth?state=bind',
      state: 'bind',
      redirect: '/settings',
    })
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'bound@example.com',
      name: 'Bound User',
      role: 'user',
      permissions: ['attendance:read'],
      created_at: new Date('2026-03-23T00:00:00.000Z'),
      updated_at: new Date('2026-03-23T00:00:00.000Z'),
    })

    const response = await invokeRoute('post', '/dingtalk/bind/start', {
      headers: {
        authorization: 'Bearer live-token',
      },
      body: {
        redirect: '/settings',
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data).toMatchObject({
      provider: 'dingtalk',
      url: 'https://login.dingtalk.com/oauth2/auth?state=bind',
      bindUrl: 'https://login.dingtalk.com/oauth2/auth?state=bind',
      state: 'bind',
      redirect: '/settings',
    })
  })

  it('rejects DingTalk bind start when the current MetaSheet account is not authorized', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'bound@example.com',
      name: 'Bound User',
      role: 'user',
      permissions: ['attendance:read'],
      created_at: new Date('2026-03-23T00:00:00.000Z'),
      updated_at: new Date('2026-03-23T00:00:00.000Z'),
    })
    externalAuthGrantMocks.isUserExternalAuthEnabled.mockResolvedValue(false)

    const response = await invokeRoute('post', '/dingtalk/bind/start', {
      headers: {
        authorization: 'Bearer live-token',
      },
      body: {
        redirect: '/settings',
      },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error.code).toBe('DINGTALK_BIND_NOT_AUTHORIZED')
  })

  it('refreshes token and extends current session expiry when sid is present', async () => {
    authServiceMocks.refreshToken.mockResolvedValue('refreshed-token')
    authServiceMocks.readTokenPayload.mockReturnValue({
      sid: 'session-1',
      exp: Math.floor(Date.now() / 1000) + 7200,
    })
    sessionRegistryMocks.refreshUserSessionExpiry.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      issuedAt: '2026-03-23T00:00:00.000Z',
      expiresAt: '2026-03-23T02:00:00.000Z',
      lastSeenAt: '2026-03-23T00:30:00.000Z',
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      ipAddress: '127.0.0.1',
      userAgent: 'Vitest',
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:30:00.000Z',
    })

    const response = await invokeRoute('post', '/refresh-token', {
      body: { token: 'old-token' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.token).toBe('refreshed-token')
    expect(sessionRegistryMocks.refreshUserSessionExpiry).toHaveBeenCalledWith('session-1', expect.any(String))
  })

  it('exchanges DingTalk code and logs in a bound user', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.verifyState.mockReturnValue({
      type: 'dingtalk-auth',
      mode: 'login',
      redirect: '/attendance',
    })
    dingTalkAuthMocks.exchangeCode.mockResolvedValue({
      provider: 'dingtalk',
      userId: 'dt-user-1',
      unionId: 'union-1',
      openId: 'open-1',
      corpId: 'corp-1',
      name: 'Ding User',
      nick: 'Ding',
      email: 'bound@example.com',
      avatarUrl: null,
      mobile: null,
      raw: { userId: 'dt-user-1' },
    })
    externalIdentityMocks.findDingTalkExternalIdentity.mockResolvedValue({
      id: 'binding-1',
      provider: 'dingtalk',
      externalKey: 'dingtalk:corp-1:dt-user-1',
      providerUserId: 'dt-user-1',
      providerUnionId: 'union-1',
      providerOpenId: 'open-1',
      corpId: 'corp-1',
      userId: 'user-1',
      profile: {},
      boundBy: 'user-1',
      lastLoginAt: null,
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:00:00.000Z',
    })
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'bound@example.com',
        name: 'Bound User',
        role: 'user',
        permissions: ['attendance:read'],
        created_at: new Date('2026-03-23T00:00:00.000Z'),
        updated_at: new Date('2026-03-23T00:00:00.000Z'),
      }],
    })
    authServiceMocks.createToken
      .mockReturnValueOnce('lookup-token')
      .mockReturnValueOnce('session-token')
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'bound@example.com',
      name: 'Bound User',
      role: 'user',
      permissions: ['attendance:read'],
      created_at: new Date('2026-03-23T00:00:00.000Z'),
      updated_at: new Date('2026-03-23T00:00:00.000Z'),
    })
    authServiceMocks.readTokenPayload.mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 })
    sessionRegistryMocks.createUserSession.mockResolvedValue({ id: 'session-1' })

    const response = await invokeRoute('post', '/dingtalk/exchange', {
      body: { code: 'code-1', state: 'state-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(externalIdentityMocks.touchExternalIdentityLogin).toHaveBeenCalledWith('binding-1')
    expect((response.body as Record<string, any>).data.token).toBe('session-token')
    expect((response.body as Record<string, any>).data.binding.id).toBe('binding-1')
  })

  it('rate limits DingTalk exchange requests per IP', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.verifyState.mockReturnValue(null)

    let response = await invokeRoute('post', '/dingtalk/exchange', {
      body: { code: 'code-1', state: 'state-1' },
      ip: '10.0.0.9',
    })
    expect(response.statusCode).toBe(400)

    for (let attempt = 0; attempt < 10; attempt++) {
      response = await invokeRoute('post', '/dingtalk/exchange', {
        body: { code: 'code-1', state: 'state-1' },
        ip: '10.0.0.9',
      })
    }

    expect(response.statusCode).toBe(429)
    expect((response.body as Record<string, any>).error).toContain('Too many DingTalk authorization attempts')
  })

  it('surfaces structured DingTalk upstream exchange failures', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.verifyState.mockReturnValue({
      type: 'dingtalk-auth',
      mode: 'login',
      redirect: '/settings',
    })
    dingTalkAuthMocks.exchangeCode.mockRejectedValue(
      new MockDingTalkAuthExchangeError(
        'user-info',
        403,
        'Failed to fetch DingTalk user info',
        {
          payload: {
            errcode: 40078,
            errmsg: 'no permission',
          },
        },
      ),
    )

    const response = await invokeRoute('post', '/dingtalk/exchange', {
      body: { code: 'code-1', state: 'state-1' },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error).toEqual({
      code: 'DINGTALK_EXCHANGE_FAILED',
      message: 'Failed to fetch DingTalk user info',
      details: {
        provider: 'dingtalk',
        stage: 'user-info',
        upstreamStatus: 403,
        payload: {
          errcode: 40078,
          errmsg: 'no permission',
        },
      },
    })
  })

  it('rejects DingTalk bind when the current user already has another binding', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.verifyState.mockReturnValue({
      type: 'dingtalk-auth',
      mode: 'bind',
      redirect: '/settings',
      requestedBy: 'user-1',
    })
    dingTalkAuthMocks.exchangeCode.mockResolvedValue({
      provider: 'dingtalk',
      userId: 'dt-user-2',
      unionId: 'union-2',
      openId: 'open-2',
      corpId: 'corp-1',
      name: 'Second Ding User',
      nick: 'Second',
      email: 'bound@example.com',
      avatarUrl: null,
      mobile: null,
      raw: { userId: 'dt-user-2' },
    })
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'bound@example.com',
      name: 'Bound User',
      role: 'user',
      permissions: ['attendance:read'],
      created_at: new Date('2026-03-23T00:00:00.000Z'),
      updated_at: new Date('2026-03-23T00:00:00.000Z'),
    })
    externalIdentityMocks.findDingTalkExternalIdentity.mockResolvedValue(null)
    externalIdentityMocks.listUserExternalIdentities.mockResolvedValue([
      {
        id: 'binding-existing',
        provider: 'dingtalk',
        externalKey: 'dingtalk:corp-1:dt-user-1',
        providerUserId: 'dt-user-1',
        providerUnionId: 'union-1',
        providerOpenId: 'open-1',
        corpId: 'corp-1',
        userId: 'user-1',
        profile: {},
        boundBy: 'user-1',
        lastLoginAt: null,
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:00:00.000Z',
      },
    ])

    const response = await invokeRoute('post', '/dingtalk/exchange', {
      headers: {
        authorization: 'Bearer live-token',
      },
      body: { code: 'code-2', state: 'state-2' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).error.code).toBe('DINGTALK_BIND_EXISTS_FOR_USER')
  })

  it('lists DingTalk bindings for the current user', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'bound@example.com',
      name: 'Bound User',
      role: 'user',
      permissions: ['attendance:read'],
      created_at: new Date('2026-03-23T00:00:00.000Z'),
      updated_at: new Date('2026-03-23T00:00:00.000Z'),
    })
    externalIdentityMocks.listUserExternalIdentities.mockResolvedValue([
      {
        id: 'binding-1',
        provider: 'dingtalk',
        externalKey: 'dingtalk:corp-1:dt-user-1',
        providerUserId: 'dt-user-1',
        providerUnionId: 'union-1',
        providerOpenId: 'open-1',
        corpId: 'corp-1',
        userId: 'user-1',
        profile: {},
        boundBy: 'user-1',
        lastLoginAt: null,
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:00:00.000Z',
      },
    ])

    const response = await invokeRoute('get', '/dingtalk/bindings', {
      headers: { authorization: 'Bearer live-token' },
    })

    expect(response.statusCode).toBe(200)
    expect(externalIdentityMocks.listUserExternalIdentities).toHaveBeenCalledWith('user-1', 'dingtalk')
    expect((response.body as Record<string, any>).data.items).toHaveLength(1)
    expect((response.body as Record<string, any>).data.authEnabled).toBe(true)
  })

  it('rejects DingTalk login when the bound MetaSheet account is not authorized', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.verifyState.mockReturnValue({
      type: 'dingtalk-auth',
      mode: 'login',
      redirect: '/attendance',
    })
    dingTalkAuthMocks.exchangeCode.mockResolvedValue({
      provider: 'dingtalk',
      userId: 'dt-user-1',
      unionId: 'union-1',
      openId: 'open-1',
      corpId: 'corp-1',
      name: 'Ding User',
      nick: 'Ding',
      email: 'bound@example.com',
      avatarUrl: null,
      mobile: null,
      raw: { userId: 'dt-user-1' },
    })
    externalIdentityMocks.findDingTalkExternalIdentity.mockResolvedValue({
      id: 'binding-1',
      provider: 'dingtalk',
      externalKey: 'dingtalk:corp-1:dt-user-1',
      providerUserId: 'dt-user-1',
      providerUnionId: 'union-1',
      providerOpenId: 'open-1',
      corpId: 'corp-1',
      userId: 'user-1',
      profile: {},
      boundBy: 'user-1',
      lastLoginAt: null,
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:00:00.000Z',
    })
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'bound@example.com',
        name: 'Bound User',
        role: 'user',
        permissions: ['attendance:read'],
        created_at: new Date('2026-03-23T00:00:00.000Z'),
        updated_at: new Date('2026-03-23T00:00:00.000Z'),
      }],
    })
    authServiceMocks.createToken.mockReturnValue('lookup-token')
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'bound@example.com',
      name: 'Bound User',
      role: 'user',
      permissions: ['attendance:read'],
      created_at: new Date('2026-03-23T00:00:00.000Z'),
      updated_at: new Date('2026-03-23T00:00:00.000Z'),
    })
    externalAuthGrantMocks.isUserExternalAuthEnabled.mockResolvedValue(false)

    const response = await invokeRoute('post', '/dingtalk/exchange', {
      body: { code: 'code-1', state: 'state-1' },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error.code).toBe('DINGTALK_LOGIN_NOT_AUTHORIZED')
  })

  it('unbinds a DingTalk binding for the current user', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'bound@example.com',
      name: 'Bound User',
      role: 'user',
      permissions: ['attendance:read'],
      created_at: new Date('2026-03-23T00:00:00.000Z'),
      updated_at: new Date('2026-03-23T00:00:00.000Z'),
    })
    externalIdentityMocks.deleteUserExternalIdentity.mockResolvedValue({
      id: 'binding-1',
      provider: 'dingtalk',
      externalKey: 'dingtalk:corp-1:dt-user-1',
      providerUserId: 'dt-user-1',
      providerUnionId: 'union-1',
      providerOpenId: 'open-1',
      corpId: 'corp-1',
      userId: 'user-1',
      profile: {},
      boundBy: 'user-1',
      lastLoginAt: null,
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:00:00.000Z',
    })

    const response = await invokeRoute('post', '/dingtalk/bindings/:provider/:bindingId/unbind', {
      headers: {
        authorization: 'Bearer live-token',
      },
      params: {
        provider: 'dingtalk',
        bindingId: 'binding-1',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(externalIdentityMocks.deleteUserExternalIdentity).toHaveBeenCalledWith('user-1', 'dingtalk', 'binding-1')
    expect((response.body as Record<string, any>).data.item.id).toBe('binding-1')
  })

  it('auto-provisions a DingTalk user when no binding exists and provisioning is enabled', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.verifyState.mockReturnValue({
      type: 'dingtalk-auth',
      mode: 'login',
      redirect: '/attendance',
    })
    dingTalkAuthMocks.exchangeCode.mockResolvedValue({
      provider: 'dingtalk',
      userId: 'dt-user-2',
      unionId: 'union-2',
      openId: 'open-2',
      corpId: 'corp-1',
      name: 'Fresh Ding User',
      nick: 'Fresh',
      email: '',
      avatarUrl: null,
      mobile: null,
      raw: { userId: 'dt-user-2', corpId: 'corp-1' },
    })
    dingTalkAuthMocks.getProvisioningConfig.mockReturnValue({
      autoProvisionEnabled: true,
      autoProvisionPresetId: 'attendance-employee',
      autoProvisionOrgId: 'default',
      autoProvisionEmailDomain: 'dingtalk.local',
      allowedCorpIds: ['corp-1'],
    })
    externalIdentityMocks.findDingTalkExternalIdentity.mockResolvedValue(null)
    externalIdentityMocks.buildDingTalkExternalKey.mockReturnValue('dingtalk:corp-1:dt-user-2')
    externalIdentityMocks.upsertExternalIdentity.mockResolvedValue({
      id: 'binding-2',
      provider: 'dingtalk',
      externalKey: 'dingtalk:corp-1:dt-user-2',
      providerUserId: 'dt-user-2',
      providerUnionId: 'union-2',
      providerOpenId: 'open-2',
      corpId: 'corp-1',
      userId: 'new-user-1',
      profile: {},
      boundBy: null,
      lastLoginAt: null,
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:00:00.000Z',
    })
    bcryptMocks.hash.mockResolvedValue('hashed-auto-password')
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'new-user-1',
          email: 'dt-user-2@dingtalk.local',
          name: 'Fresh Ding User',
          role: 'user',
          permissions: ['attendance:read', 'attendance:write'],
          created_at: new Date('2026-03-23T00:00:00.000Z'),
          updated_at: new Date('2026-03-23T00:00:00.000Z'),
        }],
      })
    authServiceMocks.createToken
      .mockReturnValueOnce('lookup-token')
      .mockReturnValueOnce('session-token')
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'new-user-1',
      email: 'dt-user-2@dingtalk.local',
      name: 'Fresh Ding User',
      role: 'user',
      permissions: ['attendance:read', 'attendance:write'],
      created_at: new Date('2026-03-23T00:00:00.000Z'),
      updated_at: new Date('2026-03-23T00:00:00.000Z'),
    })
    authServiceMocks.readTokenPayload.mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 })
    sessionRegistryMocks.createUserSession.mockResolvedValue({ id: 'session-2' })

    const response = await invokeRoute('post', '/dingtalk/exchange', {
      body: { code: 'code-2', state: 'state-2' },
    })

    expect(response.statusCode).toBe(200)
    expect(bcryptMocks.hash).toHaveBeenCalled()
    expect(externalIdentityMocks.upsertExternalIdentity).toHaveBeenCalled()
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dingtalk-auto-provision',
      resourceType: 'user',
    }))
    expect((response.body as Record<string, any>).data.provisioned).toBe(true)
    expect((response.body as Record<string, any>).data.binding.id).toBe('binding-2')
    expect((response.body as Record<string, any>).data.token).toBe('session-token')
  })

  it('captures an unbound DingTalk login for administrator review when auto provisioning is disabled', async () => {
    dingTalkAuthMocks.isConfigured.mockReturnValue(true)
    dingTalkAuthMocks.verifyState.mockReturnValue({
      type: 'dingtalk-auth',
      mode: 'login',
      redirect: '/attendance',
    })
    dingTalkAuthMocks.exchangeCode.mockResolvedValue({
      provider: 'dingtalk',
      userId: 'dt-user-9',
      unionId: 'union-9',
      openId: 'open-9',
      corpId: 'corp-1',
      name: 'Pending Ding User',
      nick: 'Pending',
      email: 'pending@example.com',
      avatarUrl: null,
      mobile: '13800000000',
      raw: { userId: 'dt-user-9', corpId: 'corp-1' },
    })
    dingTalkAuthMocks.getProvisioningConfig.mockReturnValue({
      autoProvisionEnabled: false,
      autoProvisionPresetId: 'attendance-employee',
      autoProvisionOrgId: 'default',
      autoProvisionEmailDomain: 'dingtalk.local',
      allowedCorpIds: [],
    })
    externalIdentityMocks.findDingTalkExternalIdentity.mockResolvedValue(null)
    directorySyncMocks.captureUnboundLoginForReview.mockResolvedValue({
      integrationId: 'dir-1',
      accountId: 'acct-9',
      created: true,
      linkStatus: 'pending',
    })

    const response = await invokeRoute('post', '/dingtalk/exchange', {
      body: { code: 'code-9', state: 'state-9' },
    })

    expect(response.statusCode).toBe(409)
    expect(directorySyncMocks.captureUnboundLoginForReview).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'dt-user-9',
      corpId: 'corp-1',
    }))
    expect((response.body as Record<string, any>).error).toEqual({
      code: 'DINGTALK_ACCOUNT_REVIEW_REQUIRED',
      message: 'DingTalk account is pending administrator provisioning',
      details: {
        integrationId: 'dir-1',
        accountId: 'acct-9',
        queuedForReview: true,
        created: true,
        linkStatus: 'pending',
        corpId: 'corp-1',
      },
    })
  })

  it('returns 401 when list sessions token is invalid', async () => {
    authServiceMocks.verifyToken.mockResolvedValue(null)

    const response = await invokeRoute('get', '/sessions', {
      headers: {
        authorization: 'Bearer bad-token',
      },
    })

    expect(response.statusCode).toBe(401)
    expect(authServiceMocks.verifyToken).toHaveBeenCalledWith('bad-token')
    expect((response.body as Record<string, any>).error).toBe('Invalid token')
  })

  it('returns 500 when listing sessions throws unexpected error', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    sessionRegistryMocks.listUserSessions.mockRejectedValue(new Error('session db down'))

    const response = await invokeRoute('get', '/sessions', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
  })

  it('returns 500 when token payload parsing throws while listing sessions', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockImplementation(() => {
      throw new Error('payload parse failed')
    })

    const response = await invokeRoute('get', '/sessions', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
  })

  it('returns sessions with null currentSessionId when token has no sid', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockReturnValue({
      sub: 'user-1',
      sid: '',
    })
    sessionRegistryMocks.listUserSessions.mockResolvedValue([])

    const response = await invokeRoute('get', '/sessions', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.currentSessionId).toBeNull()
    expect((response.body as Record<string, any>).data.items).toEqual([])
  })

  it('returns sessions with null currentSessionId when token payload has no sid field', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockReturnValue({
      sub: 'user-1',
    })
    sessionRegistryMocks.listUserSessions.mockResolvedValue([])

    const response = await invokeRoute('get', '/sessions', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.currentSessionId).toBeNull()
    expect((response.body as Record<string, any>).data.items).toEqual([])
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

  it('returns 401 when pinging current session without token', async () => {
    const response = await invokeRoute('post', '/sessions/current/ping')

    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error).toBe('No token provided')
  })

  it('returns 401 when pinging current session with invalid token', async () => {
    authServiceMocks.verifyToken.mockResolvedValue(null)

    const response = await invokeRoute('post', '/sessions/current/ping', {
      headers: {
        authorization: 'Bearer bad-token',
      },
    })

    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error).toBe('Invalid token')
    expect(sessionRegistryMocks.touchUserSession).not.toHaveBeenCalled()
  })

  it('returns 400 when pinging current session without sid in token', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockReturnValue({
      sub: 'user-1',
      sid: '',
    })

    const response = await invokeRoute('post', '/sessions/current/ping', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(sessionRegistryMocks.touchUserSession).not.toHaveBeenCalled()
    expect((response.body as Record<string, any>).error).toBe('Current session is unavailable')
  })

  it('returns 400 when pinging current session with whitespace sid in token', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockReturnValue({
      sub: 'user-1',
      sid: '   ',
    })

    const response = await invokeRoute('post', '/sessions/current/ping', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(sessionRegistryMocks.touchUserSession).not.toHaveBeenCalled()
    expect((response.body as Record<string, any>).error).toBe('Current session is unavailable')
  })

  it('returns 500 when current session ping throws unexpected error', async () => {
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
    sessionRegistryMocks.touchUserSession.mockRejectedValue(new Error('ping store unavailable'))

    const response = await invokeRoute('post', '/sessions/current/ping', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
  })

  it('returns 500 when reading token payload throws for current session ping', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockImplementation(() => {
      throw new Error('payload decode failed')
    })

    const response = await invokeRoute('post', '/sessions/current/ping', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
  })

  it('loads session from store when current session ping touch returns null', async () => {
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
    sessionRegistryMocks.touchUserSession.mockResolvedValue(null)
    sessionRegistryMocks.getUserSession.mockResolvedValue({
      id: 'session-current',
      userId: 'user-1',
      issuedAt: '2026-03-13T08:00:00.000Z',
      expiresAt: '2026-03-14T08:00:00.000Z',
      lastSeenAt: '2026-03-13T09:20:00.000Z',
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      ipAddress: '127.0.0.1',
      userAgent: 'Vitest Browser',
      createdAt: '2026-03-13T08:00:00.000Z',
      updatedAt: '2026-03-13T09:20:00.000Z',
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
    expect(sessionRegistryMocks.getUserSession).toHaveBeenCalledWith('session-current')
    expect((response.body as Record<string, any>).data.session).toMatchObject({
      id: 'session-current',
      userId: 'user-1',
      lastSeenAt: '2026-03-13T09:20:00.000Z',
    })
    expect((response.body as Record<string, any>).data.lastSeenAt).toBe('2026-03-13T09:20:00.000Z')
  })

  it('keeps lastSeenAt null when current session ping can not resolve session', async () => {
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
    sessionRegistryMocks.touchUserSession.mockResolvedValue(null)
    sessionRegistryMocks.getUserSession.mockResolvedValue(null)

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
    expect(sessionRegistryMocks.getUserSession).toHaveBeenCalledWith('session-current')
    expect((response.body as Record<string, any>).data.session).toBeNull()
    expect((response.body as Record<string, any>).data.lastSeenAt).toBeNull()
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

  it('falls back to all-session revocation when current-session revocation returns null', async () => {
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
    sessionRegistryMocks.revokeUserSession.mockResolvedValue(null)
    sessionMocks.revokeUserSessions.mockResolvedValue({
      revokedAfter: '2026-03-13T09:45:00.000Z',
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
    expect(sessionMocks.revokeUserSessions).toHaveBeenCalledWith('user-1', {
      updatedBy: 'user-1',
      reason: 'self-logout',
    })
    expect((response.body as Record<string, any>).data.scope).toBe('all-sessions')
    expect((response.body as Record<string, any>).data.revokedAfter).toBe('2026-03-13T09:45:00.000Z')
  })

  it('returns 500 when current-session revocation throws during logout', async () => {
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
    sessionRegistryMocks.revokeUserSession.mockRejectedValue(new Error('session revoke failed'))

    const response = await invokeRoute('post', '/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
    expect(sessionRegistryMocks.revokeUserSession).toHaveBeenCalledWith('session-current', {
      revokedBy: 'user-1',
      reason: 'self-logout',
    })
    expect(sessionMocks.revokeUserSessions).not.toHaveBeenCalled()
  })

  it('returns 500 when fallback all-session revocation throws during logout', async () => {
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
    sessionRegistryMocks.revokeUserSession.mockResolvedValue(null)
    sessionMocks.revokeUserSessions.mockRejectedValue(new Error('all sessions revoke failed'))

    const response = await invokeRoute('post', '/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
    expect(sessionMocks.revokeUserSessions).toHaveBeenCalledWith('user-1', {
      updatedBy: 'user-1',
      reason: 'self-logout',
    })
  })

  it('revokes all sessions when sid is not available in logout token payload', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockReturnValue({
      sub: 'user-1',
    })
    sessionMocks.revokeUserSessions.mockResolvedValue({
      revokedAfter: '2026-03-13T09:30:00.000Z',
    })

    const response = await invokeRoute('post', '/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(sessionMocks.revokeUserSessions).toHaveBeenCalledWith('user-1', {
      updatedBy: 'user-1',
      reason: 'self-logout',
    })
    expect((response.body as Record<string, any>).data.scope).toBe('all-sessions')
    expect((response.body as Record<string, any>).data.revokedAfter).toBe('2026-03-13T09:30:00.000Z')
  })

  it('returns 401 when logout endpoint is called without token', async () => {
    const response = await invokeRoute('post', '/logout')

    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error).toBe('No token provided')
    expect(sessionMocks.revokeUserSessions).not.toHaveBeenCalled()
  })

  it('returns 401 when logout endpoint token is invalid', async () => {
    authServiceMocks.verifyToken.mockResolvedValue(null)

    const response = await invokeRoute('post', '/logout', {
      headers: {
        authorization: 'Bearer bad-token',
      },
    })

    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error).toBe('Invalid token')
    expect(sessionMocks.revokeUserSessions).not.toHaveBeenCalled()
  })

  it('returns 500 when reading token payload throws for logout', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockImplementation(() => {
      throw new Error('logout token malformed')
    })

    const response = await invokeRoute('post', '/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
  })

  it('returns 401 when revoking a session without token', async () => {
    const response = await invokeRoute('post', '/sessions/:sessionId/logout', {
      params: {
        sessionId: 'session-current',
      },
    })

    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error).toBe('No token provided')
  })

  it('returns 400 when revoking a session with empty sessionId', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })

    const response = await invokeRoute('post', '/sessions/:sessionId/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
      params: {
        sessionId: '   ',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error).toBe('Session ID is required')
    expect(sessionRegistryMocks.getUserSession).not.toHaveBeenCalled()
  })

  it('returns 401 when revoking a session with invalid token', async () => {
    authServiceMocks.verifyToken.mockResolvedValue(null)

    const response = await invokeRoute('post', '/sessions/:sessionId/logout', {
      headers: {
        authorization: 'Bearer bad-token',
      },
      params: {
        sessionId: 'session-current',
      },
    })

    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error).toBe('Invalid token')
    expect(sessionRegistryMocks.getUserSession).not.toHaveBeenCalled()
  })

  it('returns 500 when revoking a session throws unexpected error', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    sessionRegistryMocks.getUserSession.mockRejectedValue(new Error('session query failed'))

    const response = await invokeRoute('post', '/sessions/:sessionId/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
      params: {
        sessionId: 'session-current',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
  })

  it('rejects revoking an unowned session with 404', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    sessionRegistryMocks.getUserSession.mockResolvedValue({
      id: 'session-foreign',
      userId: 'user-other',
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

    const response = await invokeRoute('post', '/sessions/:sessionId/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
      params: {
        sessionId: 'session-foreign',
      },
    })

    expect(response.statusCode).toBe(404)
    expect((response.body as Record<string, any>).error).toBe('Session not found')
    expect(sessionRegistryMocks.revokeUserSession).not.toHaveBeenCalled()
  })

  it('revokes other sessions while preserving current session', async () => {
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
    sessionRegistryMocks.revokeOtherUserSessions.mockResolvedValue(2)

    const response = await invokeRoute('post', '/sessions/others/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(sessionRegistryMocks.revokeOtherUserSessions).toHaveBeenCalledWith('user-1', 'session-current', {
      revokedBy: 'user-1',
      reason: 'self-other-sessions-logout',
    })
    expect((response.body as Record<string, any>).data.currentSessionId).toBe('session-current')
    expect((response.body as Record<string, any>).data.revokedCount).toBe(2)
  })

  it('returns 401 when revoking other sessions without token', async () => {
    const response = await invokeRoute('post', '/sessions/others/logout')

    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error).toBe('No token provided')
  })

  it('returns 401 when revoking other sessions with invalid token', async () => {
    authServiceMocks.verifyToken.mockResolvedValue(null)

    const response = await invokeRoute('post', '/sessions/others/logout', {
      headers: {
        authorization: 'Bearer bad-token',
      },
    })

    expect(response.statusCode).toBe(401)
    expect((response.body as Record<string, any>).error).toBe('Invalid token')
    expect(sessionRegistryMocks.revokeOtherUserSessions).not.toHaveBeenCalled()
  })

  it('returns 404 when logging out a specific session that does not exist', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    sessionRegistryMocks.getUserSession.mockResolvedValue(null)

    const response = await invokeRoute('post', '/sessions/:sessionId/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
      params: {
        sessionId: 'missing-session',
      },
    })

    expect(response.statusCode).toBe(404)
    expect((response.body as Record<string, any>).error).toBe('Session not found')
    expect(sessionRegistryMocks.revokeUserSession).not.toHaveBeenCalled()
  })

  it('returns 500 when revoking other sessions throws unexpected error', async () => {
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
    sessionRegistryMocks.revokeOtherUserSessions.mockRejectedValue(new Error('bulk revoke failed'))

    const response = await invokeRoute('post', '/sessions/others/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
  })

  it('returns 500 when reading token payload throws for other sessions logout', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockImplementation(() => {
      throw new Error('payload decode failed')
    })

    const response = await invokeRoute('post', '/sessions/others/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error).toBe('Internal server error')
  })

  it('rejects sessions/others/logout when token has no session id', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'manager@example.com',
      name: 'Manager',
      role: 'user',
      permissions: ['attendance:read'],
    })
    authServiceMocks.readTokenPayload.mockReturnValue({
      sub: 'user-1',
      sid: '',
    })

    const response = await invokeRoute('post', '/sessions/others/logout', {
      headers: {
        authorization: 'Bearer live-token',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error).toBe('Current session is unavailable')
    expect(sessionRegistryMocks.revokeOtherUserSessions).not.toHaveBeenCalled()
  })
})
