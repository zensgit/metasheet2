// Shared real-host boot for the #6315 YiDa host boundary proofs. It starts the actual
// MetaSheetServer (createPluginContext, readEnablement wiring, stopOnce) with the real
// plugin-integration-core plus one synthetic near-miss fixture plugin, against a fully
// migrated PostgreSQL. Users, tenant, password and JWT secret are random per boot.
// The host's YiDa egress (the fetch bound at construction, src/index.ts ~:645) refuses and is
// counted; no other egress is configured in this step.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import * as bcrypt from 'bcryptjs'
import { Pool } from 'pg'
import { vi } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import type { createYidaInitializationRuntime } from '../../src/integration/yida-initialization-runtime'
import type { createYidaConnectionTestRuntime } from '../../src/integration/yida-connection-test-runtime'
import type { createYidaOwnerRuntime } from '../../src/integration/yida-owner-runtime'

export const CORE_PLUGIN = 'plugin-integration-core'
export const FIXTURE_PLUGIN = 'plugin-integration-core-shadow'
const FIXTURE_KEY = Symbol.for('metasheet.test.yida-host-boundary.fixture')
// Keys this harness overrides; every one is restored (or deleted again) by cleanup().
// RBAC_BYPASS is not listed: no module under src/ reads it, so overriding it proves nothing.
const ENV_KEYS = ['SKIP_PLUGINS', 'PORT', 'RBAC_TOKEN_TRUST', 'JWT_SECRET', 'INTEGRATION_YIDA_OWNER_SEND_ENABLED',
  'INTEGRATION_YIDA_CONNECTION_TEST_ENABLED'] as const
const WINDOW_MS = 2000

export type FixtureObservation = Readonly<{ called: boolean; securityType: string; owner: unknown; init: unknown; probe: unknown }>
export type HostActor = Readonly<{ actorId: string; tenantId: string; workspaceId: null }>
export type HostUser = Readonly<{ id: string; token: string }>
export type HttpResult = Readonly<{ status: number; headers: IncomingHttpHeaders; body: Record<string, unknown> }>
type PluginState = { status: string; error?: string }
// Private members of the real host. The boundaries live there; nothing below re-implements them.
export type HostPrivate = {
  pluginStatus: Map<string, PluginState>
  pluginLoader: { getPlugins(): Map<string, unknown> }
  yidaOwnerRuntime: ReturnType<typeof createYidaOwnerRuntime>
  yidaInitializationRuntime: ReturnType<typeof createYidaInitializationRuntime>
  yidaConnectionTestRuntime: ReturnType<typeof createYidaConnectionTestRuntime>
}
export type YidaHostBoundaryHarness = Readonly<{
  server: MetaSheetServer
  host: HostPrivate
  tenantId: string
  admin: HostUser
  reader: HostUser
  adminActor: HostActor
  pool: Pool
  internalPool: Pool
  exportedPool: Pool | null
  mainPool(): Pool
  importMs: number
  bootMs: number
  fetchCalls(): number
  fixtureObservation(): FixtureObservation | undefined
  http(method: string, pathname: string, token: string, body?: unknown): Promise<HttpResult>
  yidaTableCounts(): Promise<Record<string, number>>
  cleanup(): Promise<void>
}>

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function request(baseUrl: string, method: string, pathname: string, token: string | undefined, body?: unknown): Promise<HttpResult> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    // agent:false closes every socket after its response, so no idle keep-alive connection can
    // hold closeHttpServerForShutdown (an earlier stopOnce barrier) and mask the YiDa barrier.
    const req = httpRequest(new URL(pathname, baseUrl), {
      method,
      agent: false,
      headers: {
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('error', reject)
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: Record<string, unknown>
        try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { parsed = { unparsed: true } }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed })
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('YIDA_HOST_BOUNDARY_HTTP_TIMEOUT')))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

async function writeFixturePlugin(root: string): Promise<string> {
  const dir = path.join(root, FIXTURE_PLUGIN)
  await mkdir(dir)
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ name: FIXTURE_PLUGIN, version: '0.0.1', main: 'index.cjs' }))
  // Records exactly what the host hands a plugin whose name is a near miss of the core plugin.
  // `security` is given to every plugin, so it is the positive control that services are real.
  await writeFile(path.join(dir, 'index.cjs'), [
    "'use strict'",
    "const key = Symbol.for('metasheet.test.yida-host-boundary.fixture')",
    'module.exports = {',
    '  async activate(context) {',
    '    const services = (context && context.services) || {}',
    '    globalThis[key] = Object.freeze({ called: true, securityType: typeof services.security,',
    '      owner: services.yidaOwnerRuntime, init: services.yidaInitializationRuntime, probe: services.yidaConnectionTestRuntime })',
    '  },',
    '  async deactivate() {},',
    '}',
    '',
  ].join('\n'))
  return dir
}

