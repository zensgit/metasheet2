import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authServiceMocks = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  refreshToken: vi.fn(),
  verifyToken: vi.fn(),
  createToken: vi.fn(),
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
    query?: Record<string, unknown>
    body?: Record<string, unknown>
  } = {},
) {
  const layer = authRouter.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: {},
    query: options.query ?? {},
    params: {},
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

describe('auth invite routes', () => {
  beforeEach(() => {
    authServiceMocks.login.mockReset()
    authServiceMocks.register.mockReset()
    authServiceMocks.refreshToken.mockReset()
    authServiceMocks.verifyToken.mockReset()
    authServiceMocks.createToken.mockReset()
    inviteTokenMocks.verifyInviteToken.mockReset()
    pgMocks.query.mockReset()
    bcryptMocks.hash.mockReset()
    bcryptMocks.compare.mockReset()
    sessionMocks.revokeUserSessions.mockReset()
  })

  it('returns invite preview for a valid token', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'alpha@example.com',
        name: 'Alpha',
        is_active: false,
        updated_at: '2026-03-13T00:00:00.000Z',
      }],
    })

    const response = await invokeRoute('get', '/invite/preview', {
      query: { token: 'invite-preview-token' },
    })

    expect(response.statusCode).toBe(200)
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      id: 'user-1',
      email: 'alpha@example.com',
      isActive: false,
    })
    expect((response.body as Record<string, any>).data.onboarding.productMode).toBe('attendance')
    expect(String((response.body as Record<string, any>).data.onboarding.acceptInviteUrl)).toContain('invite-preview-token')
  })

  it('rejects invite acceptance when password policy fails', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })

    const response = await invokeRoute('post', '/invite/accept', {
      body: {
        token: 'invite-accept-token',
        password: 'weak',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error).toBe('Password does not meet requirements')
    expect(pgMocks.query).not.toHaveBeenCalled()
  })

  it('accepts invite, updates password, revokes sessions, and logs the user in', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          is_active: false,
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-accept-token',
          status: 'accepted',
          accepted_at: '2026-03-13T00:05:00.000Z',
          consumed_by: 'user-1',
          last_sent_at: '2026-03-13T00:00:00.000Z',
          created_at: '2026-03-13T00:00:00.000Z',
          updated_at: '2026-03-13T00:05:00.000Z',
        }],
      })
    bcryptMocks.hash.mockResolvedValue('hashed-password')
    sessionMocks.revokeUserSessions.mockResolvedValue({ revokedAfter: '2026-03-13T00:05:00.000Z' })
    authServiceMocks.login.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'alpha@example.com',
        name: 'Alpha User',
        role: 'user',
        permissions: ['attendance:read'],
        created_at: new Date('2026-03-13T00:00:00.000Z'),
        updated_at: new Date('2026-03-13T00:00:00.000Z'),
      },
      token: 'jwt-after-invite',
    })

    const response = await invokeRoute('post', '/invite/accept', {
      body: {
        token: 'invite-accept-token',
        password: 'WelcomePass9A',
        name: 'Alpha User',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(bcryptMocks.hash).toHaveBeenCalledWith('WelcomePass9A', 10)
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE users'),
      ['hashed-password', 'Alpha User', 'user-1', 'alpha@example.com'],
    )
    expect(sessionMocks.revokeUserSessions).toHaveBeenCalledWith('user-1', expect.objectContaining({
      updatedBy: 'user-1',
      reason: 'invite-accepted',
    }))
    expect(authServiceMocks.login).toHaveBeenCalledWith(
      'alpha@example.com',
      'WelcomePass9A',
      expect.objectContaining({
        ipAddress: '127.0.0.1',
      }),
    )
    expect((response.body as Record<string, any>).data.token).toBe('jwt-after-invite')
    expect((response.body as Record<string, any>).data.features.attendance).toBe(true)
    expect((response.body as Record<string, any>).data.onboarding.homePath).toBe('/attendance')
  })
})
