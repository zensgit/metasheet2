import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'

const authMocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const metricsMocks = vi.hoisted(() => ({
  jwtAuthFail: { inc: vi.fn() },
  authFailures: { inc: vi.fn() },
}))

vi.mock('../../src/auth/AuthService', () => ({
  authService: authMocks,
}))

vi.mock('../../src/metrics/metrics', () => ({
  metrics: metricsMocks,
}))

vi.mock('../../src/core/logger', () => ({
  Logger: class {
    warn() {}
    error() {}
  },
}))

import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'

function createResponse() {
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

describe('jwtAuthMiddleware', () => {
  beforeEach(() => {
    authMocks.verifyToken.mockReset()
    metricsMocks.jwtAuthFail.inc.mockReset()
    metricsMocks.authFailures.inc.mockReset()
  })

  it('rejects requests without bearer token', async () => {
    const req = { headers: {} } as Request
    const res = createResponse()
    const next = vi.fn() as NextFunction

    await jwtAuthMiddleware(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(metricsMocks.jwtAuthFail.inc).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('attaches authenticated user to request', async () => {
    const req = { headers: { authorization: 'Bearer valid-token' } } as unknown as Request
    const res = createResponse()
    const next = vi.fn() as NextFunction
    authMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'admin',
      permissions: ['admin:all'],
    })

    await jwtAuthMiddleware(req, res, next)

    expect(authMocks.verifyToken).toHaveBeenCalledWith('valid-token')
    expect(req.user).toMatchObject({ id: 'user-1', email: 'user@example.com' })
    expect(next).toHaveBeenCalled()
  })

  it('rejects invalid tokens returned by auth service', async () => {
    const req = { headers: { authorization: 'Bearer invalid-token' } } as unknown as Request
    const res = createResponse()
    const next = vi.fn() as NextFunction
    authMocks.verifyToken.mockResolvedValue(null)

    await jwtAuthMiddleware(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(metricsMocks.jwtAuthFail.inc).toHaveBeenCalledWith({ reason: 'invalid_token' })
    expect(next).not.toHaveBeenCalled()
  })
})
