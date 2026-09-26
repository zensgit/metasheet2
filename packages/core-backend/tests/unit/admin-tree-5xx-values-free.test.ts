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
 *      so the sub-routers are reached through their real mount, not imported on their own, and
 *      index.ts's global error middleware (`correlationErrorHandler`, installed after all routes) is
 *      mounted after it in its non-production mode — the mode in which it copies an unhandled error's
 *      text into the body's `message`. For every one of the 32 catch branches this change redacts,
 *      plus the 4 synchronous handlers that had no catch at all (GET /safety/status, POST
 *      /safety/enable, POST /safety/disable, GET /plugins/health — their throw used to reach that
 *      middleware), an admin caller triggers a memory-level double that throws a driver-shaped
 *      error; the body must carry the stable code + fixed string and none of the fixture's
 *      fragments, the double must have been reached (so the 500 is that branch and not something
 *      else), the original text must have reached logger.error(), and the global middleware must not
 *      have been reached.
 *   2. GATE ORDER: a non-admin caller still gets 403 before the handler runs — the throwing double is
 *      never called. (POST /health/check is ungated BY DESIGN — a permanent exemption registered in
 *      admin-routes-write-endpoints-structural-gate.test.ts — so for it the probe asserts the stronger
 *      thing: a non-admin who reaches its 500 gets the redacted body too.)
 *   3. STRUCTURAL GUARD over the tree's source (tests/utils/response-error-echo-scan.ts, TypeScript AST
 *      + checker symbols). The file set is discovered from admin-routes.ts: every `.use(...)`
 *      argument, and every Router argument of a route method called on a router
 *      (`router.get(path, gate, sub)`, `router.all(path, sub)`, `router.route(path).post(sub)`), is
 *      resolved back to a module — an imported binding or namespace member, a factory call on one, a
 *      local alias / later assignment / destructure of one, a conditional, an array, an in-file
 *      function's `return`, a relative `import()` / `require()` — and so is a router module that such
 *      an argument reaches only THROUGH a function: an inline closure or same-file function it is or
 *      calls, whose body refers to a binding that resolves to a module which itself calls `Router()`
 *      (`(req, res, next) => sub(req, res, next)`). Two runtime checks back the static walk up, and
 *      each covers only what it says:
 *        - LIVE IDENTITY cross-check: every router OBJECT that is itself a handle in the live mounted
 *          stack, at any depth — a `.use()` layer's handle or a handler inside a route layer
 *          (`layer.route.stack`) — must be a Router exported by a discovered module (in-place
 *          `Router()` mounts have no export and are only counted — there are none in the tree
 *          today). Such a router mounted tomorrow in a way the walk cannot follow is not such an
 *          export, so that assertion turns red instead of the router silently leaving the scan. (The
 *          earlier count-only comparison could be cancelled by a static mount that is off at runtime.)
 *          A router that is only CALLED from inside a function layer is not a handle anywhere in the
 *          stack: this check cannot see it.
 *        - USE-LEVEL REGISTRATION: every `.use()`-level function layer (not a router, not a route) in
 *          the live tree, as `<module>:<function name>`, must be in REGISTERED_USE_LEVEL_FUNCTIONS
 *          (today only protection-rules.ts's rate limiter). A closure or wrapper passed to `.use()`
 *          that calls a sub-router is such a layer, so it turns red until looked at. It compares
 *          NAMES: a wrapper that reuses a registered name in the same module is not told apart.
 *      NOT covered by either runtime check, and by the static walk only as described above: a router
 *      called from inside a ROUTE handler (`router.get(p, (req, res, next) => sub(req, res, next))`)
 *      when the static rule cannot resolve it (a router passed in as a parameter, read out of a
 *      container, handed to a wrapper defined in another module, or re-exported through a barrel
 *      module). For that shape there is no guarantee, for routes that exist today or new ones.
 *      In the discovered files, any 5xx response — `.status(S)` chained, set earlier on the same
 *      receiver (compared on the receiver's root: `res.status(S); res.json(…)`, `res.statusCode = S`,
 *      `res.status(S); res.set(…).json(…)`, `const r = res; res.status(S); r.json(…)`), `jsonError`,
 *      a responder's `extra` — whose arguments read `.message` / `.stack` or reference a TAINTED symbol
 *      is red. Taint starts at the caught error (also `.catch` / `.then(_, cb)` / `'error'` listener
 *      callbacks, and the first parameter of every 4-arity function, as Express decides error
 *      middleware by arity) and follows declarations, assignments (`x = …`, `obj.p = …`),
 *      Object.assign, container writes (push / unshift / splice / Map.set / Set.add), `for…of`
 *      bindings, array callbacks, closure capture, and arguments into same-file helpers' parameters
 *      (functions, and members of same-file objects and classes). Log calls are not sinks and are
 *      never flagged. What the scanner does NOT model (helpers or handlers in another module,
 *      `this.m()` / instance methods, a status set in another non-enclosing function,
 *      `.call`/`.apply`, computed member names, text built only inside a function's return, error
 *      values that do not come from the listed sources, headers, `next(err)`) is listed in its
 *      header; for the routes that exist today those shapes are pinned by layer 1's runtime probes,
 *      not by this layer, and for a NEW route this layer guarantees only the listed shapes.
 *
 * Mutation self-proof is built in and memory-level (no source file is written, so a parallel suite
 * cannot observe a mutant): every responder call site in the tree is rewritten, in memory, into each
 * of twelve echo shapes (chained `.message` / `String()`, responder `extra`, assignment-derived local,
 * property-assigned body, split status, `statusCode =`, same-file helper, `for…of` binding, Map
 * container, split status through a receiver alias, split status with a chained body) and the guard
 * must flag every site under every shape; the live-stack cross-check must fail when a router the
 * walk did not find is mounted — with `.use()` or as a route handler — also when a switched-off
 * static mount keeps the COUNTS equal; the use-level registration must fail on a closure-wrapped
 * mount; the discovery, run on the real tree's source with a foreign echoing router mounted in
 * memory as a route handler or through a closure, must reach it and its echo; and a live router
 * handler is swapped for the pre-change implementation and the probe's own assertion must fail on it.
 *
 * Values-free fixtures: RFC 5737 TEST-NET-3 documentation address and literal placeholder names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAdmin } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'
