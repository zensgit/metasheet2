/**
 * ADM-05 follow-up, part 2 — no 500 body anywhere in the /api/admin router tree carries the text of
 * the error that caused it.
 *
 * #5903 closed the 13 read-side GETs of admin-routes.ts itself and deliberately left the rest echoing
 * `err.message`: the write-side branches of admin-routes.ts, and EVERY branch of the two sub-routers
 * admin-routes.ts mounts at its foot — snapshot-labels.ts (`/snapshots`, GET / and three writes) and
 * protection-rules.ts (`/safety/rules`, GET /, GET /:id and four writes). Owner review registered the
 * sub-router GETs as the residual; this suite pins the closure of the whole tree.
 *
 * Three layers, each of which would fail if any single site went back to echoing:
 *
 *   1. REAL EXPRESS PROBE (usePinnedServer + request(pinned.url()), never request(app) — #4154). The
 *      tree is mounted exactly as index.ts mounts it (`app.use('/api/admin', initAdminRoutes(deps))`),
 *      so the sub-routers are reached through their real mount, not imported on their own. For every
 *      one of the 32 branches this change redacts, an admin caller triggers a memory-level double that
 *      throws a driver-shaped error; the body must carry the stable code + fixed string and none of
 *      the fixture's fragments, the double must have been reached (so the 500 is that branch and not
 *      something else), and the original text must have reached logger.error().
 *   2. GATE ORDER: a non-admin caller still gets 403 before the handler runs — the throwing double is
 *      never called. (POST /health/check is ungated BY DESIGN — a permanent exemption registered in
 *      admin-routes-write-endpoints-structural-gate.test.ts — so for it the probe asserts the stronger
 *      thing: a non-admin who reaches its 500 gets the redacted body too.)
 *   3. STRUCTURAL GUARD over the tree's source, discovered by following `router.use(<imported router>)`
 *      from admin-routes.ts, so a sub-router mounted tomorrow is scanned without editing this file.
 *      Any 5xx response whose arguments read `.message` / `.stack`, or reference the caught error or a
 *      local derived from it, is red. Log calls are not sinks and are never flagged.
 *
 * Mutation self-proof is built in and memory-level (no source file is written, so a parallel suite
 * cannot observe a mutant): every responder call site in the tree is rewritten, in memory, back to the
 * pre-change echo and the guard must flag each one; and a live router handler is swapped for the
 * pre-change implementation and the probe's own assertion must fail on it.
 *
 * Values-free fixtures: RFC 5737 TEST-NET-3 documentation address and literal placeholder names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAdmin } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'
import {
  discoverMountedRouterFiles,
  scanResponseErrorEcho,
} from '../utils/response-error-echo-scan'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../src/db/pg', () => ({ pool: null }))
vi.mock('../../src/audit/audit', () => ({}))

// The bulk data routes go through Kysely; replace it with builders whose execute() is controlled per
// test (same shape as admin-bulk-data-sources-fk-409.test.ts).
const kyselyState = vi.hoisted(() => ({ mutationError: null as unknown, execute: vi.fn() }))
vi.mock('../../src/db/kysely', () => {
  const mutation = () => {
    const builder = {
      set: () => builder,
      where: () => builder,
      execute: async () => {
        kyselyState.execute()
        if (kyselyState.mutationError) throw kyselyState.mutationError
        return []
      },
    }
    return builder
  }
  const select = () => {
    const builder = {
      select: () => builder,
      where: () => builder,
      execute: async () => [],
    }
    return builder
  }
  return {
    db: { selectFrom: select, deleteFrom: mutation, updateTable: mutation },
    transaction: vi.fn(),
  }
})

// snapshot-labels.ts reads the module singleton; admin-routes.ts gets its SnapshotService injected.
vi.mock('../../src/services/SnapshotService', () => ({
  snapshotService: {
    addTags: vi.fn(),
    removeTags: vi.fn(),
    setProtectionLevel: vi.fn(),
    setReleaseChannel: vi.fn(),
    getSnapshot: vi.fn(),
    getByTags: vi.fn(),
    getByProtectionLevel: vi.fn(),
    getByReleaseChannel: vi.fn(),
  },
}))

vi.mock('../../src/services/ProtectionRuleService', () => ({
  protectionRuleService: {
    listRules: vi.fn(),
    getRule: vi.fn(),
    createRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    evaluateRules: vi.fn(),
  },
}))

vi.mock('../../src/services/DeadLetterQueueService', () => ({
  dlqService: {
    list: vi.fn(),
    retry: vi.fn(),
    resolve: vi.fn(),
    ignore: vi.fn(),
    cleanup: vi.fn(),
  },
}))

import {
  initAdminRoutes,
  ADMIN_READ_FAILED_CODE,
  ADMIN_READ_FAILED_MESSAGE,
  ADMIN_WRITE_FAILED_CODE,
  ADMIN_WRITE_FAILED_MESSAGE,
} from '../../src/routes/admin-routes'
import { createAdminFailureResponders } from '../../src/routes/admin-failure-envelope'
import { _resetRateLimitForTests } from '../../src/routes/protection-rules'
import { snapshotService } from '../../src/services/SnapshotService'
import { protectionRuleService } from '../../src/services/ProtectionRuleService'
import { dlqService } from '../../src/services/DeadLetterQueueService'
import { getSafetyGuard } from '../../src/guards/SafetyGuard'
import { poolManager } from '../../src/integration/db/connection-pool'
import { getRateLimiter } from '../../src/integration/rate-limiting'
import { getHealthAggregator } from '../../src/services/HealthAggregatorService'
import { cache } from '../../src/cache'
import { Logger } from '../../src/core/logger'

// ── fixtures (values-free) ────────────────────────────────────────────────────

/** Driver-shaped failure text: connection target + auth failure naming a role. Documentation values. */
const LEAKY =
  'connect ECONNREFUSED 203.0.113.9:5432 — password authentication failed for user "fixture-role"'
