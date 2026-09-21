/**
 * issue #5678 (batch 2) — five more GET routes under /api/admin carried NO authorization at all.
 *
 * Batch 1 (#5710) gated GET /api/admin/dlq; see tests/unit/admin-dlq-read-authz.test.ts, whose
 * skeleton this suite follows. The five routes covered here are the remaining ungated reads that
 * return platform-level (not tenant-level) operational state:
 *
 *   GET /api/admin/shards                   — every database pool's name, status, live/idle/waiting
 *                                             connection counts and last driver error string
 *   GET /api/admin/shards/:name             — the same for one pool, plus a 404-vs-200 existence
 *                                             oracle over shard names
 *   GET /api/admin/queues                   — MessageBus depth/subscription counts plus DLQ totals
 *                                             read from the untenanted `dead_letter_queue` table
 *   GET /api/admin/health/detailed          — full per-subsystem health incl. raw warnings/errors
 *   GET /api/admin/health/subsystem/:name   — one subsystem's detail, plus the valid-name whitelist
 *                                             echoed by the 400 branch
 *
 * Before this change any authenticated user of any tenant, holding no role whatsoever, could read
 * all five. The gate is requireAdminRole() as the FIRST handler on each route, which gives the same
 * three-state semantics as batch 1: no user or non-admin -> 403 ADMIN_REQUIRED; the RBAC lookup
 * throwing -> 503 RBAC_CHECK_FAILED (fail-closed); and no database pool -> isAdmin() returns false
 * at rbac/service.ts:20 -> 403, never an open door. See guards/audit-integration.ts:113.
 *
 * Deliberately NOT in this batch (tracked as residuals, not oversights — see the design note
 * docs/development/admin-read-gates-batch2-design-20260920.md): GET /slo/status, GET /safety/status,
 * GET /ratelimits, GET /ratelimits/:key and GET /health/summary. On this tree those are exactly the
 * GET routes left in admin-routes.ts with no guard in first position; each is held back for its own
 * reason (an in-flight change over /slo/status, a shared endpoint factory for /safety/status, and an
 * ops-consumer question for the /ratelimits* and /health/summary counters).
 *
 * UPDATE (batch 3, issue #5678): all five are now gated — see
 * tests/unit/admin-read-gates-batch3-authz.test.ts, which also answers the ops-consumer question
 * with a repo-wide grep. It additionally gated a SIXTH read that this batch's inventory missed,
 * GET /api/admin/snapshots (snapshot-labels.ts:145): it is contributed by a sub-router mounted with
 * router.use() at admin-routes.ts:2142, so neither the hand inventory nor a sweep over top-level
 * route layers could see it. GET /slo/status went last, once it was established that #5680 (which used
 * it as a reverse control) runs its CI on a branch off #5665 rather than on main; batch 3's
 * closed-world sweep now pins the empty list. The paragraph above describes the tree as it stood
 * when THIS batch landed, and is kept for that record.
 *
 * These specs go through a real express mount (not direct handler invocation) so they prove the
 * guard is wired into the middleware chain AHEAD of the handler, and every denial case asserts the
 * underlying service was never called: a 403 produced after the stats had already been gathered
 * would leak nothing to the caller but would mean the gate sits in the wrong position.
 *
 * Service doubles are installed with vi.spyOn on the real singletons rather than vi.mock on their
 * modules: connection-pool and message-bus are imported by a large part of src/, so replacing the
 * modules wholesale would reach far outside the routes under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    retry: vi.fn().mockResolvedValue(true),
    resolve: vi.fn().mockResolvedValue(undefined),
    ignore: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(0),
  },
}))

import { initAdminRoutes } from '../../src/routes/admin-routes'
import { dlqService } from '../../src/services/DeadLetterQueueService'
import { poolManager } from '../../src/integration/db/connection-pool'
import { messageBus } from '../../src/integration/messaging/message-bus'
import { getHealthAggregator } from '../../src/services/HealthAggregatorService'

// Values-free fixtures: synthetic shard/subsystem names only, no host, credential or tenant id.
const SHARD_NAME = 'shard-fixture-a'

function shardStatsFixture() {
  return [
    {
      name: SHARD_NAME,
      status: 'healthy' as const,
      totalConnections: 4,
      idleConnections: 3,
      waitingClients: 0,
      error: undefined,
    },
  ]
}

function healthFixture() {
  return {
    status: 'healthy',
    timestamp: '2026-09-20T00:00:00.000Z',
    uptime: 1000,
    subsystems: {
      database: { status: 'healthy' },
      messageBus: { status: 'healthy' },
      plugins: { status: 'healthy' },
      rateLimiting: { status: 'healthy' },
      system: { status: 'healthy' },
    },
    summary: {
      totalSubsystems: 5,
      healthySubsystems: 5,
      degradedSubsystems: 0,
      unhealthySubsystems: 0,
      overallHealthPercent: 100,
    },
    warnings: [],
    errors: [],
  }
}

let getPoolStatsSpy: ReturnType<typeof vi.spyOn>
let getMetricsSnapshotSpy: ReturnType<typeof vi.spyOn>
let getStatsSpy: ReturnType<typeof vi.spyOn>
let checkHealthSpy: ReturnType<typeof vi.spyOn>

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

/** Every service a denied caller must not have been able to reach through any of the five routes. */
function expectNoServiceReached() {
  expect(getPoolStatsSpy).not.toHaveBeenCalled()
  expect(getStatsSpy).not.toHaveBeenCalled()
  expect(checkHealthSpy).not.toHaveBeenCalled()
  expect(dlqService.list).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isAdmin).mockResolvedValue(true)

  getPoolStatsSpy = vi
    .spyOn(poolManager, 'getPoolStats')
    .mockResolvedValue(shardStatsFixture() as never)
  getMetricsSnapshotSpy = vi
    .spyOn(poolManager, 'getMetricsSnapshot')
    .mockReturnValue({ acquires: 1 } as never)
  getStatsSpy = vi.spyOn(messageBus, 'getStats').mockReturnValue({
    queueLength: 0,
    exactSubscriptions: 1,
    patternSubscriptions: 2,
    pendingRpcCount: 0,
    usePatternTrie: false,
  } as never)
  checkHealthSpy = vi
    .spyOn(getHealthAggregator(), 'checkHealth')
    .mockResolvedValue(healthFixture() as never)
  vi.mocked(dlqService.list).mockResolvedValue({ items: [], total: 3 } as never)
})