export async function bootYidaHostBoundaryServer(): Promise<YidaHostBoundaryHarness> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('YIDA_HOST_BOUNDARY_DATABASE_REQUIRED')
  const globals = globalThis as unknown as Record<symbol, unknown>
  if (globals[FIXTURE_KEY] !== undefined) throw new Error('YIDA_HOST_BOUNDARY_STALE_FIXTURE')
  const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]))
  const realFetch = globalThis.fetch
  let fetchCalls = 0
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const tenantId = randomUUID()
  const users = { admin: randomUUID(), reader: randomUUID() }
  let seeded = false
  let fixtureRoot: string | undefined
  let server: MetaSheetServer | undefined
  let internalPool: Pool | undefined
  let cleaned = false

  async function cleanup(): Promise<void> {
    if (cleaned) return
    cleaned = true
    const failures: unknown[] = []
    // stop() is idempotent: after the barrier test this is the same settled promise.
    if (server) await server.stop('TEST_CLEANUP').catch(error => failures.push(error))
    // A stop that failed before pool.end() leaves the pool open; end it exactly once.
    const internal = internalPool as (Pool & { ending?: boolean }) | undefined
    if (internal && internal.ending !== true) await internal.end().catch(error => failures.push(error))
    globalThis.fetch = realFetch
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (seeded) {
      // Exactly the rows this boot seeded (and the sessions its own logins opened).
      const ids = [users.admin, users.reader]
      try {
        await pool.query('DELETE FROM user_sessions WHERE user_id = ANY($1::text[])', [ids])
        await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ids])
        await pool.query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[]) AND org_id = $2', [ids, tenantId])
        await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids])
      } catch (error) { failures.push(error) }
    }
    await pool.end().catch(error => failures.push(error))
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }).catch(error => failures.push(error))
    delete globals[FIXTURE_KEY]
    if (failures.length > 0) throw new Error(`YIDA_HOST_BOUNDARY_CLEANUP_FAILED:${failures.length}`)
  }

  try {
    const password = randomBytes(24).toString('base64url')
    const hash = await bcrypt.hash(password, 10)
    const identifiers = {
      admin: `yida-host-${randomBytes(8).toString('hex')}@example.invalid`,
      reader: `yida-host-${randomBytes(8).toString('hex')}@example.invalid`,
    }
    seeded = true
    // Admin actor: legacy role admin, active, activated, local password, live membership, user_roles admin.
    // Reader: same login shape, role user, membership only (passes JWT, fails the live integration ACL).
    for (const [user, role] of [['admin', 'admin'], ['reader', 'user']] as const) {
      await pool.query(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active,
          must_change_password, activation_status, local_password_set)
        VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, true, false, 'activated', true)`,
      [users[user], identifiers[user], `Synthetic YiDa host ${user}`, hash, role])
      await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [users[user], tenantId])
    }
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [users.admin])

    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'yida-host-boundary-'))
    const fixtureDir = await writeFixturePlugin(fixtureRoot)
    const corePluginDir = path.resolve(__dirname, '..', '..', '..', '..', 'plugins', CORE_PLUGIN)

    process.env.SKIP_PLUGINS = 'false'
    delete process.env.PORT
    // setup.integration.ts trusts token claims; the real login token must take the AuthService
    // database path instead. src/rbac/rbac.ts reads this at module load, so it is set BEFORE the
    // first import of src/index below; AuthService reads it per request.
    process.env.RBAC_TOKEN_TRUST = 'false'
    process.env.JWT_SECRET = randomBytes(32).toString('hex')
    delete process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED
    delete process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED
    // Installed before import AND construction: the host binds globalThis.fetch into the owner
    // runtime inside its constructor, so the runtime can only ever reach this refusing stub.
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('YIDA_HOST_BOUNDARY_FETCH_FORBIDDEN')
    }) as typeof fetch

    const imported = performance.now()
    const { MetaSheetServer: Server } = await import('../../src/index')
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const pg = await import('../../src/db/pg')
    internalPool = poolManager.get().getInternalPool()
    const started = performance.now()
    const importMs = started - imported
    server = new Server({
      port: 0,
      host: '127.0.0.1',
      manageProcessSignals: false,
      pluginDirs: [corePluginDir, fixtureDir],
    })
    await server.start()
    const bootMs = performance.now() - started
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('YIDA_HOST_BOUNDARY_ADDRESS_UNAVAILABLE')
    const baseUrl = `http://127.0.0.1:${address.port}`

    async function login(user: 'admin' | 'reader'): Promise<HostUser> {
      const result = await request(baseUrl, 'POST', '/api/auth/login', undefined, { identifier: identifiers[user], password })
      const data = result.body.data as { token?: unknown; user?: { id?: unknown; tenantId?: unknown } } | undefined
      if (result.status !== 200 || result.body.success !== true || data?.user?.id !== users[user]
        || data?.user?.tenantId !== tenantId || typeof data?.token !== 'string' || !data.token) {
        throw new Error(`YIDA_HOST_BOUNDARY_LOGIN_FAILED:${user}:${result.status}`)
      }
      return Object.freeze({ id: users[user], token: data.token })
    }
    const admin = await login('admin')
    const reader = await login('reader')

    return Object.freeze({
      server,
      host: server as unknown as HostPrivate,
      tenantId,
      admin,
      reader,
      adminActor: Object.freeze({ actorId: users.admin, tenantId, workspaceId: null }),
      pool,
      internalPool,
      exportedPool: pg.pool,
      mainPool: () => poolManager.get().getInternalPool(),
      importMs,
      bootMs,
      fetchCalls: () => fetchCalls,
      fixtureObservation: () => globals[FIXTURE_KEY] as FixtureObservation | undefined,
      http: (method: string, pathname: string, token: string, body?: unknown) => request(baseUrl, method, pathname, token, body),
      async yidaTableCounts() {
        const tables = await pool.query<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND starts_with(table_name, 'integration_yida_')
          ORDER BY table_name`)
        const counts: Record<string, number> = {}
        for (const { name } of tables.rows) {
          if (!/^integration_yida_[a-z0-9_]+$/u.test(name)) throw new Error('YIDA_HOST_BOUNDARY_TABLE_NAME')
          counts[name] = (await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM "${name}"`)).rows[0].count
        }
        return counts
      },
      cleanup,
    })
  } catch (error) {
    await cleanup().catch(() => undefined)
    throw error
  }
}