/** Asserted one by one, so a partial echo (only host:port, only the role) also fails. */
const LEAKY_FRAGMENTS = ['203.0.113.9', '5432', 'fixture-role', 'ECONNREFUSED', 'password']

function leakyError(): Error {
  const err = new Error(LEAKY)
  // pg-shaped (auth failure SQLSTATE) so no branch mistakes it for a schema / unique / FK case.
  ;(err as Error & { code?: string }).code = '28P01'
  return err
}

const ADMIN_USER = { id: 'admin-fixture-1', email: 'admin@fixture.invalid', roles: ['admin'] }
const NON_ADMIN_USER = { id: 'user-fixture-2', email: 'user@fixture.invalid', roles: [] as string[] }

type Doubles = Array<{ mock: { calls: unknown[] } }>

type RouteCase = {
  label: string
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  path: string
  body?: Record<string, unknown>
  expect: 'read' | 'write'
  /** Fields the route returns next to the error, taken from the caller's own path. */
  extra?: Record<string, string>
  /** Gate kind — decides what a non-admin must see. */
  gate: 'requireAdminRole' | 'unsafe-local' | 'none-by-design'
  /** Install exactly the throwing double(s) for this branch; return them to count calls. */
  arm: () => Doubles
}

// Injected services for admin-routes.ts (initAdminRoutes deps). vi.fn()s so each case can arm one.
const injected = {
  pluginLoader: {
    get: vi.fn(),
    getPlugins: vi.fn(),
    getFailedPlugins: vi.fn(),
    reloadPlugin: vi.fn(),
    loadPlugins: vi.fn(),
    unloadPlugin: vi.fn(),
  },
  activatePlugin: vi.fn(),
  deactivatePlugin: vi.fn(),
  snapshotService: {
    restoreSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    cleanupExpired: vi.fn(),
  },
}

function rejectOnce<T extends { mockRejectedValue: (e: unknown) => unknown }>(fn: T): T {
  fn.mockRejectedValue(leakyError())
  return fn
}

