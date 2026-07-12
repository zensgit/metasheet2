/**
 * GHSA (AC5) — POST /api/admin/safety/confirm must be platform-admin gated. Confirming a dangerous
 * operation is itself privileged; the rate-limit + idempotency guards it previously carried are
 * throughput controls, not authorization. This asserts requireAdminRole is the FIRST guard on the route.
 *
 * Mirrors admin-snapshot-delete-authz.test.ts (direct guard-handler invocation via initAdminRoutes).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'express'
import { isAdmin } from '../../src/rbac/service'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../src/db/pg', () => ({ pool: null }))
vi.mock('../../src/services/SnapshotService', () => ({}))
vi.mock('../../src/audit/audit', () => ({}))

import { initAdminRoutes } from '../../src/routes/admin-routes'

function firstGuardOf(router: Router, method: 'post', routePath: string) {
  const layer = (router as unknown as {
    stack?: Array<{
      route?: {
        path?: string
        methods?: Record<string, boolean>
        stack?: Array<{ handle: (req: any, res: any, next?: any) => Promise<void> | void }>
      }
    }>
  }).stack?.find((item) => item.route?.path === routePath && item.route?.methods?.[method])
  const stack = layer?.route?.stack ?? []
  if (stack.length === 0) throw new Error(`Route handler not found for ${method.toUpperCase()} ${routePath}`)
  return stack[0]
}

function mockRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

describe('POST /safety/confirm — platform-admin guard first (GHSA AC5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  it('first guard denies a non-admin with 403 and does not call next', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const guard = firstGuardOf(initAdminRoutes(), 'post', '/safety/confirm')
    const res = mockRes()
    const next = vi.fn()
    await guard.handle({ user: { id: 'u-nonadmin' }, ip: '127.0.0.1', path: '/safety/confirm' }, res, next)
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('first guard fails closed with 503 when the RBAC check throws', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac down'))
    const guard = firstGuardOf(initAdminRoutes(), 'post', '/safety/confirm')
    const res = mockRes()
    const next = vi.fn()
    await guard.handle({ user: { id: 'u-x' }, ip: '127.0.0.1', path: '/safety/confirm' }, res, next)
    expect(res.statusCode).toBe(503)
    expect(next).not.toHaveBeenCalled()
  })

  it('first guard passes a platform-admin through to the next handler', async () => {
    const guard = firstGuardOf(initAdminRoutes(), 'post', '/safety/confirm')
    const res = mockRes()
    const next = vi.fn()
    await guard.handle({ user: { id: 'u-admin' }, ip: '127.0.0.1', path: '/safety/confirm' }, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
  })
})