import {
  discoverMountedRouterTree,
  scanResponseErrorEcho,
  type ResponderCall,
  type RouterTree,
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
import { createSafetyStatusEndpoint } from '../../src/guards/middleware'
import { poolManager } from '../../src/integration/db/connection-pool'
import { getRateLimiter } from '../../src/integration/rate-limiting'
import { getHealthAggregator } from '../../src/services/HealthAggregatorService'
import { pluginHealthService } from '../../src/services/PluginHealthService'
import { correlationErrorHandler } from '../../src/middleware/correlation'
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

/**
 * The four SYNCHRONOUS handlers in admin-routes.ts that used to have no try/catch at all. A throw there
 * skipped every responder: Express 4 caught it and forwarded it to index.ts's global error middleware,
 * `correlationErrorHandler` (installed by installGlobalErrorHandler() AFTER the /api/admin mount),
 * which answers `{ success: false, error: 'Internal Server Error', message, correlationId }` with
 * `message` set to the error's own text whenever NODE_ENV !== 'production' (middleware/correlation.ts).
 * The probe app mounts that same middleware in the same order, in its non-production mode, so a
 * handler that loses its catch is answered exactly as a dev / test / staging server would answer it.
 * Each double throws SYNCHRONOUSLY (mockImplementation, not mockRejectedValue): that is the path.
 */
const SYNC_CASES: RouteCase[] = [
  {
    label: 'GET /safety/status (sync handler)', method: 'get', path: '/api/admin/safety/status',
    expect: 'read', gate: 'requireAdminRole',
    arm: () => [vi.spyOn(getSafetyGuard(), 'isEnabled').mockImplementation(() => { throw leakyError() })],
  },
  {
    label: 'POST /safety/enable (sync handler)', method: 'post', path: '/api/admin/safety/enable',
    body: {}, expect: 'write', gate: 'requireAdminRole',
    arm: () => [vi.spyOn(getSafetyGuard(), 'updateConfig').mockImplementation(() => { throw leakyError() })],
  },
  {
    label: 'POST /safety/disable (sync handler)', method: 'post', path: '/api/admin/safety/disable',
    body: {}, expect: 'write', gate: 'requireAdminRole',
    arm: () => [vi.spyOn(getSafetyGuard(), 'updateConfig').mockImplementation(() => { throw leakyError() })],
  },
  {
    label: 'GET /plugins/health (sync handler)', method: 'get', path: '/api/admin/plugins/health',
    expect: 'read', gate: 'requireAdminRole',
    arm: () => [vi.spyOn(pluginHealthService, 'getAllPluginHealth').mockImplementation(() => { throw leakyError() })],
  },
]

const ALL_CASES: RouteCase[] = [...CASES, ...SYNC_CASES]

// ── app ───────────────────────────────────────────────────────────────────────

let currentUser: typeof ADMIN_USER | typeof NON_ADMIN_USER = ADMIN_USER
let currentRouter: express.Router
let errorLog: ReturnType<typeof vi.spyOn>
/** The global error middleware's own logger: a call means a failure escaped the admin tree's catches. */
const globalErrorLog = { error: vi.fn() }

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as Request & { user?: unknown }).user = currentUser
    next()
  })
  currentRouter = initAdminRoutes(injected as never)
  app.use('/api/admin', currentRouter)
  // index.ts order: the routes (setupMiddleware) first, then installGlobalErrorHandler() in startOnce().
  // Non-production mode, i.e. the mode in which it echoes an unhandled error's text in `message`.
  app.use(correlationErrorHandler(globalErrorLog, 'development'))
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
  it('the probe covers 36 branches: 22 writes + 4 synchronous handlers in admin-routes.ts, 4 in snapshot-labels.ts, 6 in protection-rules.ts', () => {
    expect(CASES).toHaveLength(32)
    expect(CASES.filter((c) => c.label.includes('(snapshot-labels)'))).toHaveLength(4)
    expect(CASES.filter((c) => c.label.includes('(protection-rules)'))).toHaveLength(6)
    expect(SYNC_CASES.map((c) => c.label)).toEqual([
      'GET /safety/status (sync handler)',
      'POST /safety/enable (sync handler)',
      'POST /safety/disable (sync handler)',
      'GET /plugins/health (sync handler)',
    ])
    expect(ALL_CASES).toHaveLength(36)
  })

  for (const c of ALL_CASES) {
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
      // The route's own catch answered: nothing escaped to the global error middleware.
      expect(globalErrorLog.error).not.toHaveBeenCalled()
    })
  }

  it('a thrown NON-Error (a bare string) is redacted too, and still reaches the log as text', async () => {
    vi.mocked(protectionRuleService.listRules).mockRejectedValue(LEAKY)
    const res = await request(pinned.url()).get('/api/admin/safety/rules')
    expectRedacted(res.status, res.body as Record<string, unknown>, 'read')
    expect(loggedOriginal()).toBe(true)
  })

  // Before the envelope, each site handed the caught value straight to logger.error(), which
  // duck-reads `.message` / `.stack`. An error-LIKE value that is not `instanceof Error` must keep
  // that fidelity in the log (its message, not "[object Object]"; its own stack, not the envelope's),
  // while the body stays redacted.
  it('an error-LIKE plain object ({ code, message, name }) is redacted, and its message (not "[object Object]") and name reach the log', async () => {
    vi.mocked(protectionRuleService.listRules).mockRejectedValue({ code: '28P01', message: LEAKY, name: 'FixtureDriverError' })
    const res = await request(pinned.url()).get('/api/admin/safety/rules')
    expectRedacted(res.status, res.body as Record<string, unknown>, 'read')
    expect(loggedOriginal()).toBe(true)
    // Exactly what the raw pass-through gave the logger: the object had no stack, so none is logged
    // (no frames of the envelope module invented in its place).
    const logged = errorLog.mock.calls
      .map((call) => call[1] as { message?: unknown; stack?: unknown; name?: unknown } | undefined)
      .find((err) => typeof err?.message === 'string' && err.message.includes(LEAKY))
    expect(logged).toBeDefined()
    expect(logged?.stack).toBeUndefined()
    expect(logged?.name).toBe('FixtureDriverError')
  })

  it('an error-LIKE object with a string stack and NO message is redacted, and the log keeps exactly that stack', async () => {
    const stack = `Error: ${LEAKY}\n    at fixtureFrame (fixture-module.ts:1:1)`
    vi.mocked(protectionRuleService.listRules).mockRejectedValue({ stack })
    const res = await request(pinned.url()).get('/api/admin/safety/rules')
    expectRedacted(res.status, res.body as Record<string, unknown>, 'read')
    // What the raw pass-through gave the logger: that stack — not "[object Object]" with the
    // envelope's own frames.
    const stacks = errorLog.mock.calls.map((call) => (call[1] as { stack?: unknown } | undefined)?.stack)
    expect(stacks).toContain(stack)
  })

  it('an Error from another realm (vm) is redacted, and the log keeps its message AND its original stack', async () => {
    const foreign = vm.runInNewContext('new Error(text)', { text: LEAKY }) as { message: string; stack: string }
    // The precondition that makes this case different from every other probe.
    expect(foreign instanceof Error).toBe(false)
    expect(typeof foreign.stack).toBe('string')
    vi.mocked(protectionRuleService.listRules).mockRejectedValue(foreign)
    const res = await request(pinned.url()).get('/api/admin/safety/rules')
    expectRedacted(res.status, res.body as Record<string, unknown>, 'read')
    expect(loggedOriginal()).toBe(true)
    const stacks = errorLog.mock.calls.map((call) => (call[1] as { stack?: unknown } | undefined)?.stack)
    expect(stacks).toContain(foreign.stack)
  })

  /** Thrown values that cannot be read or rendered as text; `String()` throws on each of them. */
  function unrenderableValues(): Array<[string, unknown]> {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    return [
      ['Object.create(null)', Object.create(null)],
      ['an object whose toString throws', { toString: () => { throw new Error('unrenderable') } }],
      ['a revoked Proxy', revoked.proxy],
    ]
  }

  for (const [label, route] of [
    ['async GET /safety/rules (protection-rules)', 'async'],
    ['sync GET /plugins/health', 'sync'],
  ] as const) {
    it(`${label}: a thrown value that cannot be rendered still gets the redacted 500 — the responder itself does not throw`, async () => {
      for (const [what, thrown] of unrenderableValues()) {
        errorLog.mockClear()
        if (route === 'async') {
          vi.mocked(protectionRuleService.listRules).mockRejectedValue(thrown)
        } else {
          vi.spyOn(pluginHealthService, 'getAllPluginHealth').mockImplementation(() => { throw thrown })
        }
        // A responder that throws leaves the async request unanswered (a timeout here) and sends the
        // sync one to the global error middleware (a non-envelope body + globalErrorLog call).
        const res = await request(pinned.url())
          .get(route === 'async' ? '/api/admin/safety/rules' : '/api/admin/plugins/health')
          .timeout(3000)
        expect({ what, status: res.status, code: res.body.code }).toEqual({ what, status: 500, code: ADMIN_READ_FAILED_CODE })
        expectRedacted(res.status, res.body as Record<string, unknown>, 'read')
        expect(globalErrorLog.error).not.toHaveBeenCalled()
        // Something textual still reached the log for the operator.
        const logged = errorLog.mock.calls.map((call) => (call[1] as { message?: unknown } | undefined)?.message)
        expect(logged.some((m) => typeof m === 'string' && m.length > 0)).toBe(true)
      }
    })
  }

  it('#5903 read side is unchanged: a GET in admin-routes.ts still answers ADMIN_READ_FAILED', async () => {
    vi.spyOn(getHealthAggregator(), 'checkHealth').mockRejectedValue(leakyError())
    const res = await request(pinned.url()).get('/api/admin/health/detailed')
    expectRedacted(res.status, res.body as Record<string, unknown>, 'read')
  })
})