/** Every 500 branch this change redacts — 22 writes in admin-routes.ts + 4 + 6 in the sub-routers. */
const CASES: RouteCase[] = [
  // ── admin-routes.ts: write side ──────────────────────────────────────────
  {
    label: 'POST /plugins/:id/enable', method: 'post', path: '/api/admin/plugins/plugin-fixture/enable',
    expect: 'write', extra: { pluginId: 'plugin-fixture' }, gate: 'requireAdminRole',
    arm: () => [rejectOnce(injected.activatePlugin)],
  },
  {
    label: 'POST /plugins/:id/disable', method: 'post', path: '/api/admin/plugins/plugin-fixture/disable',
    expect: 'write', extra: { pluginId: 'plugin-fixture' }, gate: 'requireAdminRole',
    arm: () => [rejectOnce(injected.deactivatePlugin)],
  },
  {
    label: 'PUT /plugins/:id/config', method: 'put', path: '/api/admin/plugins/plugin-fixture/config',
    body: { config: { flag: true } }, expect: 'write', extra: { pluginId: 'plugin-fixture' }, gate: 'requireAdminRole',
    arm: () => [vi.spyOn(poolManager, 'get').mockImplementation(() => { throw leakyError() })],
  },
  {
    label: 'POST /plugins/:id/reload', method: 'post', path: '/api/admin/plugins/plugin-fixture/reload',
    expect: 'write', extra: { pluginId: 'plugin-fixture' }, gate: 'requireAdminRole',
    arm: () => [rejectOnce(injected.pluginLoader.reloadPlugin)],
  },
  {
    label: 'POST /plugins/reload-all', method: 'post', path: '/api/admin/plugins/reload-all',
    expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(injected.pluginLoader.loadPlugins)],
  },
  {
    label: 'POST /plugins/reload-all-unsafe', method: 'post', path: '/api/admin/plugins/reload-all-unsafe',
    expect: 'write', gate: 'unsafe-local',
    arm: () => [rejectOnce(injected.pluginLoader.loadPlugins)],
  },
  {
    label: 'POST /plugins/:id/reload-unsafe', method: 'post', path: '/api/admin/plugins/plugin-fixture/reload-unsafe',
    expect: 'write', gate: 'unsafe-local',
    arm: () => [rejectOnce(injected.pluginLoader.reloadPlugin)],
  },
  {
    label: 'DELETE /plugins/:id', method: 'delete', path: '/api/admin/plugins/plugin-fixture',
    expect: 'write', extra: { pluginId: 'plugin-fixture' }, gate: 'requireAdminRole',
    arm: () => [rejectOnce(injected.pluginLoader.unloadPlugin)],
  },
  {
    label: 'POST /snapshots/:id/restore', method: 'post', path: '/api/admin/snapshots/snap-fixture/restore',
    body: {}, expect: 'write', extra: { snapshotId: 'snap-fixture' }, gate: 'requireAdminRole',
    arm: () => [rejectOnce(injected.snapshotService.restoreSnapshot)],
  },
  {
    label: 'DELETE /snapshots/:id', method: 'delete', path: '/api/admin/snapshots/snap-fixture',
    expect: 'write', extra: { snapshotId: 'snap-fixture' }, gate: 'requireAdminRole',
    arm: () => [rejectOnce(injected.snapshotService.deleteSnapshot)],
  },
  {
    label: 'POST /snapshots/cleanup', method: 'post', path: '/api/admin/snapshots/cleanup',
    body: {}, expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(injected.snapshotService.cleanupExpired)],
  },
  {
    label: 'POST /cache/clear', method: 'post', path: '/api/admin/cache/clear',
    expect: 'write', gate: 'requireAdminRole',
    arm: () => [vi.spyOn(cache, 'getCurrentImplementation').mockImplementation(() => { throw leakyError() })],
  },
  {
    label: 'POST /metrics/reset', method: 'post', path: '/api/admin/metrics/reset',
    expect: 'write', gate: 'requireAdminRole',
    // The try block holds only a log line; make exactly that line throw (and count only that call).
    arm: () => {
      const hit = vi.fn()
      vi.spyOn(Logger.prototype, 'info').mockImplementation(function (this: Logger, message: string) {
        if (message === 'Metrics reset completed') {
          hit()
          throw leakyError()
        }
      })
      return [hit]
    },
  },
  {
    label: 'DELETE /data/bulk', method: 'delete', path: '/api/admin/data/bulk',
    body: { table: 'tables', filters: { id: 'tbl-fixture' } }, expect: 'write', gate: 'requireAdminRole',
    arm: () => {
      kyselyState.mutationError = leakyError()
      return [kyselyState.execute]
    },
  },
  {
    label: 'PUT /data/bulk', method: 'put', path: '/api/admin/data/bulk',
    body: { table: 'tables', updates: { name: 'x' }, filters: { id: 'tbl-fixture' } }, expect: 'write', gate: 'requireAdminRole',
    arm: () => {
      kyselyState.mutationError = leakyError()
      return [kyselyState.execute]
    },
  },
  {
    label: 'POST /dlq/:id/retry', method: 'post', path: '/api/admin/dlq/dlq-fixture/retry',
    expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(dlqService.retry))],
  },
  {
    label: 'DELETE /dlq/:id', method: 'delete', path: '/api/admin/dlq/dlq-fixture',
    expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(dlqService.resolve))],
  },
  {
    label: 'POST /dlq/retry-all', method: 'post', path: '/api/admin/dlq/retry-all',
    body: {}, expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(dlqService.list))],
  },
  {
    label: 'POST /dlq/cleanup', method: 'post', path: '/api/admin/dlq/cleanup',
    body: {}, expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(dlqService.cleanup))],
  },
  {
    label: 'POST /ratelimits/:key/reset', method: 'post', path: '/api/admin/ratelimits/bucket-fixture/reset',
    expect: 'write', gate: 'requireAdminRole',
    arm: () => [vi.spyOn(getRateLimiter(), 'reset').mockImplementation(() => { throw leakyError() })],
  },
  {
    label: 'POST /ratelimits/reset-all', method: 'post', path: '/api/admin/ratelimits/reset-all',
    expect: 'write', gate: 'requireAdminRole',
    arm: () => [vi.spyOn(getRateLimiter(), 'resetAll').mockImplementation(() => { throw leakyError() })],
  },
  {
    label: 'POST /health/check', method: 'post', path: '/api/admin/health/check',
    expect: 'write', gate: 'none-by-design',
    arm: () => [vi.spyOn(getHealthAggregator(), 'checkHealth').mockRejectedValue(leakyError())],
  },
  // ── snapshot-labels.ts (mounted at /api/admin/snapshots) ──────────────────
  {
    label: 'GET /snapshots (snapshot-labels)', method: 'get', path: '/api/admin/snapshots?tags=tag-fixture',
    expect: 'read', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(snapshotService.getByTags))],
  },
  {
    label: 'PUT /snapshots/:id/tags (snapshot-labels)', method: 'put', path: '/api/admin/snapshots/snap-fixture/tags',
    body: { add: ['tag-fixture'] }, expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(snapshotService.addTags))],
  },
  {
    label: 'PATCH /snapshots/:id/protection (snapshot-labels)', method: 'patch', path: '/api/admin/snapshots/snap-fixture/protection',
    body: { level: 'protected' }, expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(snapshotService.setProtectionLevel))],
  },
  {
    label: 'PATCH /snapshots/:id/release-channel (snapshot-labels)', method: 'patch', path: '/api/admin/snapshots/snap-fixture/release-channel',
    body: { channel: 'stable' }, expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(snapshotService.setReleaseChannel))],
  },
  // ── protection-rules.ts (mounted at /api/admin/safety/rules) ──────────────
  {
    label: 'GET /safety/rules (protection-rules)', method: 'get', path: '/api/admin/safety/rules',
    expect: 'read', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(protectionRuleService.listRules))],
  },
  {
    label: 'GET /safety/rules/:id (protection-rules)', method: 'get', path: '/api/admin/safety/rules/rule-fixture',
    expect: 'read', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(protectionRuleService.getRule))],
  },
  {
    label: 'POST /safety/rules (protection-rules)', method: 'post', path: '/api/admin/safety/rules',
    body: {
      rule_name: 'rule-fixture',
      target_type: 'snapshot',
      conditions: { protection_level: 'critical' },
      effects: { action: 'block' },
    },
    expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(protectionRuleService.createRule))],
  },
  {
    label: 'PATCH /safety/rules/:id (protection-rules)', method: 'patch', path: '/api/admin/safety/rules/rule-fixture',
    body: { priority: 5 }, expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(protectionRuleService.updateRule))],
  },
  {
    label: 'DELETE /safety/rules/:id (protection-rules)', method: 'delete', path: '/api/admin/safety/rules/rule-fixture',
    expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(protectionRuleService.deleteRule))],
  },
  {
    label: 'POST /safety/rules/evaluate (protection-rules)', method: 'post', path: '/api/admin/safety/rules/evaluate',
    body: { entity_type: 'snapshot', entity_id: 'snap-fixture', operation: 'delete' },
    expect: 'write', gate: 'requireAdminRole',
    arm: () => [rejectOnce(vi.mocked(protectionRuleService.evaluateRules))],
  },
]