afterEach(() => {
  // Memory-level doubles only: hand the real singletons back so no other suite inherits them.
  vi.restoreAllMocks()
})

/**
 * The five routes under test, each with the request that exercises it and the assertion that its
 * success payload really did come from the gated handler.
 */
const ROUTES: Array<{
  label: string
  path: string
  /** Guard-position lookup key inside the express router stack. */
  routePath: string
  expectOk: (body: Record<string, unknown>) => void
}> = [
  {
    label: 'GET /api/admin/shards',
    path: '/api/admin/shards',
    routePath: '/shards',
    expectOk: (body) => {
      expect(body.success).toBe(true)
      expect((body.summary as { totalShards: number }).totalShards).toBe(1)
      expect(getPoolStatsSpy).toHaveBeenCalledTimes(1)
      expect(getMetricsSnapshotSpy).toHaveBeenCalledTimes(1)
    },
  },
  {
    label: 'GET /api/admin/shards/:name',
    path: `/api/admin/shards/${SHARD_NAME}`,
    routePath: '/shards/:name',
    expectOk: (body) => {
      expect(body.success).toBe(true)
      expect((body.shard as { name: string }).name).toBe(SHARD_NAME)
      expect(getPoolStatsSpy).toHaveBeenCalledTimes(1)
    },
  },
  {
    label: 'GET /api/admin/queues',
    path: '/api/admin/queues',
    routePath: '/queues',
    expectOk: (body) => {
      expect(body.success).toBe(true)
      // pending + retrying + resolved, three dlqService.list() calls at total=3 each.
      expect((body.deadLetterQueue as { total: number }).total).toBe(9)
      expect(getStatsSpy).toHaveBeenCalledTimes(1)
      expect(dlqService.list).toHaveBeenCalledTimes(3)
    },
  },
  {
    label: 'GET /api/admin/health/detailed',
    path: '/api/admin/health/detailed',
    routePath: '/health/detailed',
    expectOk: (body) => {
      expect(body.success).toBe(true)
      expect(body.subsystems).toBeDefined()
      expect(checkHealthSpy).toHaveBeenCalledTimes(1)
    },
  },
  {
    label: 'GET /api/admin/health/subsystem/:name',
    path: '/api/admin/health/subsystem/database',
    routePath: '/health/subsystem/:name',
    expectOk: (body) => {
      expect(body.success).toBe(true)
      expect(body.subsystem).toBeDefined()
      expect(checkHealthSpy).toHaveBeenCalledTimes(1)
    },
  },
]

