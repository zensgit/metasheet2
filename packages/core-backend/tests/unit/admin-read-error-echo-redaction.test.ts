/**
 * ADM-05 follow-up — the read-side 500 branches of /api/admin no longer echo driver error text.
 *
 * Batch 2 (#5884) and batch 3 (#5897) put requireAdminRole() in front of these GETs and recorded,
 * in the route comments themselves (admin-routes.ts, the /health/summary note), that redacting the
 * 500 body was "a separate decision point ... deliberately not folded into" the gating change. This
 * suite is the closure of that decision point.
 *
 * What the change guarantees, and what this suite proves route by route: when the handler of a
 * read-side GET throws, the HTTP body carries a STABLE CODE and a FIXED string and nothing else —
 * no driver text, no host, no port, no role name, no stack. The real error still reaches
 * logger.error() so the operator loses nothing; it just stops travelling on the wire, where it
 * would otherwise land in browser devtools, proxy/CDN access logs, pasted screenshots and any ops
 * dashboard that renders `error` verbatim.
 *
 * Coverage: ALL THIRTEEN read-side GETs in admin-routes.ts that have a 500 branch —
 *   /plugins, /plugins/:id, /plugins/:id/config, /slo/status, /dlq, /shards, /shards/:name,
 *   /queues, /ratelimits, /ratelimits/:key, /health/detailed, /health/summary,
 *   /health/subsystem/:name
 * The write-side (POST/PUT/DELETE) echoes were OUT OF SCOPE for #5903 and were pinned as residuals
 * by the sweep at the bottom of this file; the follow-up that redacted them (and the two sub-routers)
 * tightened that sweep to every method — see admin-tree-5xx-values-free.test.ts for that coverage.
 *
 * Values-free fixtures: the "leaky" error text uses an RFC 5737 TEST-NET-3 documentation address and
 * a literal placeholder role/password. No real host, tenant, credential or path appears anywhere in
 * this file, and none is needed — the assertion is that the body does not contain the fixture, so
 * the fixture only has to be recognizable, not real.
 *
 * Doubles are installed with vi.spyOn on the real singletons (pool manager, message bus, rate
 * limiter, SLO service, health aggregator) rather than vi.mock on their modules: those modules are
 * imported across src/, so replacing them wholesale would reach far outside the routes under test.
 * Every spy is memory-level and handed back in afterEach; nothing is written to disk, and no real
 * database, Redis or socket is contacted (poolManager.get / getPoolStats are replaced BEFORE the
 * first request, so the throwing double is what the handler meets).
 *
 * Transport is usePinnedServer() + request(pinned.url()), never request(app) — see #4154.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    retry: vi.fn().mockResolvedValue(true),
    resolve: vi.fn().mockResolvedValue(undefined),
    ignore: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(0),
  },
}))

import {
  initAdminRoutes,
  ADMIN_READ_FAILED_CODE,
  ADMIN_READ_FAILED_MESSAGE,
} from '../../src/routes/admin-routes'
import { dlqService } from '../../src/services/DeadLetterQueueService'
import { poolManager } from '../../src/integration/db/connection-pool'
import { messageBus } from '../../src/integration/messaging/message-bus'
import { getRateLimiter } from '../../src/integration/rate-limiting'
import { sloService } from '../../src/services/SLOService'
import { getHealthAggregator } from '../../src/services/HealthAggregatorService'

/**
 * The text a real driver failure would carry into the 500 body before this change: a connection
 * target plus an authentication failure naming the role. RFC 5737 documentation address, literal
 * placeholder role/password — nothing here is or resembles a real deployment value.
 */
const LEAKY =
  'connect ECONNREFUSED 203.0.113.9:5432 — password authentication failed for user "fixture-role"'

/** Fragments asserted individually so a partial echo (e.g. only the host:port) also fails. */
const LEAKY_FRAGMENTS = ['203.0.113.9', '5432', 'fixture-role', 'ECONNREFUSED', 'password']

const ADMIN_USER = { id: 'admin-fixture-1', email: 'admin@fixture.invalid' }

function leakyError(): Error {
  const err = new Error(LEAKY)
  // Shape it like a pg error so nothing in the chain mistakes it for a schema/graceful-degrade case.
  ;(err as Error & { code?: string }).code = '28P01'
  return err
}

let currentRouter: express.Router

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as Request & { user?: typeof ADMIN_USER }).user = ADMIN_USER
    next()
  })
  currentRouter = initAdminRoutes()
  app.use('/api/admin', currentRouter)
  return app
}

const pinned = usePinnedServer()

/**
 * Every read-side GET with a 500 branch, paired with the memory-level double that forces that
 * branch. `arm()` runs after the app is mounted and installs exactly one throwing double.
 */