// ── app ───────────────────────────────────────────────────────────────────────

let currentUser: typeof ADMIN_USER | typeof NON_ADMIN_USER = ADMIN_USER
let currentRouter: express.Router
let errorLog: ReturnType<typeof vi.spyOn>

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as Request & { user?: unknown }).user = currentUser
    next()
  })
  currentRouter = initAdminRoutes(injected as never)
  app.use('/api/admin', currentRouter)
  return app
}

const pinned = usePinnedServer()

function resetInjected(): void {
  injected.pluginLoader.get.mockReturnValue(undefined)
  injected.pluginLoader.getPlugins.mockReturnValue(new Map())
  injected.pluginLoader.getFailedPlugins.mockReturnValue(new Map())
  injected.pluginLoader.reloadPlugin.mockResolvedValue(undefined)
  injected.pluginLoader.loadPlugins.mockResolvedValue([])
  injected.pluginLoader.unloadPlugin.mockResolvedValue(undefined)
  injected.activatePlugin.mockResolvedValue({ status: 'active' })
  injected.deactivatePlugin.mockResolvedValue({ status: 'inactive' })
  injected.snapshotService.restoreSnapshot.mockResolvedValue({})
  injected.snapshotService.deleteSnapshot.mockResolvedValue(true)
  injected.snapshotService.cleanupExpired.mockResolvedValue({ deleted: 0, freed: 0 })
}