// ── 2. gate order: a non-admin never reaches the throwing double ──────────────

describe('non-admin caller: the gate still answers first and the handler is never reached', () => {
  for (const c of ALL_CASES) {
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
    const thrown = leakyError()
    app.get('/probe', (_req, res) => {
      sendAdminWriteFailure(res, 'probe context', thrown, {
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
    // An Error of this realm reaches the logger unchanged: the very same object.
    expect(log.error.mock.calls[0][1]).toBe(thrown)
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

  /** A sync handler with no catch: its throw reaches the global middleware, which echoes it in `message`. */
  function expectGlobalHandlerEcho(res: { status: number; body: Record<string, unknown> }, kind: 'read' | 'write'): void {
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
    expect(res.body.message).toBe(LEAKY)
    expect(globalErrorLog.error).toHaveBeenCalledTimes(1)
    expect(() => expectRedacted(res.status, res.body, kind)).toThrow()
  }

  it('sync handler: GET /safety/status restored to the bare createSafetyStatusEndpoint() is caught', async () => {
    const layer = findRouteLayer((currentRouter as unknown as { stack: RouteLayer[] }).stack, '/safety/status', 'get')
    await withSwappedHandler(layer, createSafetyStatusEndpoint(), async () => {
      vi.spyOn(getSafetyGuard(), 'isEnabled').mockImplementation(() => { throw leakyError() })
      const res = await request(pinned.url()).get('/api/admin/safety/status')
      expectGlobalHandlerEcho(res as never, 'read')
    })
  })

  it('sync handler: POST /safety/enable restored to its catch-less body is caught', async () => {
    const layer = findRouteLayer((currentRouter as unknown as { stack: RouteLayer[] }).stack, '/safety/enable', 'post')
    await withSwappedHandler(
      layer,
      (_req, res) => {
        getSafetyGuard().updateConfig({ enabled: true })
        res.json({ success: true, message: 'SafetyGuard enabled' })
      },
      async () => {
        vi.spyOn(getSafetyGuard(), 'updateConfig').mockImplementation(() => { throw leakyError() })
        const res = await request(pinned.url()).post('/api/admin/safety/enable').send({})
        expectGlobalHandlerEcho(res as never, 'write')
      }
    )
  })

  it('sync handler: GET /plugins/health restored to its catch-less body is caught', async () => {
    const layer = findRouteLayer((currentRouter as unknown as { stack: RouteLayer[] }).stack, '/plugins/health', 'get')
    await withSwappedHandler(
      layer,
      (_req, res) => {
        const health = pluginHealthService.getAllPluginHealth()
        res.json({ success: true, count: health.length, health })
      },
      async () => {
        vi.spyOn(pluginHealthService, 'getAllPluginHealth').mockImplementation(() => { throw leakyError() })
        const res = await request(pinned.url()).get('/api/admin/plugins/health')
        expectGlobalHandlerEcho(res as never, 'read')
      }
    )
  })
})

// ── 3. structural guard over the mounted tree ─────────────────────────────────

const ROUTES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes')
const readRoute = (rel: string) => fs.readFileSync(path.join(ROUTES_DIR, rel), 'utf-8')
/** An import specifier → a path relative to ROUTES_DIR: `x.ts`, else `x/index.ts` (a `.js` suffix maps to the `.ts` source). */
const resolveRel = (from: string, spec: string) => {
  const abs = path.resolve(path.dirname(path.join(ROUTES_DIR, from)), spec.replace(/\.js$/, ''))
  const file = [`${abs}.ts`, path.join(abs, 'index.ts')].find((candidate) => fs.existsSync(candidate)) ?? `${abs}.ts`
  return path.relative(ROUTES_DIR, file).split(path.sep).join('/')
}
const ENVELOPE = 'admin-failure-envelope.ts'

function routerTree() {
  return discoverMountedRouterTree('admin-routes.ts', readRoute, resolveRel)
}

function treeFiles(): string[] {
  return [...routerTree().files, ENVELOPE]
}

const isRouterObject = (value: unknown): value is { stack: RouteLayer[] } =>
  typeof value === 'function' && Array.isArray((value as { stack?: unknown }).stack)

/** A router's live stack, typed for the walks below. */
const layersOf = (router: unknown): RouteLayer[] => (router as { stack: RouteLayer[] }).stack

/** The handles a layer runs: its own, or — for a route layer — every handler in the route's stack. */
function layerHandles(layer: RouteLayer): unknown[] {
  return layer.route ? layer.route.stack.map((inner) => inner.handle) : [layer.handle]
}

/**
 * Router objects nested (at any depth) in a live express stack: every handle that is itself a router
 * — mounted with `.use()` (the layer's own handle) or registered as a ROUTE handler
 * (`router.get(path, gate, sub)`, where it sits in `layer.route.stack`). Each router once.
 * A router that is only CALLED from inside a function layer (a closure / wrapper) is not a handle
 * anywhere in the stack, so it is not found here — see the static `wrapped` rule of the discovery.
 */
function liveNestedRouters(stack: RouteLayer[], out: unknown[] = []): unknown[] {
  for (const layer of stack) {
    for (const handle of layerHandles(layer)) {
      if (isRouterObject(handle) && !out.includes(handle)) {
        out.push(handle)
        liveNestedRouters(handle.stack, out)
      }
    }
  }
  return out
}

/**
 * Every `.use()`-level FUNCTION layer (not a router, not a route) in a live stack, at any depth, as
 * `<module that exports the router it sits in>:<function name>`. A closure that calls a sub-router
 * (`router.use(p, (req, res, next) => sub(req, res, next))`) is such a layer, and the identity
 * cross-check cannot see through it; this list is a registration tripwire for exactly that layer.
 */
function liveUseLevelFunctions(stack: RouteLayer[], owner: string, exported: Map<unknown, string>, out: string[] = []): string[] {
  for (const layer of stack) {
    for (const handle of layerHandles(layer)) {
      if (isRouterObject(handle)) liveUseLevelFunctions(handle.stack, exported.get(handle) ?? '<not exported>', exported, out)
    }
    if (!layer.route && !isRouterObject(layer.handle)) {
      out.push(`${owner}:${(layer.handle as { name?: string } | undefined)?.name || '<anonymous>'}`)
    }
  }
  return out
}

/**
 * The `.use()`-level function layers the tree has today, registered by name. A new one — any
 * middleware, and in particular a closure or wrapper that calls a sub-router — turns the tripwire
 * red until it is looked at and registered here. It compares NAMES: a wrapper that reuses a
 * registered name in the same module is not told apart.
 */
const REGISTERED_USE_LEVEL_FUNCTIONS = ['protection-rules.ts:protectionRulesRateLimit']

/**
 * Every Router object a discovered module EXPORTS, keyed by identity. The modules are the ones the
 * mounted tree already loaded (same module instances), so a live router that one of them exports is
 * the very object found here.
 */
async function exportedRouters(files: string[]): Promise<Map<unknown, string>> {
  const out = new Map<unknown, string>()
  for (const rel of files) {
    const mod = (await import(pathToFileURL(path.join(ROUTES_DIR, rel)).href)) as Record<string, unknown>
    for (const value of Object.values(mod)) if (isRouterObject(value)) out.set(value, rel)
  }
  return out
}

/**
 * The live-stack cross-check, by identity. Every router nested in the live tree must be one that a
 * scanned module exports; only in-place `Router()` mounts (no export to compare with) may account for
 * the rest, and only by count. Returns the problems; empty means consistent.
 */
function reconcileLiveRouters(live: unknown[], exported: Map<unknown, string>, tree: RouterTree): string[] {
  const unmatched = live.filter((router) => !exported.has(router))
  const inPlace = tree.mounts.filter((m) => m.inPlace).length
  return unmatched.length > inPlace
    ? [`${unmatched.length} live router(s) are not exported by any scanned module (in-place Router() mounts: ${inPlace})`]
    : []
}

/** Offenders in a probe handler whose catch binds `error`. */
const flaggedIn = (body: string) =>
  scanResponseErrorEcho('probe.ts', `async function h(req, res) { try { await x() } catch (error) { ${body} } }`).offenders.length
/** Offenders in a whole probe source. */
const flaggedFile = (source: string) => scanResponseErrorEcho('probe.ts', source).offenders.length

describe('structural guard: no 5xx response in the /api/admin tree carries caught-error text', () => {
  it('discovers the tree by resolving the .use(...) arguments of admin-routes.ts', () => {
    const files = treeFiles()
    for (const expected of ['admin-routes.ts', 'snapshot-labels.ts', 'protection-rules.ts', ENVELOPE]) {
      expect(files).toContain(expected)
    }
  })

  it('live-stack cross-check, by identity: every router nested in the mounted tree is exported by a scanned module', async () => {
    const liveStack = (currentRouter as unknown as { stack: RouteLayer[] }).stack
    const tree = routerTree()
    const live = liveNestedRouters(liveStack)
    const exported = await exportedRouters(tree.files)
    // This is the part that needs no per-router expectation: it is what turns red for a router
    // mounted TOMORROW, as a layer handle (`.use()` or a route handler), in a way the static walk
    // cannot follow. (A router only CALLED from a function layer is not a handle: see the
    // use-level registration below and the header.)
    expect(reconcileLiveRouters(live, exported, tree)).toEqual([])
    // Today it is strict: no in-place Router() mounts, and every live router is matched to its module.
    expect(tree.mounts.filter((m) => m.inPlace)).toEqual([])
    expect(live.map((router) => exported.get(router)).sort()).toEqual(['protection-rules.ts', 'snapshot-labels.ts'])
    // Mutation: a router the walk did not find, added to a copy of the live stack (the live router is
    // not touched), is not an export of any scanned module.
    const foreign = express.Router()
    const withUnfollowed = liveNestedRouters([...liveStack, { handle: foreign as unknown as { stack: RouteLayer[] } }])
    expect(reconcileLiveRouters(withUnfollowed, exported, tree)).not.toEqual([])
  })

  it('live-stack cross-check: a router registered as a ROUTE handler (get / all / route().post, behind a gate, at any depth) is found and must be exported', async () => {
    const liveStack = (currentRouter as unknown as { stack: RouteLayer[] }).stack
    const tree = routerTree()
    const exported = await exportedRouters(tree.files)
    // Real express layers, built on a scratch router (the live admin router is module-level and is
    // not touched): each foreign router lives INSIDE a route layer, in `layer.route.stack`.
    const gate = (_req: Request, _res: Response, next: NextFunction) => next()
    const viaGet = express.Router()
    const viaAll = express.Router()
    const viaRoute = express.Router()
    const deeper = express.Router()
    const holder = express.Router()
    holder.get('/foreign-get', gate, viaGet)
    holder.all('/foreign-all', viaAll)
    holder.route('/foreign-route').post(viaRoute)
    viaGet.get('/deeper', deeper)
    const shapes: Array<{ label: string; path: string }> = [
      { label: 'router.get(path, gate, sub)', path: '/foreign-get' },
      { label: 'router.all(path, sub)', path: '/foreign-all' },
      { label: 'router.route(path).post(sub)', path: '/foreign-route' },
    ]
    for (const { label, path: routePath } of shapes) {
      const extra = layersOf(holder).filter((l) => l.route?.path === routePath)
      expect({ label, layers: extra.length }).toEqual({ label, layers: 1 })
      const live = liveNestedRouters([...liveStack, ...extra])
      expect({ label, problems: reconcileLiveRouters(live, exported, tree).length }).toEqual({ label, problems: 1 })
    }
    // Nested: a router registered as a route handler INSIDE a route-handler router is found too.
    const nested = liveNestedRouters([...liveStack, ...layersOf(holder)])
    for (const router of [viaGet, viaAll, viaRoute, deeper]) expect(nested).toContain(router)
    // The walk that only follows `layer.handle.stack` (the previous implementation) sees none of them.
    const handleOnly = (stack: RouteLayer[], out: unknown[] = []): unknown[] => {
      for (const layer of stack) {
        const inner = layer.handle?.stack
        if (Array.isArray(inner)) {
          out.push(layer.handle)
          handleOnly(inner, out)
        }
      }
      return out
    }
    expect(reconcileLiveRouters(handleOnly([...liveStack, ...layersOf(holder)]), exported, tree)).toEqual([])
  })

  it('use-level function layers are registered: a closure that wraps a sub-router is a new, unregistered layer', async () => {
    const liveStack = (currentRouter as unknown as { stack: RouteLayer[] }).stack
    const exported = await exportedRouters(routerTree().files)
    const owner = exported.get(currentRouter) as string
    expect(owner).toBe('admin-routes.ts')
    expect(liveUseLevelFunctions(liveStack, owner, exported).sort()).toEqual([...REGISTERED_USE_LEVEL_FUNCTIONS].sort())
    // Mutation (on a scratch router, merged into a copy of the stack): the closure-wrapped mount that
    // neither the identity cross-check nor a handle walk can see through.
    const sub = express.Router()
    const holder = express.Router()
    holder.use('/legacy-wrap', (req, res, next) => sub(req, res, next))
    const withWrapper = liveUseLevelFunctions([...liveStack, ...layersOf(holder)], owner, exported)
    expect(withWrapper.filter((entry) => !REGISTERED_USE_LEVEL_FUNCTIONS.includes(entry))).toEqual(['admin-routes.ts:<anonymous>'])
    // ...and indeed the identity cross-check stays green on it: that is why the tripwire exists.
    expect(reconcileLiveRouters(liveNestedRouters([...liveStack, ...layersOf(holder)]), exported, routerTree())).toEqual([])
  })

  it('live-stack cross-check: a switched-off static mount cannot cancel a live router the walk never saw', async () => {
    // The shape an earlier count-only comparison missed: static side +1 (a mount that is off at
    // runtime), live side +1 (a mount the walk cannot follow). Built in memory on the real source.
    const source = readRoute('admin-routes.ts')
    const anchor = 'export default router;'
    expect(source.split(anchor)).toHaveLength(2)
    const mutated = source.replace(
      anchor,
      `if (process.env.EADM_LEGACY_LABELS_MOUNT === 'true') router.use('/legacy-labels', snapshotLabelsRouter);\n` +
        `for (const unfollowed of [foreignRouter]) router.use('/foreign', unfollowed);\n` +
        anchor
    )
    const tree = discoverMountedRouterTree('admin-routes.ts', (rel) => (rel === 'admin-routes.ts' ? mutated : readRoute(rel)), resolveRel)
    const liveStack = (currentRouter as unknown as { stack: RouteLayer[] }).stack
    const live = liveNestedRouters([...liveStack, { handle: express.Router() as unknown as { stack: RouteLayer[] } }])
    // The counts agree (3 static router mounts, 3 live routers): a count-only check stays green here.
    expect(tree.mounts.filter((m) => m.router)).toHaveLength(live.length)
    // The identity check does not.
    expect(reconcileLiveRouters(live, await exportedRouters(tree.files), tree)).not.toEqual([])
  })

  it('discovery self-check: follows aliases, factories, namespace members, destructures, assignments, returns, import(), routers registered as route handlers, and routers reached through a closure or same-file function', () => {
    const subRouter = `import { Router } from 'express'\nconst r = Router()\nexport default r\nexport const make = () => Router()\n`
    const sources: Record<string, string> = {
      'root.ts': [
        `import express, { Router } from 'express'`,
        `import { make as createA } from './a'`,
        `import b from './b'`,
        `import * as c from './c'`,
        `import d from './d'`,
        `import e from './e'`,
        `import f from './f'`,
        `import g from './g'`,
        `import { guard } from './guard'`,
        `import i from './i'`,
        `import j from './j'`,
        `import k from './k'`,
        `import l from './l'`,
        `import m from './m'`,
        `import n from './n'`,
        `import o from './o'`,
        `import { handler } from './handler'`,
        `const router = Router()`,
        // a Router registered as a ROUTE handler (it then lives in layer.route.stack)
        `router.get('/i', guard, i)`,
        `router.all('/j', j)`,
        `router.route('/k').post(k)`,
        // a Router reached only through a function: an inline closure, a same-file function, an object member
        `router.use('/l', (req: any, res: any, next: any) => l(req, res, next))`,
        `function wrapM(req: any, res: any, next: any) { return m(req, res, next) }`,
        `router.get('/m', wrapM)`,
        `const wrappers = { n: (req: any, res: any, next: any) => n.handle(req, res, next) }`,
        `router.use('/n', (req: any, res: any, next: any) => wrappers.n(req, res, next))`,
        // NOT mounts: another module's plain handler on a route method; .get on a Map
        `router.get('/handler', handler)`,
        `const lookup = new Map<unknown, unknown>()`,
        `lookup.get(o)`,
        `router.use(express.json())`,
        `const aliasA = createA()`,
        `router.use('/a', aliasA)`,
        `const aliasB = b`,
        `const again = aliasB`,
        `router.use('/b', again)`,
        `router.use('/c', c.default)`,
        `const { dRouter } = { dRouter: d }`,
        `router.use('/d', dRouter)`,
        `let late: unknown`,
        `late = e`,
        `router.use('/e', late)`,
        `function pick() { return f }`,
        `router.use('/f', pick())`,
        `router.use('/g', process.env.FLAG ? g : undefined)`,
        `router.use('/h', (await import('./h')).default)`,
        `router.use('/local', Router())`,
        `router.use(guard)`,
        `export default router`,
      ].join('\n'),
      'a.ts': subRouter,
      'b.ts': subRouter,
      'c.ts': subRouter,
      'd.ts': subRouter,
      'e.ts': subRouter,
      'f.ts': subRouter,
      'g.ts': subRouter,
      'h.ts': subRouter,
      'i.ts': subRouter,
      'j.ts': subRouter,
      'k.ts': subRouter,
      'l.ts': subRouter,
      'm.ts': subRouter,
      'n.ts': subRouter,
      'o.ts': subRouter,
      'guard.ts': `export function guard(_req: unknown, _res: unknown, next: () => void) { next() }\n`,
      'handler.ts': `export function handler(_req: unknown, res: { json: (b: unknown) => void }) { res.json({}) }\n`,
    }
    const tree = discoverMountedRouterTree(
      'root.ts',
      (rel) => {
        if (!(rel in sources)) throw new Error(`unexpected read: ${rel}`)
        return sources[rel]
      },
      (_from, spec) => `${spec.replace(/^\.\//, '')}.ts`
    )
    expect([...tree.files].sort()).toEqual(
      ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'guard.ts', 'h.ts', 'i.ts', 'j.ts', 'k.ts', 'l.ts', 'm.ts', 'n.ts', 'root.ts'].sort()
    )
    // `.use`: 8 imported sub-routers + the Router() built in place; the middleware module is scanned but is not a router.
    expect(tree.mounts.filter((m) => m.via === 'use' && m.router)).toHaveLength(9)
    expect(tree.mounts.find((m) => m.via === 'use' && m.targets.includes('guard.ts'))?.router).toBe(false)
    // Route methods: only the Router arguments are followed (the gate and another module's handler are not).
    expect(tree.mounts.filter((m) => m.via === 'route' && m.router).map((m) => m.targets)).toEqual([['i.ts'], ['j.ts'], ['k.ts']])
    expect(tree.mounts.filter((m) => m.via === 'route').flatMap((m) => m.targets)).not.toContain('guard.ts')
    // Reached only through a function (not a layer handle, so invisible to the live cross-check).
    expect(tree.mounts.filter((m) => m.wrapped.length > 0).map((m) => m.wrapped)).toEqual([['l.ts'], ['m.ts'], ['n.ts']])
    // Only the Router() built in place is an in-place mount (the one kind the live check can only count).
    expect(tree.mounts.filter((m) => m.inPlace).map((m) => m.targets)).toEqual([['root.ts']])
  })

  it('discovery on the REAL tree follows a router registered as a route handler or wrapped in a closure, so its echo reaches the zero-offender scan', () => {
    const echoModule =
      `import { Router } from 'express'\nconst r = Router()\n` +
      `r.get('/echo', async (_req: any, res: any) => { try { await x() } catch (error) { res.status(500).json({ success: false, error: (error as Error).message }) } })\n` +
      `export default r\n`
    const variants: Array<{ label: string; file: string; line: string }> = [
      { label: 'route handler behind a gate', file: 'admin-routes.ts', line: `router.get('/legacy-echo', requireAdminRole(), eadmLegacyRouter);` },
      { label: 'router.all', file: 'admin-routes.ts', line: `router.all('/legacy-echo', eadmLegacyRouter);` },
      { label: 'closure in .use (sub-router)', file: 'snapshot-labels.ts', line: `router.use('/legacy-wrap', (req, res, next) => eadmLegacyRouter(req, res, next));` },
      { label: 'closure in a route method (sub-router)', file: 'protection-rules.ts', line: `router.get('/legacy-wrap', (req, res, next) => eadmLegacyRouter(req, res, next));` },
    ]
    const anchor = 'export default router;'
    for (const v of variants) {
      const source = readRoute(v.file)
      expect(source.split(anchor)).toHaveLength(2)
      const mutated = source.replace(anchor, `import eadmLegacyRouter from './eadm-legacy-echo';\n${v.line}\n${anchor}`)
      const read = (rel: string) => (rel === v.file ? mutated : rel === 'eadm-legacy-echo.ts' ? echoModule : readRoute(rel))
      const tree = discoverMountedRouterTree('admin-routes.ts', read, resolveRel)
      expect({ label: v.label, found: tree.files.includes('eadm-legacy-echo.ts') }).toEqual({ label: v.label, found: true })
      const offenders = tree.files.flatMap((rel) => scanResponseErrorEcho(rel, read(rel)).offenders)
      expect({ label: v.label, offenders: offenders.map((o) => o.file) }).toEqual({ label: v.label, offenders: ['eadm-legacy-echo.ts'] })
    }
  })

  it('zero offenders across every discovered file', () => {
    const offenders = treeFiles().flatMap((rel) => scanResponseErrorEcho(rel, readRoute(rel)).offenders)
    expect(offenders).toEqual([])
  })

  it('is not vacuous: it sees the 5xx sinks and all 49 responder calls (13 + 22 + 4 sync in admin-routes.ts, 4, 6)', () => {
    const scans = treeFiles().map((rel) => scanResponseErrorEcho(rel, readRoute(rel)))
    const sinks = scans.flatMap((s) => s.sinks)
    const calls = scans.flatMap((s) => s.responderCalls)
    // The 503 "service not available" bodies and the envelope's own 500 are real sinks it inspects.
    expect(sinks.filter((s) => s.kind === 'status-chain').length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.file === 'admin-routes.ts').length).toBeGreaterThanOrEqual(39)
    expect(calls.filter((c) => c.file === 'snapshot-labels.ts').length).toBeGreaterThanOrEqual(4)
    expect(calls.filter((c) => c.file === 'protection-rules.ts').length).toBeGreaterThanOrEqual(6)
    // Every responder call sits in a catch, so every mutation below has a caught binding to echo.
    expect(calls.filter((c) => c.catchVar === null)).toEqual([])
  })

  it('scanner self-check: flags echoes, ignores log calls, 4xx and fixed text', () => {
    // flagged: the caught error reaches a 5xx body directly
    expect(flaggedIn(`res.status(500).json({ success: false, error: (error as Error).message })`)).toBe(1)
    expect(flaggedIn(`const err = error as Error; res.status(500).json({ error: err.message })`)).toBe(1)
    expect(flaggedIn(`res.status(500).json({ error: String(error) })`)).toBe(1)
    expect(flaggedIn('res.status(500).json({ error: `failed: ${error}` })')).toBe(1)
    expect(flaggedIn(`const m = String(error); res.status(502).send(m)`)).toBe(1)
    expect(flaggedIn(`const { message } = error as Error; res.status(500).json({ error: message })`)).toBe(1)
    expect(flaggedIn(`res.status(500).json({ error: (error as Error).stack })`)).toBe(1)
    expect(flaggedIn(`res.status(500).json({ error })`)).toBe(1)
    expect(flaggedIn(`res.status(code).json({ error: (error as Error).message })`)).toBe(1)
    expect(flaggedIn(`res.status(500).set('x', 'y').json({ error: (error as Error).message })`)).toBe(1)
    expect(flaggedIn(`return jsonError(res, 500, 'X_FAILED', (error as Error)?.message || 'fallback')`)).toBe(1)
    expect(flaggedIn(`sendAdminWriteFailure(res, 'ctx', error, { detail: (error as Error).message })`)).toBe(1)
    // flagged: taint through ASSIGNMENTS, not only declaration initializers
    expect(flaggedIn(`let detail = ''; detail = String(error); res.status(500).json({ success: false, error: detail })`)).toBe(1)
    expect(flaggedIn(`const body: Record<string, unknown> = { success: false }; body.error = String(error); res.status(500).json(body)`)).toBe(1)
    expect(flaggedIn(`const body = {}; Object.assign(body, { error: String(error) }); res.status(500).json(body)`)).toBe(1)
    expect(flaggedIn(`const errors: string[] = []; errors.push(String(error)); res.status(500).json({ errors })`)).toBe(1)
    expect(flaggedIn(`let m = ''; ({ message: m } = error as Error); res.status(500).json({ error: m })`)).toBe(1)
    expect(flaggedIn(`const describe = () => String(error); res.status(500).json({ error: describe() })`)).toBe(1)
    expect(flaggedIn(`[error].forEach((e) => res.status(500).json({ error: String(e) }))`)).toBe(1)
    // flagged: a for…of binding over the caught error, and Map / Set containers that hold it
    expect(flaggedIn(`for (const e of [error]) { res.status(500).json({ error: String(e) }) }`)).toBe(1)
    expect(flaggedIn(`let e: unknown; for (e of [error]) { res.status(500).json({ error: String(e) }) }`)).toBe(1)
    expect(flaggedIn(`const m = new Map(); m.set('e', error); res.status(500).json({ error: String(m.get('e')) })`)).toBe(1)
    expect(flaggedIn(`const s = new Set(); s.add(error); res.status(500).json({ errors: [...s].map(String) })`)).toBe(1)
    // flagged: the status set in an EARLIER statement on the same receiver
    expect(flaggedIn(`res.status(500); res.json({ success: false, error: String(error) })`)).toBe(1)
    expect(flaggedIn(`res.statusCode = 500; res.json({ success: false, error: String(error) })`)).toBe(1)
    expect(flaggedIn(`res.writeHead(500); res.end(String(error))`)).toBe(1)
    expect(flaggedIn('res.status(503); if (retry) { res.send(`failed: ${error}`) }')).toBe(1)
    expect(flaggedIn(`const r = res.status(500); r.json({ error: String(error) })`)).toBe(1)
    // flagged: split status through a receiver alias, either way round
    expect(flaggedIn(`const r = res; res.status(500); r.json({ error: String(error) })`)).toBe(1)
    expect(flaggedIn(`const r = res; const r2 = r; r2.status(500); res.json({ error: String(error) })`)).toBe(1)
    // flagged: split status, body written through a method CHAIN on the same response
    expect(flaggedIn(`res.status(500); res.set('X-Trace', 'fixed').json({ success: false, error: String(error) })`)).toBe(1)
    expect(flaggedIn(`res.status(500); res.type('json').send(JSON.stringify({ error: String(error) }))`)).toBe(1)
    expect(flaggedIn(`res.statusCode = 500; res.set('X-Trace', 'fixed').json({ error: String(error) })`)).toBe(1)
    expect(flaggedIn(`const r = res; res.status(500); r.set('x', 'y').json({ error: String(error) })`)).toBe(1)
    expect(flaggedIn(`const r = res.set('x', 'y'); res.status(500); r.json({ error: String(error) })`)).toBe(1)
    // flagged: split status in an ENCLOSING function, body in an inner callback
    expect(flaggedIn(`res.status(500); [1].forEach(() => res.json({ error: String(error) }))`)).toBe(1)
    // flagged: a function DECLARATION that captures the caught error
    expect(flaggedIn(`function detail() { return String(error) } res.status(500).json({ error: detail() })`)).toBe(1)
    // flagged: every listed container writer
    expect(flaggedIn(`const errs: unknown[] = []; errs.unshift(error); res.status(500).json({ errs })`)).toBe(1)
    expect(flaggedIn(`const errs: unknown[] = []; errs.splice(0, 0, error); res.status(500).json({ errs })`)).toBe(1)
    // flagged: `['message']` / `['stack']` read, whatever the receiver (no taint needed)
    expect(flaggedFile(`function h(req: any, res: any) { const last = req.app.locals.lastFailure; res.status(500).json({ error: last['message'] }) }`)).toBe(1)
    expect(flaggedFile(`function h(req: any, res: any) { const last = req.app.locals.lastFailure; res.status(500).json({ error: last['stack'] }) }`)).toBe(1)
    // flagged: a responder called through an alias
    expect(flaggedIn(`const fail = sendAdminWriteFailure; fail(res, 'ctx', error, { detail: String(error) })`)).toBe(1)
    // flagged: a same-file helper that receives the caught error as an argument
    expect(
      flaggedFile(
        `function fail(res: any, e: unknown) { res.status(500).json({ success: false, error: String(e) }) }\n` +
          `async function h(req: any, res: any) { try { await x() } catch (error) { fail(res, error) } }`
      )
    ).toBe(1)
    expect(
      flaggedFile(
        `const fail = (res: any, ...rest: unknown[]) => res.status(500).json({ error: String(rest[0]) })\n` +
          `async function h(req: any, res: any) { try { await x() } catch (error) { fail(res, error) } }`
      )
    ).toBe(1)
    // flagged: a same-file helper that is a MEMBER — object-literal method, arrow property, later
    // property assignment, class static method, class static arrow property
    const inCatchFile = (body: string) => `async function h(req: any, res: any) { try { await x() } catch (error) { ${body} } }`
    for (const [helper, call] of [
      [`const helpers = { fail(r: any, e: unknown) { r.status(500).json({ error: String(e) }) } }`, `helpers.fail(res, error)`],
      [`const helpers = { fail: (r: any, e: unknown) => r.status(500).json({ error: String(e) }) }`, `helpers.fail(res, error)`],
      [`const helpers: any = {}\nhelpers.fail = (r: any, e: unknown) => r.status(500).json({ error: String(e) })`, `helpers.fail(res, error)`],
      [`class Fail { static send(r: any, e: unknown) { r.status(500).json({ error: String(e) }) } }`, `Fail.send(res, error)`],
      [`class Fail { static send = (r: any, e: unknown) => r.status(500).json({ error: String(e) }) }`, `Fail.send(res, error)`],
    ]) {
      expect({ helper, flagged: flaggedFile(`${helper}\n${inCatchFile(call)}`) }).toEqual({ helper, flagged: 1 })
    }
    // flagged: declared outside the catch, assigned inside, answered after it
    expect(
      flaggedFile(
        `async function h(req: any, res: any) { let failure: unknown = null; try { await x() } catch (error) { failure = error }\n` +
          `  if (failure) res.status(500).json({ error: String(failure) }) }`
      )
    ).toBe(1)
    // flagged: other error channels — .then(_, onErr), .catch(named), .on('error'), error middleware
    expect(flaggedFile(`function h(req: any, res: any) { x().then(() => res.json({}), (e) => res.status(500).json({ error: String(e) })) }`)).toBe(1)
    expect(flaggedFile(`function onErr(e: unknown) { out.status(500).json({ error: String(e) }) }\nfunction h() { x().catch(onErr) }`)).toBe(1)
    for (const method of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']) {
      const source = `function h(req: any, res: any) { stream.${method}('error', (err) => res.status(500).json({ error: String(err) })) }`
      expect({ method, flagged: flaggedFile(source) }).toEqual({ method, flagged: 1 })
    }
    expect(flaggedFile(`function onError(err: any, req: any, res: any, next: any) { res.status(500).json({ error: err.toString() }) }`)).toBe(1)
    // ...whatever the first parameter is called: Express decides by arity (fn.length === 4), not by name
    expect(flaggedFile(`function onError(failure: any, req: any, res: any, next: any) { res.status(500).json({ error: String(failure) }) }`)).toBe(1)
    expect(flaggedFile(`router.use((problem: any, req: any, res: any, next: any) => { res.status(500).json({ error: String(problem) }) })`)).toBe(1)
    // flagged: a responder DEFINITION that puts its caught-value parameter into the body
    expect(
      flaggedFile(
        `export function make(logger: any) { return { sendAdminWriteFailure: (res: any, context: string, error: unknown, extra?: object) => {\n` +
          `  logger.error(context, error); res.status(500).json({ ...extra, success: false, detail: String(error) }) } } }`
      )
    ).toBe(1)
    // not flagged
    expect(flaggedIn(`logger.error(\`failed: \${(error as Error).message}\`, error as Error); res.status(500).json({ error: 'fixed' })`)).toBe(0)
    expect(flaggedIn(`res.status(400).json({ error: (error as Error).message })`)).toBe(0)
    expect(flaggedIn(`res.status(404); res.json({ error: String(error) })`)).toBe(0)
    expect(flaggedIn(`const r = res; r.status(404); res.json({ error: String(error) })`)).toBe(0)
    expect(flaggedIn(`res.status(404); res.set('x', 'y').json({ error: String(error) })`)).toBe(0)
    // Express arity 3 (`next` has a default, so fn.length === 3): Express never calls it as an error
    // handler, its first argument is the request
    expect(flaggedFile(`function mw(err: any, req: any, res: any, next: any = () => undefined) { res.status(500).json({ error: String(err) }) }`)).toBe(0)
    expect(
      flaggedFile(
        `const helpers = { fail(r: any, id: string) { r.status(500).json({ id }) } }\n` +
          `async function h(req: any, res: any) { try { await x() } catch (error) { log(error); helpers.fail(res, req.params.id) } }`
      )
    ).toBe(0)
    expect(flaggedIn(`const m = new Map(); m.set('e', error); logger.error('x', m.get('e')); res.status(500).json({ error: 'fixed' })`)).toBe(0)
    expect(flaggedIn(`res.status(503).json({ success: false, error: 'Service not available' })`)).toBe(0)
    expect(flaggedIn(`sendAdminWriteFailure(res, 'ctx', error, { pluginId: req.params.id })`)).toBe(0)
    expect(flaggedIn(`res.json({ error: (error as Error).message })`)).toBe(0)
    expect(
      flaggedFile(
        `function a(req: any, res: any) { try { x() } catch (error) { sendAdminWriteFailure(res, 'ctx', error) } }\n` +
          `function b(req: any, res: any) { const error = 'fixed text'; res.status(500).json({ error }) }`
      )
    ).toBe(0)
    expect(
      flaggedFile(
        `function fail(res: any, id: string) { res.status(500).json({ success: false, id }) }\n` +
          `async function h(req: any, res: any) { try { await x() } catch (error) { log(error); fail(res, req.params.id) } }`
      )
    ).toBe(0)
    expect(
      flaggedFile(
        `export function make(logger: any) { return { sendAdminWriteFailure: (res: any, context: string, error: unknown, extra?: object) => {\n` +
          `  logger.error(context, error); res.status(500).json({ ...extra, success: false, error: 'fixed' }) } } }`
      )
    ).toBe(0)
  })

  it('mutation self-proof: at EVERY responder call site in the tree, each of twelve echo shapes is flagged', () => {
    type Built = { expr?: string; stmts?: string; helper?: string }
    const caught = (c: ResponderCall) => c.catchVar ?? 'error'
    const shapes: Array<{ id: string; build: (c: ResponderCall, k: number) => Built }> = [
      { id: 'chained .message', build: (c) => ({ expr: `${c.resText}.status(500).json({ success: false, error: (${caught(c)} as Error).message })` }) },
      { id: 'chained String()', build: (c) => ({ expr: `${c.resText}.status(500).json({ success: false, error: String(${caught(c)}) })` }) },
      { id: 'responder extra', build: (c) => ({ expr: `${c.name}(${c.resText}, 'ctx', ${caught(c)}, { detail: (${caught(c)} as Error).message })` }) },
      {
        id: 'assignment-derived local',
        build: (c, k) => ({ stmts: `let detail${k} = ''; detail${k} = String(${caught(c)}); ${c.resText}.status(500).json({ success: false, error: detail${k} });` }),
      },
      {
        id: 'property-assigned body',
        build: (c, k) => ({ stmts: `const body${k}: Record<string, unknown> = { success: false }; body${k}.error = String(${caught(c)}); ${c.resText}.status(500).json(body${k});` }),
      },
      { id: 'split status', build: (c) => ({ stmts: `${c.resText}.status(500); ${c.resText}.json({ success: false, error: String(${caught(c)}) });` }) },
      { id: 'statusCode assignment', build: (c) => ({ stmts: `${c.resText}.statusCode = 500; ${c.resText}.json({ success: false, error: String(${caught(c)}) });` }) },
      {
        id: 'same-file helper',
        build: (c, k) => ({
          expr: `echoFail${k}(${c.resText}, ${caught(c)})`,
          helper: `function echoFail${k}(r: any, e: unknown): void { r.status(500).json({ success: false, error: String(e) }) }`,
        }),
      },
      {
        id: 'for…of binding',
        build: (c, k) => ({ stmts: `for (const each${k} of [${caught(c)}]) { ${c.resText}.status(500).json({ success: false, error: String(each${k}) }); }` }),
      },
      {
        id: 'Map container',
        build: (c, k) => ({
          stmts: `const bag${k} = new Map<string, unknown>(); bag${k}.set('e', ${caught(c)}); ${c.resText}.status(500).json({ success: false, error: String(bag${k}.get('e')) });`,
        }),
      },
      {
        id: 'receiver alias split status',
        build: (c, k) => ({ stmts: `const out${k} = ${c.resText}; ${c.resText}.status(500); out${k}.json({ success: false, error: String(${caught(c)}) });` }),
      },
      {
        id: 'split status, chained body',
        build: (c) => ({ stmts: `${c.resText}.status(500); ${c.resText}.set('X-Trace', 'fixed').json({ success: false, error: String(${caught(c)}) });` }),
      },
    ]
    expect(shapes).toHaveLength(12)
    const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length

    let total = 0
    const missed: string[] = []
    for (const rel of treeFiles()) {
      const source = readRoute(rel)
      const calls = [...scanResponseErrorEcho(rel, source).responderCalls].sort((x, y) => x.start - y.start)
      if (calls.length === 0) continue
      for (const shape of shapes) {
        // Rewrite EVERY site of the file at once, remembering where each site's echo now lives.
        let out = ''
        let cursor = 0
        const spans: Array<{ line: number; helper?: string; from: number; to: number }> = []
        calls.forEach((c, k) => {
          const built = shape.build(c, k)
          const asStatement = built.stmts !== undefined && c.stmtStart !== null && c.stmtEnd !== null
          const from = asStatement ? (c.stmtStart as number) : c.start
          const to = asStatement ? (c.stmtEnd as number) : c.end
          const replacement =
            built.stmts === undefined ? (built.expr as string) : asStatement ? `{ ${built.stmts} }` : `(() => { ${built.stmts} })()`
          out += source.slice(cursor, from)
          const at = out.length
          out += replacement
          cursor = to
          spans.push({ line: c.line, helper: built.helper, from: at, to: at + replacement.length })
        })
        out += source.slice(cursor)
        // A helper's echo lives in the helper: attribute the site to its own helper.
        for (const span of spans) {
          if (span.helper === undefined) continue
          out += '\n'
          span.from = out.length
          out += span.helper
          span.to = out.length
        }
        const offenderLines = scanResponseErrorEcho(rel, out).offenders.map((o) => o.line)
        for (const span of spans) {
          total += 1
          const first = lineAt(out, span.from)
          const last = lineAt(out, span.to)
          if (!offenderLines.some((line) => line >= first && line <= last)) {
            missed.push(`${rel}:${span.line} <- ${shape.id}`)
          }
        }
      }
    }
    expect(missed).toEqual([])
    expect(total).toBeGreaterThanOrEqual(49 * shapes.length)
  })
})