const READ_ROUTES: Array<{ label: string; path: string; arm: () => void }> = [
  {
    label: 'GET /api/admin/plugins',
    path: '/api/admin/plugins',
    // loadPluginRegistry() -> poolManager.get(); a non-schema error is rethrown (admin-routes.ts
    // isDatabaseSchemaError branch), so it lands in the route's catch.
    arm: () => {
      vi.spyOn(poolManager, 'get').mockImplementation(() => {
        throw leakyError()
      })
    },
  },
  {
    label: 'GET /api/admin/plugins/:id',
    path: '/api/admin/plugins/plugin-fixture',
    arm: () => {
      vi.spyOn(poolManager, 'get').mockImplementation(() => {
        throw leakyError()
      })
    },
  },
  {
    label: 'GET /api/admin/plugins/:id/config',
    path: '/api/admin/plugins/plugin-fixture/config',
    arm: () => {
      vi.spyOn(poolManager, 'get').mockImplementation(() => {
        throw leakyError()
      })
    },
  },
  {
    label: 'GET /api/admin/slo/status',
    path: '/api/admin/slo/status',
    arm: () => {
      vi.spyOn(sloService, 'getSLOStatus').mockRejectedValue(leakyError())
    },
  },
  {
    label: 'GET /api/admin/dlq',
    path: '/api/admin/dlq',
    arm: () => {
      vi.mocked(dlqService.list).mockRejectedValue(leakyError())
    },
  },
  {
    label: 'GET /api/admin/shards',
    path: '/api/admin/shards',
    arm: () => {
      vi.spyOn(poolManager, 'getPoolStats').mockRejectedValue(leakyError())
    },
  },
  {
    label: 'GET /api/admin/shards/:name',
    path: '/api/admin/shards/shard-fixture',
    arm: () => {
      vi.spyOn(poolManager, 'getPoolStats').mockRejectedValue(leakyError())
    },
  },
  {
    label: 'GET /api/admin/queues',
    path: '/api/admin/queues',
    arm: () => {
      vi.spyOn(messageBus, 'getStats').mockImplementation(() => {
        throw leakyError()
      })
    },
  },
  {
    label: 'GET /api/admin/ratelimits',
    path: '/api/admin/ratelimits',
    arm: () => {
      vi.spyOn(getRateLimiter(), 'getGlobalStats').mockImplementation(() => {
        throw leakyError()
      })
    },
  },
  {
    label: 'GET /api/admin/ratelimits/:key',
    path: '/api/admin/ratelimits/bucket-fixture',
    arm: () => {
      vi.spyOn(getRateLimiter(), 'getStats').mockImplementation(() => {
        throw leakyError()
      })
    },
  },
  {
    label: 'GET /api/admin/health/detailed',
    path: '/api/admin/health/detailed',
    arm: () => {
      vi.spyOn(getHealthAggregator(), 'checkHealth').mockRejectedValue(leakyError())
    },
  },
  {
    label: 'GET /api/admin/health/summary',
    path: '/api/admin/health/summary',
    arm: () => {
      // Force the fresh-check path: a cache warmed elsewhere would short-circuit the failure.
      vi.spyOn(getHealthAggregator(), 'getLastHealth').mockReturnValue(null)
      vi.spyOn(getHealthAggregator(), 'checkHealth').mockRejectedValue(leakyError())
    },
  },
  {
    label: 'GET /api/admin/health/subsystem/:name',
    path: '/api/admin/health/subsystem/database',
    arm: () => {
      vi.spyOn(getHealthAggregator(), 'checkHealth').mockRejectedValue(leakyError())
    },
  },
]

/** The whole contract of this change, in one assertion helper. */
function expectRedacted(status: number, body: Record<string, unknown>): void {
  expect(status).toBe(500)
  expect(body.success).toBe(false)
  expect(body.code).toBe(ADMIN_READ_FAILED_CODE)
  expect(body.error).toBe(ADMIN_READ_FAILED_MESSAGE)

  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain(LEAKY)
  for (const fragment of LEAKY_FRAGMENTS) {
    expect(serialized).not.toContain(fragment)
  }
  // No stack ever travels either.
  expect(serialized).not.toContain('at Object')
  expect(serialized).not.toContain('.ts:')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isAdmin).mockResolvedValue(true)
  vi.mocked(dlqService.list).mockResolvedValue({ items: [], total: 0 } as never)
  pinned.setApp(buildApp())
})

afterEach(() => {
  // Memory-level doubles only: hand the real singletons back so no other suite inherits them.
  vi.restoreAllMocks()
})