beforeEach(() => {
  vi.clearAllMocks()
  // vi.restoreAllMocks() in afterEach strips factory implementations; re-arm the benign defaults.
  vi.mocked(isAdmin).mockResolvedValue(true)
  vi.mocked(dlqService.list).mockResolvedValue({ items: [], total: 0 } as never)
  resetInjected()
  kyselyState.mutationError = null
  _resetRateLimitForTests()
  currentUser = ADMIN_USER
  pinned.setApp(buildApp())
  // Neutralise the SafetyGuard the mount just re-created (requireSafetyCheck resolves the singleton
  // per request), so the write routes behind a confirmation step reach their handler.
  vi.spyOn(getSafetyGuard(), 'checkOperation').mockResolvedValue({
    allowed: true,
    assessment: {
      riskLevel: 'low',
      requiresConfirmation: false,
      requiresDoubleConfirm: false,
      riskDescription: 'test double',
      safeguards: [],
      impact: {},
    },
  } as never)
  // Record (and silence) server-side error logs: the original text must land HERE, not in the body.
  errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function send(c: RouteCase) {
  const agent = request(pinned.url())
  const req = agent[c.method](c.path)
  return c.body ? req.send(c.body) : req
}

function totalCalls(doubles: Doubles): number {
  return doubles.reduce((sum, d) => sum + d.mock.calls.length, 0)
}

/** The whole body contract of a redacted 500, in one helper. */
function expectRedacted(status: number, body: Record<string, unknown>, kind: 'read' | 'write'): void {
  expect(status).toBe(500)
  expect(body.success).toBe(false)
  expect(body.code).toBe(kind === 'read' ? ADMIN_READ_FAILED_CODE : ADMIN_WRITE_FAILED_CODE)
  expect(body.error).toBe(kind === 'read' ? ADMIN_READ_FAILED_MESSAGE : ADMIN_WRITE_FAILED_MESSAGE)
  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain(LEAKY)
  for (const fragment of LEAKY_FRAGMENTS) expect(serialized).not.toContain(fragment)
  // No stack either.
  expect(serialized).not.toContain('at Object')
  expect(serialized).not.toContain('.ts:')
}

function loggedOriginal(): boolean {
  return errorLog.mock.calls.some((call) => {
    const err = call[1] as { message?: unknown } | undefined
    return typeof err?.message === 'string' && err.message.includes(LEAKY)
  })
}

// ── 1. real express probe: admin caller, every redacted branch ────────────────

describe('admin caller: every 500 branch in the /api/admin tree is values-free', () => {
  it('the probe covers 32 branches: 22 writes in admin-routes.ts, 4 in snapshot-labels.ts, 6 in protection-rules.ts', () => {
    expect(CASES).toHaveLength(32)
    expect(CASES.filter((c) => c.label.includes('(snapshot-labels)'))).toHaveLength(4)
    expect(CASES.filter((c) => c.label.includes('(protection-rules)'))).toHaveLength(6)
  })

  for (const c of CASES) {
    it(`${c.label} -> 500 ${c.expect === 'read' ? 'ADMIN_READ_FAILED' : 'ADMIN_WRITE_FAILED'}, no driver text, original logged`, async () => {
      if (c.gate === 'unsafe-local') vi.stubEnv('ALLOW_UNSAFE_ADMIN', 'true')
      const doubles = c.arm()
      const res = await send(c)

      expectRedacted(res.status, res.body as Record<string, unknown>, c.expect)
      // The 500 is THIS branch: the throwing double was reached.
      expect(totalCalls(doubles)).toBeGreaterThan(0)
      // Caller-supplied path context the route already returned is kept.
      for (const [key, value] of Object.entries(c.extra ?? {})) expect(res.body[key]).toBe(value)
      // ...and the original text went to the server log.
      expect(loggedOriginal()).toBe(true)
    })
  }

  it('a thrown NON-Error (a bare string) is redacted too, and still reaches the log as text', async () => {
    vi.mocked(protectionRuleService.listRules).mockRejectedValue(LEAKY)
    const res = await request(pinned.url()).get('/api/admin/safety/rules')
    expectRedacted(res.status, res.body as Record<string, unknown>, 'read')
    expect(loggedOriginal()).toBe(true)
  })

  it('#5903 read side is unchanged: a GET in admin-routes.ts still answers ADMIN_READ_FAILED', async () => {
    vi.spyOn(getHealthAggregator(), 'checkHealth').mockRejectedValue(leakyError())
    const res = await request(pinned.url()).get('/api/admin/health/detailed')
    expectRedacted(res.status, res.body as Record<string, unknown>, 'read')
  })
})

// ── 2. gate order: a non-admin never reaches the throwing double ──────────────

describe('non-admin caller: the gate still answers first and the handler is never reached', () => {
  for (const c of CASES) {
    if (c.gate === 'none-by-design') {
      it(`${c.label} is ungated by design — a non-admin reaching its 500 gets the redacted body`, async () => {
        vi.mocked(isAdmin).mockResolvedValue(false)
        currentUser = NON_ADMIN_USER
        const doubles = c.arm()
        const res = await send(c)
        expect(totalCalls(doubles)).toBeGreaterThan(0)
        expectRedacted(res.status, res.body as Record<string, unknown>, c.expect)
      })
      continue
    }
    it(`${c.label} -> 403, throwing double not called`, async () => {
      vi.mocked(isAdmin).mockResolvedValue(false)
      currentUser = NON_ADMIN_USER
      // The unsafe helpers have their own gate (env flag + roles); open the env flag so the ROLE check
      // is what answers — the stricter case.
      if (c.gate === 'unsafe-local') vi.stubEnv('ALLOW_UNSAFE_ADMIN', 'true')
      const doubles = c.arm()
      const res = await send(c)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('ADMIN_REQUIRED')
      expect(totalCalls(doubles)).toBe(0)
      expect(JSON.stringify(res.body)).not.toContain('203.0.113.9')
    })
  }
})

// ── responder contract ────────────────────────────────────────────────────────

describe('failure responders: fixed fields cannot be overridden by `extra`', () => {
  it('extra carrying success/code/error keys loses to the fixed values', async () => {
    const log = { error: vi.fn() }
    const { sendAdminWriteFailure } = createAdminFailureResponders(log)
    const app = express()
    app.get('/probe', (_req, res) => {
      sendAdminWriteFailure(res, 'probe context', leakyError(), {
        success: true,
        code: 'OVERRIDE',
        error: LEAKY,
        pluginId: 'plugin-fixture',
      })
    })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/probe')
    expectRedacted(res.status, res.body as Record<string, unknown>, 'write')
    expect(res.body.pluginId).toBe('plugin-fixture')
    expect(log.error).toHaveBeenCalledTimes(1)
    expect((log.error.mock.calls[0][1] as Error).message).toBe(LEAKY)
  })

  it('the fixed messages are values-free', () => {
    for (const message of [ADMIN_READ_FAILED_MESSAGE, ADMIN_WRITE_FAILED_MESSAGE]) {
      for (const fragment of [...LEAKY_FRAGMENTS, 'postgres', 'redis', 'Error', '/', '\\']) {
        expect(message).not.toContain(fragment)
      }
    }
    expect(ADMIN_READ_FAILED_CODE).toBe('ADMIN_READ_FAILED')
    expect(ADMIN_WRITE_FAILED_CODE).toBe('ADMIN_WRITE_FAILED')
  })
})

// ── probe-side mutation control (memory-level) ────────────────────────────────

type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }
  regexp?: RegExp
  handle?: { stack?: RouteLayer[] }
}

