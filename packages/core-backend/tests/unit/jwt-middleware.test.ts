import type { Request, Response, NextFunction } from 'express'
import { describe, expect, it, vi } from 'vitest'

const authServiceMocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const metricsMocks = vi.hoisted(() => ({
  jwtAuthFail: { inc: vi.fn() },
  authFailures: { inc: vi.fn() },
}))

vi.mock('../../src/auth/AuthService', () => ({
  authService: authServiceMocks,
}))

vi.mock('../../src/metrics/metrics', () => ({
  metrics: metricsMocks,
}))

import { isWhitelisted, jwtAuthMiddleware } from '../../src/auth/jwt-middleware'

describe('jwt auth whitelist', () => {
  it('allows DingTalk launch without a bearer token', () => {
    expect(isWhitelisted('/api/auth/dingtalk/launch')).toBe(true)
    expect(isWhitelisted('/api/auth/dingtalk/launch?redirect=%2Fdashboard')).toBe(true)
  })

  it('allows DingTalk callback without a bearer token', () => {
    expect(isWhitelisted('/api/auth/dingtalk/callback')).toBe(true)
  })
})

describe('jwt auth middleware', () => {
  it('preserves tenantId on authenticated requests', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'tenant-user@example.com',
      name: 'Tenant User',
      role: 'admin',
      permissions: ['*:*'],
      tenantId: 'tenant_42',
      created_at: new Date('2026-04-11T00:00:00.000Z'),
      updated_at: new Date('2026-04-11T00:00:00.000Z'),
    })

    const req = {
      headers: {
        authorization: 'Bearer tenant-token',
      },
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await jwtAuthMiddleware(req, res, next)

    expect(authServiceMocks.verifyToken).toHaveBeenCalledWith('tenant-token')
    expect(req.user).toMatchObject({
      id: 'user-1',
      tenantId: 'tenant_42',
    })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('backfills tenantId from x-tenant-id for legacy tenant-less tokens', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-2',
      email: 'legacy@example.com',
      name: 'Legacy User',
      role: 'admin',
      permissions: ['*:*'],
      created_at: new Date('2026-04-11T00:00:00.000Z'),
      updated_at: new Date('2026-04-11T00:00:00.000Z'),
    })

    const req = {
      headers: {
        authorization: 'Bearer legacy-token',
        'x-tenant-id': 'tenant_legacy',
      },
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await jwtAuthMiddleware(req, res, next)

    expect(req.user).toMatchObject({
      id: 'user-2',
      tenantId: 'tenant_legacy',
    })
    expect(next).toHaveBeenCalledTimes(1)
  })
})
