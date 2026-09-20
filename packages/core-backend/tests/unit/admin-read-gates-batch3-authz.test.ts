/**
 * issue #5678 (batch 3) — the last five GET routes under /api/admin that carried NO authorization.
 *
 * Batch 1 (#5710) gated GET /api/admin/dlq; batch 2 (#5884) gated /shards, /shards/:name, /queues,
 * /health/detailed and /health/subsystem/:name — see tests/unit/admin-read-gates-batch2-authz.test.ts,
 * whose skeleton this suite follows. Batch 2 left five residuals; this batch closes all five:
 *
 *   GET /api/admin/safety/status    — is the destructive-operation brake switched on, and how many
 *                                     dangerous operations are sitting unconfirmed right now
 *   GET /api/admin/ratelimits       — the throttle configuration itself (refill rate, burst capacity,
 *                                     idle-reclaim timeout) plus platform-wide accept/reject counters
 *   GET /api/admin/ratelimits/:key  — ANOTHER tenant's bucket: remaining tokens, accepted/rejected
 *                                     counts, and a `not_tracked`-vs-stats existence oracle over
 *                                     caller-chosen keys (`tenant:<id>`, message-rate-limiter.ts:230)
 *   GET /api/admin/health/summary   — the coarse half of the /health pair batch 2 gated: status,
 *                                     uptime, per-status subsystem counts, hasWarnings / hasErrors
 *   GET /api/admin/slo/status       — the platform's reliability posture: per-SLO current
 *                                     availability and error budget (total / consumed / remaining /
 *                                     remaining %) plus the healthy / at_risk / violated verdict
 *
 * Before this change any authenticated user of any tenant, holding no role whatsoever, could read
 * all five. The gate is requireAdminRole() as the FIRST handler on each route, same three-state
 * semantics as batches 1 and 2: no user or non-admin -> 403 ADMIN_REQUIRED; the RBAC lookup throwing
 * -> 503 RBAC_CHECK_FAILED (fail-closed); no database pool -> isAdmin() returns false at
 * rbac/service.ts:20 -> 403, never an open door. See guards/audit-integration.ts:113.
 *
 * GET /slo/status was held back when this suite first landed, because #5680 (open, branched off
 * #5665, not off main) uses that route as its reverse control: "a GET with no admin guard in first
 * position". Its CI runs on that branch, not on this tree, so gating the route here cannot red it;
 * what it does mean is that when #5680 rebases onto main it has to turn that reverse control into a
 * positive one, since there is no longer any ungated GET in admin-routes.ts to point at. The sweep
 * at the bottom of this file is now a closed-world zero assertion, so a route that regresses — or a
 * new ungated GET added later — reds it by name rather than slipping through unremarked.
 *
 * /safety/status is gated at its mount point (admin-routes.ts:97) rather than inside
 * createSafetyStatusEndpoint(): that factory has exactly one call site in the tree, and its body is
 * the fact tests/unit/multitable-sheet-liveness-closure-all-routes.guard.test.ts:951 rests on.
 *
 * These specs go through a real express mount (not direct handler invocation) so they prove the
 * guard is wired into the middleware chain AHEAD of the handler, and every denial case asserts the
 * underlying service was never called: a 403 produced after the stats had already been gathered
 * would leak nothing to the caller but would mean the gate sits in the wrong position.
 *
 * Service doubles are installed with vi.spyOn on the real singletons rather than vi.mock on their
 * modules: the rate limiter, the SafetyGuard and the health aggregator are imported across src/, so
 * replacing those modules wholesale would reach far outside the routes under test. Note the
 * SafetyGuard spies must be installed AFTER the app is built — initAdminRoutes() calls
 * initSafetyGuard(), which destroys and replaces the singleton (admin-routes.ts:2146) — which is why
 * every test mounts through mountApp() instead of calling pinned.setApp() directly.
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
import { getSafetyGuard } from '../../src/guards/SafetyGuard'
import { getRateLimiter } from '../../src/integration/rate-limiting'
import { getHealthAggregator } from '../../src/services/HealthAggregatorService'
import { sloService } from '../../src/services/SLOService'

// Values-free fixtures: synthetic bucket key and counters only, no tenant id, host or credential.
const BUCKET_KEY = 'tenant-fixture-a'
const UNTRACKED_BUCKET_KEY = 'tenant-fixture-not-tracked'

function rateLimiterConfigFixture() {
  return {
    tokensPerSecond: 1000,
    bucketCapacity: 2000,
    enableMetrics: true,
    cleanupIntervalMs: 60000,
    bucketIdleTimeoutMs: 300000,
  }
}

function rateLimiterGlobalStatsFixture() {
  return {
    activeBuckets: 3,
    totalAccepted: 90,
    totalRejected: 10,
    averageTokensRemaining: 12.345,
  }
}

function bucketStatsFixture() {
  return {
    tokensRemaining: 7,
    bucketCapacity: 2000,
    totalAccepted: 90,
    totalRejected: 10,
    acceptanceRate: 0.9,
  }
}

/**
 * Values-free SLO posture: a synthetic indicator id with a budget deliberately most of the way
 * spent, so a leak of this payload would be visible as an `at_risk` verdict in the assertions.
 */