describe('admin read-side 500 bodies carry a stable code, never the driver error text', () => {
  for (const route of READ_ROUTES) {
    it(`${route.label} redacts the failure`, async () => {
      route.arm()
      const res = await request(pinned.url()).get(route.path)
      expectRedacted(res.status, res.body as Record<string, unknown>)
    })
  }

  it('the status code semantics are unchanged: the redacted branch is still 500, not 4xx', async () => {
    READ_ROUTES[10].arm() // /health/detailed
    const res = await request(pinned.url()).get(READ_ROUTES[10].path)
    expect(res.status).toBe(500)
  })

  it('caller-supplied path context is preserved where the route already returned it', async () => {
    // /plugins/:id and /plugins/:id/config echoed `pluginId` next to the error. That value came
    // from the caller's own URL, carries nothing about the server, and ops tooling keys on it — so
    // redaction must not drop it.
    vi.spyOn(poolManager, 'get').mockImplementation(() => {
      throw leakyError()
    })
    const res = await request(pinned.url()).get('/api/admin/plugins/plugin-fixture/config')
    expectRedacted(res.status, res.body as Record<string, unknown>)
    expect(res.body.pluginId).toBe('plugin-fixture')
  })

  it('the fixed message is values-free: it names no host, port, role, driver or path', () => {
    for (const fragment of [...LEAKY_FRAGMENTS, 'postgres', 'redis', 'Error', '/', '\\']) {
      expect(ADMIN_READ_FAILED_MESSAGE).not.toContain(fragment)
    }
    expect(ADMIN_READ_FAILED_CODE).toBe('ADMIN_READ_FAILED')
  })
})

describe('mutation control (memory-level)', () => {
  /**
   * Proof that the assertions above have teeth: swap ONE route's handler, in the live express
   * router stack and in memory only, for the exact pre-change implementation
   * (`res.status(500).json({ success: false, error: err.message })`) and show the same assertions
   * now fail. Nothing is written to disk and the stack is restored in the same test, so a parallel
   * suite cannot observe the mutant.
   */
  it('restoring `error: err.message` on /health/detailed makes the redaction assertion fail', async () => {
    type RouteLayer = {
      route?: { path: string; stack: Array<{ handle: unknown }> }
    }
    const stack = (currentRouter as unknown as { stack: RouteLayer[] }).stack
    const layer = stack.find((l) => l.route?.path === '/health/detailed')
    expect(layer?.route).toBeDefined()
    const handlers = layer!.route!.stack
    const last = handlers[handlers.length - 1]
    const original = last.handle

    last.handle = async (_req: Request, res: Response, _next: NextFunction) => {
      try {
        await getHealthAggregator().checkHealth()
        res.json({ success: true })
      } catch (error) {
        const err = error as Error
        res.status(500).json({ success: false, error: err.message })
      }
    }

    try {
      vi.spyOn(getHealthAggregator(), 'checkHealth').mockRejectedValue(leakyError())
      const res = await request(pinned.url()).get('/api/admin/health/detailed')
      expect(res.status).toBe(500)
      // The mutant leaks — which is precisely what the real route must not do.
      expect(JSON.stringify(res.body)).toContain('203.0.113.9')
      expect(() =>
        expectRedacted(res.status, res.body as Record<string, unknown>)
      ).toThrow()
    } finally {
      last.handle = original
    }
  })
})

describe('residual sweep: no route in admin-routes.ts echoes err.message', () => {
  /**
   * When this suite landed (#5903) the write-side (POST/PUT/DELETE) branches still serialized
   * err.message, and this sweep only asserted that no GET did. The follow-up that redacted the write
   * side and the two sub-routers (see admin-tree-5xx-values-free.test.ts, which holds the AST-based
   * guard over the whole mounted tree) tightened this line-level sweep to every method: it is a
   * second, independent mechanism for the same fact, kept because it is cheap and cannot share a bug
   * with the AST scanner.
   */
  it('no route of any method in admin-routes.ts echoes err.message any more', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const source = fs.readFileSync(
      path.resolve(here, '../../src/routes/admin-routes.ts'),
      'utf-8'
    )
    const lines = source.split('\n')

    const routeStarts: Array<{ line: number; method: string }> = []
    lines.forEach((line, idx) => {
      const m = /^router\.(get|post|put|delete|patch)\(/.exec(line)
      if (m) routeStarts.push({ line: idx + 1, method: m[1].toUpperCase() })
    })

    const offenders: string[] = []
    lines.forEach((line, idx) => {
      if (!/error: (err|\(error as Error\))\.message/.test(line)) return
      const lineNo = idx + 1
      const owner = [...routeStarts].reverse().find((r) => r.line < lineNo)
      offenders.push(`admin-routes.ts:${lineNo} (${owner?.method ?? 'no route'})`)
    })

    expect(routeStarts.length).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})