// One lock-held run across server.stop(). The probe supplies the external hold, the private runtime
// call and the pg_locks waiter query; this function only measures what the host does meanwhile.
export type ShutdownBarrierProbe = Readonly<{
  hold(): Promise<void>
  start(): Promise<unknown>
  waiting(): Promise<boolean>
  release(): Promise<void>
}>
export type ShutdownBarrierObservation = Readonly<{
  waiterSeen: boolean
  pluginsBeforeStop: number
  sameStopPromise: boolean
  // Each runtime's latch, read synchronously right after stop() returned and before any await.
  latchAtStop: Readonly<{ owner: string; init: string }>
  stageReached: boolean
  window: Readonly<{ ms: number; samples: number; endCalls: number; ending: boolean; waiterAlways: boolean;
    runSettled: boolean; stopSettled: boolean }>
  runFulfilled: boolean
  runRejection: unknown
  stopSettled: boolean
  stopError: unknown
  endCalls: number
  ending: boolean
  events: readonly string[]
  timings: Readonly<{ waiterMs: number; stopToStageMs: number; releaseToRunMs: number; releaseToStopMs: number }>
}>

// On a terminal runtime createPluginCapability() only throws INACTIVE and changes nothing
// (yida-owner-runtime.ts ~:292, yida-initialization-runtime.ts ~:287). Only a host that failed to
// latch can reach the issuing branch; the unused capability is dropped and reported by name.
function latchState(create: () => unknown, decode: (error: unknown) => string | undefined): string {
  try { create() } catch (error) { return decode(error) ?? 'UNDECODED_REFUSAL' }
  return 'CAPABILITY_ISSUED'
}

async function poll(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (performance.now() >= deadline) return false
    await sleep(intervalMs)
  }
}