function sloStatusFixture() {
  return [
    {
      id: 'slo-fixture-availability',
      name: 'SLO fixture — availability',
      target: 0.999,
      currentAvailability: 0.9975,
      errorBudget: {
        total: 400,
        consumed: 340,
        remaining: 60,
        remainingPercentage: 15,
      },
      status: 'at_risk' as const,
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

let isEnabledSpy: ReturnType<typeof vi.spyOn>
let pendingCountSpy: ReturnType<typeof vi.spyOn>
let getConfigSpy: ReturnType<typeof vi.spyOn>
let getGlobalStatsSpy: ReturnType<typeof vi.spyOn>
let getBucketStatsSpy: ReturnType<typeof vi.spyOn>
let getLastHealthSpy: ReturnType<typeof vi.spyOn>
let checkHealthSpy: ReturnType<typeof vi.spyOn>
let getSLOStatusSpy: ReturnType<typeof vi.spyOn>

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

/**
 * Mount an app and then spy on the SafetyGuard singleton that initAdminRoutes() just replaced.
 * Spying before the mount would double the pre-init instance and leave the live one untouched.
 */
function mountApp(user?: { id: string; email?: string }): void {
  pinned.setApp(buildApp(user))
  const guard = getSafetyGuard()
  isEnabledSpy = vi.spyOn(guard, 'isEnabled').mockReturnValue(true)
  pendingCountSpy = vi.spyOn(guard, 'getPendingCount').mockReturnValue(2)
}

const pinned = usePinnedServer()

/** Every service a denied caller must not have been able to reach through any of the five routes. */
function expectNoServiceReached() {
  expect(isEnabledSpy).not.toHaveBeenCalled()
  expect(pendingCountSpy).not.toHaveBeenCalled()
  expect(getConfigSpy).not.toHaveBeenCalled()
  expect(getGlobalStatsSpy).not.toHaveBeenCalled()
  expect(getBucketStatsSpy).not.toHaveBeenCalled()
  expect(getLastHealthSpy).not.toHaveBeenCalled()
  expect(checkHealthSpy).not.toHaveBeenCalled()
  expect(getSLOStatusSpy).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isAdmin).mockResolvedValue(true)

  const rateLimiter = getRateLimiter()
  getConfigSpy = vi.spyOn(rateLimiter, 'getConfig').mockReturnValue(rateLimiterConfigFixture())
  getGlobalStatsSpy = vi
    .spyOn(rateLimiter, 'getGlobalStats')
    .mockReturnValue(rateLimiterGlobalStatsFixture())
  getBucketStatsSpy = vi
    .spyOn(rateLimiter, 'getStats')
    .mockImplementation((key: string) => (key === BUCKET_KEY ? bucketStatsFixture() : null))

  const aggregator = getHealthAggregator()
  // Force the fresh-check path so both reads are observable and neither can be served from a
  // cache warmed by another suite.
  getLastHealthSpy = vi.spyOn(aggregator, 'getLastHealth').mockReturnValue(null)
  checkHealthSpy = vi.spyOn(aggregator, 'checkHealth').mockResolvedValue(healthFixture() as never)

  // Memory-level double on the exported singleton admin-routes.ts:29 imports: the real
  // getSLOStatus() reads the process-wide prom-client registry, which other suites also write to.
  getSLOStatusSpy = vi
    .spyOn(sloService, 'getSLOStatus')
    .mockResolvedValue(sloStatusFixture() as never)
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
    label: 'GET /api/admin/safety/status',
    path: '/api/admin/safety/status',
    routePath: '/safety/status',
    expectOk: (body) => {
      expect(body.enabled).toBe(true)
      expect(body.pendingConfirmations).toBe(2)
      expect(isEnabledSpy).toHaveBeenCalledTimes(1)
      expect(pendingCountSpy).toHaveBeenCalledTimes(1)
    },
  },
  {
    label: 'GET /api/admin/ratelimits',
    path: '/api/admin/ratelimits',
    routePath: '/ratelimits',
    expectOk: (body) => {
      expect(body.success).toBe(true)
      // Config passed through unchanged — the gate must not have narrowed the admin payload.
      expect(body.config).toMatchObject({
        tokensPerSecond: 1000,
        bucketCapacity: 2000,
        cleanupIntervalMs: 60000,
        bucketIdleTimeoutMs: 300000,
      })
      expect((body.stats as { activeBuckets: number }).activeBuckets).toBe(3)
      expect(getConfigSpy).toHaveBeenCalledTimes(1)
      expect(getGlobalStatsSpy).toHaveBeenCalledTimes(1)
    },
  },
  {
    label: 'GET /api/admin/ratelimits/:key',
    path: `/api/admin/ratelimits/${BUCKET_KEY}`,
    routePath: '/ratelimits/:key',
    expectOk: (body) => {
      expect(body.success).toBe(true)
      expect(body.key).toBe(BUCKET_KEY)
      expect(body.status).toBe('allowed')
      expect((body.stats as { tokensRemaining: number }).tokensRemaining).toBe(7)
      expect(getBucketStatsSpy).toHaveBeenCalledWith(BUCKET_KEY)
    },
  },
  {
    label: 'GET /api/admin/health/summary',
    path: '/api/admin/health/summary',
    routePath: '/health/summary',
    expectOk: (body) => {
      expect(body.success).toBe(true)
      expect(body.status).toBe('healthy')
      expect(body.uptime).toBe(1000)
      expect(body.hasWarnings).toBe(false)
      expect(body.hasErrors).toBe(false)
      expect(checkHealthSpy).toHaveBeenCalledTimes(1)
    },
  },
  {
    label: 'GET /api/admin/slo/status',
    path: '/api/admin/slo/status',
    routePath: '/slo/status',
    expectOk: (body) => {
      expect(body.success).toBe(true)
      expect(body.count).toBe(1)
      const [first] = body.status as Array<{
        id: string
        status: string
        errorBudget: { remainingPercentage: number }
      }>
      // Budget posture passed through unchanged — the gate must not have narrowed the admin payload.
      expect(first.id).toBe('slo-fixture-availability')
      expect(first.status).toBe('at_risk')
      expect(first.errorBudget.remainingPercentage).toBe(15)
      expect(getSLOStatusSpy).toHaveBeenCalledTimes(1)
    },
  },
]

describe.each(ROUTES)('$label — platform-admin gate (issue #5678 batch 3)', (route) => {
  it('non-admin -> 403 ADMIN_REQUIRED and no operational state is gathered', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    mountApp({ id: 'u-nonadmin' })

    const res = await request(pinned.url()).get(route.path).expect(403)

    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expect(res.body.success).not.toBe(true)
    expectNoServiceReached()
  })

  it('unauthenticated (no req.user) -> 403, nothing gathered', async () => {
    mountApp(undefined)

    const res = await request(pinned.url()).get(route.path).expect(403)

    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expectNoServiceReached()
  })

  it('RBAC lookup throwing -> 503 fail-closed, nothing gathered', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac lookup failed'))
    mountApp({ id: 'u-503' })

    const res = await request(pinned.url()).get(route.path).expect(503)

    expect(res.body.code).toBe('RBAC_CHECK_FAILED')
    expectNoServiceReached()
  })

  it('platform-admin -> 200 and the handler still runs unchanged', async () => {
    mountApp({ id: 'u-admin' })

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
    expect((res.body as { code?: string } | null)?.code).toBe('ADMIN_REQUIRED')
    expect(next).not.toHaveBeenCalled()
  })
})