describe.each(ROUTES)('$label — platform-admin gate (issue #5678 batch 2)', (route) => {
  it('non-admin -> 403 ADMIN_REQUIRED and no operational state is gathered', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    pinned.setApp(buildApp({ id: 'u-nonadmin' }))

    const res = await request(pinned.url()).get(route.path).expect(403)

    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expect(res.body.success).not.toBe(true)
    expectNoServiceReached()
  })

  it('unauthenticated (no req.user) -> 403, nothing gathered', async () => {
    pinned.setApp(buildApp(undefined))

    const res = await request(pinned.url()).get(route.path).expect(403)

    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expectNoServiceReached()
  })

  it('RBAC lookup throwing -> 503 fail-closed, nothing gathered', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac lookup failed'))
    pinned.setApp(buildApp({ id: 'u-503' }))

    const res = await request(pinned.url()).get(route.path).expect(503)

    expect(res.body.code).toBe('RBAC_CHECK_FAILED')
    expectNoServiceReached()
  })

  it('platform-admin -> 200 and the handler still runs unchanged', async () => {
    pinned.setApp(buildApp({ id: 'u-admin' }))

    const res = await request(pinned.url()).get(route.path).expect(200)

    route.expectOk(res.body as Record<string, unknown>)
  })

  it('the gate is the FIRST handler on the route, not something after the read', async () => {
    // Structural backstop for the behavioural specs above: if someone re-orders the stack so the
    // handler runs before the guard, the 403 would arrive after the state had already been read.
    // Asserting position 0 pins the ordering itself.
    const router = initAdminRoutes() as unknown as {
      stack?: Array<{
        route?: {
          path?: string
          methods?: Record<string, boolean>
          stack?: Array<{ handle: (req: any, res: any, next?: any) => Promise<void> | void }>
        }
      }>
    }
    const layer = router.stack?.find(
      (item) => item.route?.path === route.routePath && item.route?.methods?.get
    )
    expect(layer, `no GET layer found for ${route.routePath}`).toBeDefined()
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
    await stack[0]?.handle(
      { user: { id: 'u-nonadmin-structural' }, ip: '127.0.0.1', path: route.routePath },
      res,
      next
    )
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('batch 2 gate — cross-route invariants', () => {
  it('the 400 whitelist of /health/subsystem/:name is not readable by a non-admin', async () => {
    // The ungated handler answered an invalid name with the list of valid subsystem names. With the
    // guard first, a denied caller gets ADMIN_REQUIRED instead of that map.
    vi.mocked(isAdmin).mockResolvedValue(false)
    pinned.setApp(buildApp({ id: 'u-nonadmin-whitelist' }))

    const res = await request(pinned.url())
      .get('/api/admin/health/subsystem/not-a-subsystem')
      .expect(403)

    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expect(JSON.stringify(res.body)).not.toContain('messageBus')
    expect(checkHealthSpy).not.toHaveBeenCalled()
  })

  it('the shard existence oracle of /shards/:name is not reachable by a non-admin', async () => {
    // 404-vs-200 on an unknown name used to answer "does this shard exist?" for free.
    vi.mocked(isAdmin).mockResolvedValue(false)
    pinned.setApp(buildApp({ id: 'u-nonadmin-oracle' }))

    const known = await request(pinned.url()).get(`/api/admin/shards/${SHARD_NAME}`).expect(403)
    const unknown = await request(pinned.url())
      .get('/api/admin/shards/shard-fixture-does-not-exist')
      .expect(403)

    // Indistinguishable responses: no signal about which name exists.
    expect(known.body).toEqual(unknown.body)
    expect(getPoolStatsSpy).not.toHaveBeenCalled()
  })

  it('all five routes are gated — none of them answers a non-admin with 200', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    pinned.setApp(buildApp({ id: 'u-nonadmin-sweep' }))

    for (const route of ROUTES) {
      const res = await request(pinned.url()).get(route.path)
      expect(res.status, `${route.label} answered ${res.status} to a non-admin`).toBe(403)
    }
    expectNoServiceReached()
  })
})