export async function proveShutdownBarrier(h: YidaHostBoundaryHarness, probe: ShutdownBarrierProbe): Promise<ShutdownBarrierObservation> {
  // The modules' own decoders (WeakMap-backed), so no foreign message text is examined.
  const { yidaOwnerRuntimeErrorCode } = await import('../../src/integration/yida-owner-runtime')
  const { yidaInitializationErrorCode } = await import('../../src/integration/yida-initialization-runtime')
  const events: string[] = []
  const internal = h.internalPool as Pool & { ending?: boolean }
  const originalEnd = internal.end
  // The deciding signal: pg-pool sets `ending` synchronously inside end(). Whether stop() has
  // settled proves nothing, because end() also waits for the blocked checked-out client.
  const endSpy = vi.spyOn(internal, 'end').mockImplementation((() => {
    events.push('pool-end')
    return originalEnd.call(internal)
  }) as typeof internal.end)
  let runFulfilled = false
  let runRejection: unknown
  let runSettled = false
  let stopSettled = false
  let stopError: unknown
  let stopped: Promise<void> | undefined
  try {
    await probe.hold()
    const runStarted = performance.now()
    const run = probe.start()
    run.then(() => { runFulfilled = true }, error => { runRejection = error })
      .finally(() => { runSettled = true; events.push('run-settled') })
    const waiterSeen = await poll(probe.waiting, 10000, 25)
    const waiterMs = performance.now() - runStarted
    if (!waiterSeen) throw new Error('YIDA_HOST_BOUNDARY_WAITER_NOT_SEEN')
    const pluginsBeforeStop = h.host.pluginLoader.getPlugins().size

    const stopCalled = performance.now()
    stopped = h.server.stop('TEST')
    // stop() returns at stopOnce's first await (src/index.ts ~:3822), so both runtimes must already
    // be terminal here; HTTP close and the approval barriers are only awaited after that point.
    const latchAtStop = Object.freeze({
      owner: latchState(() => h.host.yidaOwnerRuntime.createPluginCapability(), yidaOwnerRuntimeErrorCode),
      init: latchState(() => h.host.yidaInitializationRuntime.createPluginCapability(), yidaInitializationErrorCode),
    })
    const sameStopPromise = h.server.stop('REPEAT') === stopped
    stopped.catch(error => { stopError = error })
      .finally(() => { stopSettled = true; events.push('stop-settled') })
    // unloadAll empties the plugin map synchronously while stopOnce builds shutdownTasks, so an
    // empty map means every earlier stage (HTTP close, approval barriers) is behind us.
    const stageReached = await poll(() => h.host.pluginLoader.getPlugins().size === 0, 9000, 10)
    const stopToStageMs = performance.now() - stopCalled
    if (!stageReached) throw new Error('YIDA_HOST_BOUNDARY_SHUTDOWN_STAGE_NOT_REACHED')

    // Fixed observation window, well under the host's 10 s waitForShutdownBarrier timeout.
    const windowStart = performance.now()
    let samples = 0, endCalls = 0, ending = false, waiterAlways = true, runSettledInWindow = false, stopSettledInWindow = false
    while (performance.now() - windowStart < WINDOW_MS) {
      samples += 1
      endCalls = Math.max(endCalls, endSpy.mock.calls.length)
      ending ||= internal.ending === true
      runSettledInWindow ||= runSettled
      stopSettledInWindow ||= stopSettled
      if (!(await probe.waiting())) waiterAlways = false
      await sleep(50)
    }
    const windowMs = performance.now() - windowStart
    endCalls = Math.max(endCalls, endSpy.mock.calls.length)
    ending ||= internal.ending === true

    const released = performance.now()
    await probe.release()
    await poll(() => runSettled, 10000, 10)
    const releaseToRunMs = performance.now() - released
    await poll(() => stopSettled, 15000, 10)
    const releaseToStopMs = performance.now() - released
    return Object.freeze({
      waiterSeen,
      pluginsBeforeStop,
      sameStopPromise,
      latchAtStop,
      stageReached,
      window: Object.freeze({ ms: windowMs, samples, endCalls, ending, waiterAlways,
        runSettled: runSettledInWindow, stopSettled: stopSettledInWindow }),
      runFulfilled,
      runRejection,
      stopSettled,
      stopError,
      endCalls: endSpy.mock.calls.length,
      ending: internal.ending === true,
      events: Object.freeze([...events]),
      timings: Object.freeze({ waiterMs, stopToStageMs, releaseToRunMs, releaseToStopMs }),
    })
  } finally {
    // Failure paths: never leave the external lock held behind a pending stop.
    await probe.release().catch(() => undefined)
    if (stopped) await poll(() => stopSettled, 15000, 10)
    endSpy.mockRestore()
  }
}