describe('batch 3 gate — cross-route invariants', () => {
  it('the per-key bucket oracle of /ratelimits/:key is not reachable by a non-admin', async () => {
    // `not_tracked` versus a stats payload used to answer "has this tenant sent anything?" for free,
    // one caller-chosen key at a time. With the guard first, both keys look identical.
    vi.mocked(isAdmin).mockResolvedValue(false)
    mountApp({ id: 'u-nonadmin-oracle' })

    const tracked = await request(pinned.url())
      .get(`/api/admin/ratelimits/${BUCKET_KEY}`)
      .expect(403)
    const untracked = await request(pinned.url())
      .get(`/api/admin/ratelimits/${UNTRACKED_BUCKET_KEY}`)
      .expect(403)

    // Indistinguishable responses: no signal about which key is being throttled.
    expect(tracked.body).toEqual(untracked.body)
    expect(JSON.stringify(tracked.body)).not.toContain('not_tracked')
    expect(getBucketStatsSpy).not.toHaveBeenCalled()
  })

  it('the throttle configuration is not readable by a non-admin', async () => {
    // The refill rate and burst capacity are what let a caller sit one token under the limit.
    vi.mocked(isAdmin).mockResolvedValue(false)
    mountApp({ id: 'u-nonadmin-config' })

    const res = await request(pinned.url()).get('/api/admin/ratelimits').expect(403)

    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('tokensPerSecond')
    expect(serialized).not.toContain('bucketIdleTimeoutMs')
    expect(getConfigSpy).not.toHaveBeenCalled()
  })

  it('the degraded-state flags of /health/summary are not pollable by a non-admin', async () => {
    // hasWarnings / hasErrors were a free "is the platform hurting right now?" channel.
    vi.mocked(isAdmin).mockResolvedValue(false)
    mountApp({ id: 'u-nonadmin-health' })

    const res = await request(pinned.url()).get('/api/admin/health/summary').expect(403)

    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('hasWarnings')
    expect(serialized).not.toContain('hasErrors')
    expect(getLastHealthSpy).not.toHaveBeenCalled()
    expect(checkHealthSpy).not.toHaveBeenCalled()
  })

  it('the error-budget posture of /slo/status is not pollable by a non-admin', async () => {
    // "How much budget is left before the platform breaches its SLO?" was a free oracle for any
    // authenticated caller of any tenant, and it moves in real time.
    vi.mocked(isAdmin).mockResolvedValue(false)
    mountApp({ id: 'u-nonadmin-slo' })

    const res = await request(pinned.url()).get('/api/admin/slo/status').expect(403)

    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('errorBudget')
    expect(serialized).not.toContain('at_risk')
    expect(serialized).not.toContain('remainingPercentage')
    expect(getSLOStatusSpy).not.toHaveBeenCalled()
  })

  it('all five routes are gated — none of them answers a non-admin with 200', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    mountApp({ id: 'u-nonadmin-sweep' })

    for (const route of ROUTES) {
      const res = await request(pinned.url()).get(route.path)
      expect(res.status, `${route.label} answered ${res.status} to a non-admin`).toBe(403)
    }
    expectNoServiceReached()
  })

  it('admin-routes.ts has no ungated GET left at all (closed world)', async () => {
    // Closed-world sweep over the router itself rather than over a hand-written list: every GET
    // layer whose first handler does not deny a non-admin is reported. The list is now empty, and
    // it is the empty list that is pinned — a route that loses its guard, or a new GET added
    // without one, reds this by name instead of slipping in unremarked.
    const router = initAdminRoutes() as unknown as {
      stack?: Array<{
        route?: {
          path?: string
          methods?: Record<string, boolean>
          stack?: Array<{ handle: (req: any, res: any, next?: any) => Promise<void> | void }>
        }
      }>
    }
    vi.mocked(isAdmin).mockResolvedValue(false)

    const ungated: string[] = []
    for (const item of router.stack ?? []) {
      if (!item.route?.methods?.get || !item.route.path) continue
      const first = item.route.stack?.[0]
      if (!first) continue
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
      try {
        await first.handle(
          { user: { id: 'u-nonadmin-closed-world' }, ip: '127.0.0.1', path: item.route.path, params: {}, query: {} },
          res,
          next
        )
      } catch {
        // A first handler that throws on a synthetic request is not a gate either — report it.
      }
      if (res.statusCode !== 403) ungated.push(item.route.path)
    }

    expect(ungated, `ungated GET routes in admin-routes.ts: ${ungated.join(', ')}`).toEqual([])
  })
})
