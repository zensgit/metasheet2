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

import { isPublicFormAuthBypass, isWhitelisted, jwtAuthMiddleware, optionalJwtAuthMiddleware } from '../../src/auth/jwt-middleware'

describe('jwt auth whitelist', () => {
  it('does not whitelist metrics endpoints anymore', () => {
    expect(isWhitelisted('/metrics')).toBe(false)
    expect(isWhitelisted('/metrics/prom')).toBe(false)
  })

  it('allows DingTalk launch without a bearer token', () => {
    expect(isWhitelisted('/api/auth/dingtalk/launch')).toBe(true)
    expect(isWhitelisted('/api/auth/dingtalk/launch?redirect=%2Fdashboard')).toBe(true)
  })

  it('allows DingTalk callback without a bearer token', () => {
    expect(isWhitelisted('/api/auth/dingtalk/callback')).toBe(true)
  })

  it('allows public form context when a public token is present', () => {
    expect(isPublicFormAuthBypass({
      method: 'GET',
      path: '/api/multitable/form-context',
      query: { publicToken: 'pub_123' },
      body: undefined,
    } as unknown as Request)).toBe(true)
  })

  it('allows public form submission when a public token is present', () => {
    expect(isPublicFormAuthBypass({
      method: 'POST',
      path: '/api/multitable/views/view_public_form/submit',
      query: { publicToken: 'pub_123' },
      body: undefined,
    } as unknown as Request)).toBe(true)
  })

  it('does not allow sibling multitable routes without an exact public form path', () => {
    expect(isPublicFormAuthBypass({
      method: 'GET',
      path: '/api/multitable/views/view_public_form',
      query: { publicToken: 'pub_123' },
      body: undefined,
    } as unknown as Request)).toBe(false)
  })

  it('does not allow public form routes without a token', () => {
    expect(isPublicFormAuthBypass({
      method: 'GET',
      path: '/api/multitable/form-context',
      query: {},
      body: undefined,
    } as unknown as Request)).toBe(false)
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

  it('blocks non-whitelisted API access when the user must change password', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-3',
      email: 'forced@example.com',
      name: 'Forced User',
      role: 'user',
      permissions: ['attendance:read'],
      must_change_password: true,
      created_at: new Date('2026-04-11T00:00:00.000Z'),
      updated_at: new Date('2026-04-11T00:00:00.000Z'),
    })

    const req = {
      path: '/api/admin/users',
      originalUrl: '/api/admin/users',
      headers: {
        authorization: 'Bearer forced-token',
      },
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await jwtAuthMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'PASSWORD_CHANGE_REQUIRED',
      }),
    }))
    expect(next).not.toHaveBeenCalled()
  })

  it('allows whitelisted auth endpoints when the user must change password', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-3',
      email: 'forced@example.com',
      name: 'Forced User',
      role: 'user',
      permissions: ['attendance:read'],
      must_change_password: true,
      created_at: new Date('2026-04-11T00:00:00.000Z'),
      updated_at: new Date('2026-04-11T00:00:00.000Z'),
    })

    const req = {
      path: '/api/auth/me',
      originalUrl: '/api/auth/me',
      headers: {
        authorization: 'Bearer forced-token',
      },
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await jwtAuthMiddleware(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
  })

  it('optionally hydrates the user on public form routes when a bearer token is present', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-4',
      email: 'bound@example.com',
      name: 'Bound User',
      role: 'user',
      permissions: ['multitable:read'],
      created_at: new Date('2026-04-20T00:00:00.000Z'),
      updated_at: new Date('2026-04-20T00:00:00.000Z'),
    })

    const req = {
      path: '/api/multitable/form-context',
      headers: {
        authorization: 'Bearer optional-token',
      },
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await optionalJwtAuthMiddleware(req, res, next)

    expect(req.user).toMatchObject({ id: 'user-4' })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('allows DingTalk protected public-form context when the user must change password', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-5',
      email: 'forced-public-form@example.com',
      name: 'Forced Public Form User',
      role: 'user',
      permissions: ['multitable:read'],
      must_change_password: true,
      created_at: new Date('2026-04-28T00:00:00.000Z'),
      updated_at: new Date('2026-04-28T00:00:00.000Z'),
    })

    const req = {
      method: 'GET',
      path: '/api/multitable/form-context',
      query: { publicToken: 'pub_123' },
      headers: {
        authorization: 'Bearer forced-public-form-token',
      },
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await optionalJwtAuthMiddleware(req, res, next)

    expect(req.user).toMatchObject({ id: 'user-5' })
    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('allows DingTalk protected public-form submit when the user must change password', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-6',
      email: 'forced-public-form-submit@example.com',
      name: 'Forced Public Form Submit User',
      role: 'user',
      permissions: ['multitable:read'],
      must_change_password: true,
      created_at: new Date('2026-04-28T00:00:00.000Z'),
      updated_at: new Date('2026-04-28T00:00:00.000Z'),
    })

    const req = {
      method: 'POST',
      path: '/api/multitable/views/view_form/submit',
      query: {},
      body: { publicToken: 'pub_123', data: { fld_title: 'Alpha' } },
      headers: {
        authorization: 'Bearer forced-public-form-submit-token',
      },
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await optionalJwtAuthMiddleware(req, res, next)

    expect(req.user).toMatchObject({ id: 'user-6' })
    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('still blocks must-change-password users on public form routes without a public token', async () => {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-7',
      email: 'forced-no-token@example.com',
      name: 'Forced No Token User',
      role: 'user',
      permissions: ['multitable:read'],
      must_change_password: true,
      created_at: new Date('2026-04-28T00:00:00.000Z'),
      updated_at: new Date('2026-04-28T00:00:00.000Z'),
    })

    const req = {
      method: 'GET',
      path: '/api/multitable/form-context',
      query: {},
      headers: {
        authorization: 'Bearer forced-no-public-token',
      },
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await optionalJwtAuthMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'PASSWORD_CHANGE_REQUIRED' }),
    }))
    expect(next).not.toHaveBeenCalled()
  })

  it('ignores stale bearer tokens on public form routes so DingTalk re-auth can start', async () => {
    metricsMocks.jwtAuthFail.inc.mockClear()
    metricsMocks.authFailures.inc.mockClear()
    const expiredError = new Error('jwt expired')
    expiredError.name = 'TokenExpiredError'
    authServiceMocks.verifyToken.mockRejectedValue(expiredError)

    const req = {
      method: 'GET',
      path: '/api/multitable/form-context',
      query: { publicToken: 'pub_123' },
      headers: {
        authorization: 'Bearer expired-public-form-token',
      },
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await optionalJwtAuthMiddleware(req, res, next)

    expect(req.user).toBeUndefined()
    expect(res.status).not.toHaveBeenCalled()
    expect(metricsMocks.jwtAuthFail.inc).not.toHaveBeenCalled()
    expect(metricsMocks.authFailures.inc).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('optional public form auth bypass does not fail when no bearer token is present', async () => {
    authServiceMocks.verifyToken.mockReset()
    const req = {
      path: '/api/multitable/form-context',
      headers: {},
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction

    await optionalJwtAuthMiddleware(req, res, next)

    expect(authServiceMocks.verifyToken).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })
})