function findRouteLayer(stack: RouteLayer[], routePath: string, method: string): RouteLayer | undefined {
  return stack.find((l) => l.route?.path === routePath && l.route.methods[method])
}

describe('mutation control: the probe fails on the pre-change implementation', () => {
  async function withSwappedHandler(
    layer: RouteLayer | undefined,
    mutant: (req: Request, res: Response, next: NextFunction) => unknown,
    run: () => Promise<void>
  ): Promise<void> {
    expect(layer?.route).toBeDefined()
    const handlers = layer!.route!.stack
    const last = handlers[handlers.length - 1]
    const original = last.handle
    last.handle = mutant
    try {
      await run()
    } finally {
      last.handle = original
    }
  }

  it('sub-router: GET /safety/rules restored to `error: (error as Error).message` is caught', async () => {
    // Reach the protection-rules router THROUGH the admin tree's own mount stack.
    const mount = (currentRouter as unknown as { stack: RouteLayer[] }).stack.find(
      (l) => l.handle?.stack && findRouteLayer(l.handle.stack, '/evaluate', 'post')
    )
    const layer = findRouteLayer(mount!.handle!.stack!, '/', 'get')
    await withSwappedHandler(
      layer,
      async (_req, res) => {
        try {
          await protectionRuleService.listRules({})
        } catch (error) {
          res.status(500).json({ success: false, error: (error as Error).message })
        }
      },
      async () => {
        vi.mocked(protectionRuleService.listRules).mockRejectedValue(leakyError())
        const res = await request(pinned.url()).get('/api/admin/safety/rules')
        expect(JSON.stringify(res.body)).toContain('203.0.113.9')
        expect(() => expectRedacted(res.status, res.body as Record<string, unknown>, 'read')).toThrow()
      }
    )
  })

  it('write side: POST /health/check restored to `error: err.message` is caught', async () => {
    const layer = findRouteLayer((currentRouter as unknown as { stack: RouteLayer[] }).stack, '/health/check', 'post')
    await withSwappedHandler(
      layer,
      async (_req, res) => {
        try {
          await getHealthAggregator().checkHealth()
          res.json({ success: true })
        } catch (error) {
          const err = error as Error
          res.status(500).json({ success: false, error: err.message })
        }
      },
      async () => {
        vi.spyOn(getHealthAggregator(), 'checkHealth').mockRejectedValue(leakyError())
        const res = await request(pinned.url()).post('/api/admin/health/check')
        expect(JSON.stringify(res.body)).toContain('203.0.113.9')
        expect(() => expectRedacted(res.status, res.body as Record<string, unknown>, 'write')).toThrow()
      }
    )
  })
})

