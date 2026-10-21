/**
 * issue #5678 (batch 1) — GET /api/admin/dlq carried NO authorization at all.
 *
 * Why that is a platform-wide read, not a tenant one: the handler delegates to
 * dlqService.list(), which selects from the `dead_letter_queue` table (see
 * services/DeadLetterQueueService.ts:151 — `db.selectFrom('dead_letter_queue')`). That table has no
 * tenant_id column and the query applies no tenant predicate, so the rows returned are every failed
 * message on the platform, including the `payload` of each one. Any authenticated user — of any
 * tenant, with no role at all — could page through them.
 *
 * The gate is now requireAdminRole() as the FIRST handler on the route: no user -> 403
 * ADMIN_REQUIRED; non-admin -> 403; RBAC lookup throwing -> 503 fail-closed (see
 * guards/audit-integration.ts:113 and rbac/service.ts). The sibling write endpoints
 * (POST /dlq/:id/retry, DELETE /dlq/:id, POST /dlq/retry-all, POST /dlq/cleanup) already carried
 * guards and are untouched by this change.
 *
 * These specs go through a real express mount (not direct handler invocation) so they prove the
 * guard is wired into the middleware chain AHEAD of the handler, and they assert dlqService.list was
 * never called on a denial — a 403 that still ran the query would have leaked nothing to the caller
 * but would mean the gate sits in the wrong place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { isAdmin } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../src/db/pg', () => ({ pool: null }))
vi.mock('../../src/services/SnapshotService', () => ({}))
vi.mock('../../src/audit/audit', () => ({}))

vi.mock('../../src/services/DeadLetterQueueService', () => ({
  dlqService: {
    // Values-free stand-in: no real payload, host or key ever appears in this suite.
    list: vi.fn().mockResolvedValue({ items: [{ id: 'dlq-1', topic: 't', status: 'pending' }], total: 1 }),
    retry: vi.fn().mockResolvedValue(true),
    resolve: vi.fn().mockResolvedValue(undefined),
    ignore: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(0),
  },
}))

import { initAdminRoutes } from '../../src/routes/admin-routes'
import { dlqService } from '../../src/services/DeadLetterQueueService'

function buildApp(user?: { id: string; email?: string }): Express {
  const app = express()
  app.use(express.json())
  if (user) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string; email?: string } }).user = user
      next()
    })
  }
  // Same mount base as src/index.ts (app.use('/api/admin', adminRoutes)).
  app.use('/api/admin', initAdminRoutes())
  return app
}

const pinned = usePinnedServer()

describe('GET /api/admin/dlq — platform-admin gate (issue #5678 batch 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  it('non-admin -> 403 ADMIN_REQUIRED and the DLQ is never queried', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    pinned.setApp(buildApp({ id: 'u-nonadmin' }))

    const res = await request(pinned.url()).get('/api/admin/dlq').expect(403)

    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expect(res.body.items).toBeUndefined()
    expect(dlqService.list).not.toHaveBeenCalled()
  })

  it('non-admin cannot reach the DLQ through query filters either', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    pinned.setApp(buildApp({ id: 'u-nonadmin2' }))

    await request(pinned.url())
      .get('/api/admin/dlq')
      .query({ status: 'pending', topic: 't', limit: '100', offset: '0' })
      .expect(403)

    expect(dlqService.list).not.toHaveBeenCalled()
  })

  it('unauthenticated (no req.user) -> 403, DLQ never queried', async () => {
    pinned.setApp(buildApp(undefined))

    const res = await request(pinned.url()).get('/api/admin/dlq').expect(403)

    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expect(dlqService.list).not.toHaveBeenCalled()
  })

  it('RBAC lookup throwing -> 503 fail-closed, DLQ never queried', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac lookup failed'))
    pinned.setApp(buildApp({ id: 'u-503' }))

    const res = await request(pinned.url()).get('/api/admin/dlq').expect(503)

    expect(res.body.code).toBe('RBAC_CHECK_FAILED')
    expect(dlqService.list).not.toHaveBeenCalled()
  })

  it('platform-admin -> 200 and the listing still reaches the service unchanged', async () => {
    pinned.setApp(buildApp({ id: 'u-admin' }))

    const res = await request(pinned.url())
      .get('/api/admin/dlq')
      .query({ status: 'pending', limit: '5' })
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.total).toBe(1)
    expect(dlqService.list).toHaveBeenCalledTimes(1)
    expect(vi.mocked(dlqService.list).mock.calls[0][0]).toMatchObject({ status: 'pending', limit: 5 })
  })

  it('the gate is the FIRST handler on the route, not something after the query', async () => {
    // Structural backstop for the behavioural specs above: if someone re-orders the stack so the
    // handler runs before the guard, the 403 would arrive after dead_letter_queue had already been
    // read. Asserting position 0 pins the ordering itself.
    const router = initAdminRoutes() as unknown as {
      stack?: Array<{
        route?: {
          path?: string
          methods?: Record<string, boolean>
          stack?: Array<{ handle: (req: any, res: any, next?: any) => Promise<void> | void }>
        }
      }>
    }
    const layer = router.stack?.find((item) => item.route?.path === '/dlq' && item.route?.methods?.get)
    const stack = layer?.route?.stack ?? []
    expect(stack.length).toBeGreaterThanOrEqual(2)

    vi.mocked(isAdmin).mockResolvedValue(false)
    const res = {
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
    const next = vi.fn()
    await stack[0]?.handle({ user: { id: 'u-nonadmin3' }, ip: '127.0.0.1', path: '/dlq' }, res, next)
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })
})
