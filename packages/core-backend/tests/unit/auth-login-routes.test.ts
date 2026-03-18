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
  listUserSessions: vi.fn(),
  getUserSession: vi.fn(),
  revokeUserSession: vi.fn(),
  touchUserSession: vi.fn(),
  revokeOtherUserSessions: vi.fn(),
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
  listUserSessions: sessionRegistryMocks.listUserSessions,
  getUserSession: sessionRegistryMocks.getUserSession,
  revokeUserSession: sessionRegistryMocks.revokeUserSession,
  touchUserSession: sessionRegistryMocks.touchUserSession,
  revokeOtherUserSessions: sessionRegistryMocks.revokeOtherUserSessions,
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
    sessionRegistryMocks.listUserSessions.mockReset()
    sessionRegistryMocks.getUserSession.mockReset()
    sessionRegistryMocks.revokeUserSession.mockReset()
    sessionRegistryMocks.touchUserSession.mockReset()
    sessionRegistryMocks.revokeOtherUserSessions.mockReset()
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