// ── 3. structural guard over the mounted tree ─────────────────────────────────

const ROUTES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes')
const readRoute = (rel: string) => fs.readFileSync(path.join(ROUTES_DIR, rel), 'utf-8')
const resolveRel = (from: string, spec: string) => {
  const abs = path.resolve(path.dirname(path.join(ROUTES_DIR, from)), spec)
  return path.relative(ROUTES_DIR, abs).split(path.sep).join('/') + '.ts'
}
const ENVELOPE = 'admin-failure-envelope.ts'

function treeFiles(): string[] {
  return [...discoverMountedRouterFiles('admin-routes.ts', readRoute, resolveRel), ENVELOPE]
}

describe('structural guard: no 5xx response in the /api/admin tree carries caught-error text', () => {
  it('discovers the tree by following router.use(<imported router>) from admin-routes.ts', () => {
    const files = treeFiles()
    for (const expected of ['admin-routes.ts', 'snapshot-labels.ts', 'protection-rules.ts', ENVELOPE]) {
      expect(files).toContain(expected)
    }
  })

  it('zero offenders across every discovered file', () => {
    const offenders = treeFiles().flatMap((rel) => scanResponseErrorEcho(rel, readRoute(rel)).offenders)
    expect(offenders).toEqual([])
  })

  it('is not vacuous: it sees the 5xx sinks and all 45 responder calls (13 + 22 + 4 + 6)', () => {
    const scans = treeFiles().map((rel) => scanResponseErrorEcho(rel, readRoute(rel)))
    const sinks = scans.flatMap((s) => s.sinks)
    const calls = scans.flatMap((s) => s.responderCalls)
    // The 503 "service not available" bodies and the envelope's own 500 are real sinks it inspects.
    expect(sinks.filter((s) => s.kind === 'status-chain').length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.file === 'admin-routes.ts').length).toBeGreaterThanOrEqual(35)
    expect(calls.filter((c) => c.file === 'snapshot-labels.ts').length).toBeGreaterThanOrEqual(4)
    expect(calls.filter((c) => c.file === 'protection-rules.ts').length).toBeGreaterThanOrEqual(6)
  })

  it('scanner self-check: flags echoes, ignores log calls, 4xx and fixed text', () => {
    const flagged = (body: string) =>
      scanResponseErrorEcho('probe.ts', `async function h(req, res) { try { await x() } catch (error) { ${body} } }`).offenders.length
    // flagged
    expect(flagged(`res.status(500).json({ success: false, error: (error as Error).message })`)).toBe(1)
    expect(flagged(`const err = error as Error; res.status(500).json({ error: err.message })`)).toBe(1)
    expect(flagged(`res.status(500).json({ error: String(error) })`)).toBe(1)
    expect(flagged('res.status(500).json({ error: `failed: ${error}` })')).toBe(1)
    expect(flagged(`const m = String(error); res.status(502).send(m)`)).toBe(1)
    expect(flagged(`const { message } = error as Error; res.status(500).json({ error: message })`)).toBe(1)
    expect(flagged(`res.status(500).json({ error: (error as Error).stack })`)).toBe(1)
    expect(flagged(`res.status(500).json({ error })`)).toBe(1)
    expect(flagged(`res.status(code).json({ error: (error as Error).message })`)).toBe(1)
    expect(flagged(`res.status(500).set('x', 'y').json({ error: (error as Error).message })`)).toBe(1)
    expect(flagged(`return jsonError(res, 500, 'X_FAILED', (error as Error)?.message || 'fallback')`)).toBe(1)
    expect(flagged(`sendAdminWriteFailure(res, 'ctx', error, { detail: (error as Error).message })`)).toBe(1)
    // not flagged
    expect(flagged(`logger.error(\`failed: \${(error as Error).message}\`, error as Error); res.status(500).json({ error: 'fixed' })`)).toBe(0)
    expect(flagged(`res.status(400).json({ error: (error as Error).message })`)).toBe(0)
    expect(flagged(`res.status(503).json({ success: false, error: 'Service not available' })`)).toBe(0)
    expect(flagged(`sendAdminWriteFailure(res, 'ctx', error, { pluginId: req.params.id })`)).toBe(0)
    expect(flagged(`res.json({ error: (error as Error).message })`)).toBe(0)
  })

  it('mutation self-proof: restoring the echo at ANY responder call site in the tree is flagged', () => {
    let total = 0
    let caught = 0
    const missed: string[] = []
    for (const rel of treeFiles()) {
      const source = readRoute(rel)
      for (const call of scanResponseErrorEcho(rel, source).responderCalls) {
        const errVar = call.catchVar ?? 'error'
        const variants = [
          `res.status(500).json({ success: false, error: (${errVar} as Error).message })`,
          `res.status(500).json({ success: false, error: String(${errVar}) })`,
          `${call.name}(res, 'ctx', ${errVar}, { detail: (${errVar} as Error).message })`,
        ]
        for (const variant of variants) {
          total += 1
          const mutated = source.slice(0, call.start) + variant + source.slice(call.end)
          const offenders = scanResponseErrorEcho(rel, mutated).offenders
          if (offenders.length > 0) caught += 1
          else missed.push(`${rel}:${call.line} <- ${variant}`)
        }
      }
    }
    expect(missed).toEqual([])
    expect(caught).toBe(total)
    expect(total).toBeGreaterThanOrEqual(45 * 3)
  })
})
