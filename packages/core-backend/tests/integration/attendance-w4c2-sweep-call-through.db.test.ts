/**
 * #4770 (W4C-2 recovery-sweep fairness/observability/call-through; owner ruling 2026-08-05,
 * baseline `db74bd8667df1084797c97d872fe53ef845e3803`) — the THREE named call-through legs, each
 * proven against a REAL booted `MetaSheetServer` + REAL `plugin-attendance` (loaded from
 * `pluginDirs`, not mocked) and a REAL PostgreSQL connection. Source-string assertions (as the
 * pre-existing `attendance-w4c2-recovery-wiring.test.ts` uses) do not go red when a route or
 * scheduler registration is REMOVED — this file does, by construction, because each leg's
 * positive assertion depends on the production wiring actually executing:
 *
 *  1. **core host sweep/abandon port wiring** — a probe plugin captures
 *     `context.services.attendanceW4SegmentCalculation` directly (the SAME object
 *     `plugin-attendance` itself reads at activation) and invokes `.sweepScheduledRuns()` /
 *     `.abandonScheduledRun()` WITHOUT going through the plugin's own route/scheduler layer at
 *     all — removing either property from `packages/core-backend/src/index.ts`'s port object
 *     makes the captured method `undefined`, and calling it throws `TypeError`.
 *  2. **`attendance-w4-scheduled-run-sweep` scheduled job — real registration & execution** —
 *     the REAL plugin's `activate()` registers the job with the REAL shared
 *     `AttendanceScheduler`; this file forces ONE cycle (`getSharedAttendanceScheduler()!.
 *     runCycle()`, bypassing the real interval) and asserts a REAL seeded `running` row got
 *     durably touched (`last_attempt_at` stamped) — impossible unless the job is both
 *     registered AND actually invoked by the scheduler's job loop.
 *  3. **abandon HTTP route — auth/org/host chain** — real HTTP requests through the booted
 *     server (real JWT via the dev-token mint route, real DB-backed RBAC — `RBAC_BYPASS` is
 *     deliberately OFF in this file, unlike sibling route-test files, specifically so the
 *     permission-denied leg is genuine, not bypassed) covering: success (state flips to
 *     `abandoned`), missing token (401), insufficient permission (403, zero DML), and a
 *     wrong-org run id (404 `ATTENDANCE_SCHEDULED_RUN_NOT_FOUND`-shaped, zero DML on the real
 *     row — the org-scoped SQL lookup, not a body-supplied org match, is what actually refuses
 *     it).
 *  4. **production tick-observability wiring (#4774 P2-1 closure)** — `index.ts:2249`'s
 *     `logger: this.logger` is the ONLY line that makes the #4770 tick/backlog/error
 *     observability actually emit in production; the pre-existing gate-3 tests all inject their
 *     OWN fake logger, which stays green even if that one production line is deleted (proven by
 *     mutation during review — 13/13 + 3/3 + 102/102 all green with the line removed). This leg
 *     spies on the REAL `Logger` instance the booted `MetaSheetServer` constructed (never a
 *     test-supplied logger) and calls `hostPort.sweepScheduledRuns()` (door 1's real port) —
 *     deleting `logger: this.logger` makes the sweep fall back to its silent no-op logger, and
 *     this spy would never observe the tick line.
 *
 * Mutation self-checks for all three legs (removing the port property / the scheduler
 * registration block / the route registration block) were run by hand during review — see the
 * PR body — not automated here (permanently shipping "delete my own wiring" as a CI leg would
 * just re-test the pre-#4770 code path forever).
 *
 * Isolation: `attendance-w4-scheduled-run-sweep`'s PRODUCTION registration hardcodes the
 * default scan limit (25, no caller-supplied override) — unlike the fairness-fix file, leg 2
 * cannot widen its own limit to outrun backlog noise. Several PRE-EXISTING sibling
 * "(real DB, route-level)" suites in this same directory boot a server against the SHARED
 * `DATABASE_URL` and leave `attendance_scheduled_runs` rows in `state='running'` (fixtures for
 * their own, unrelated assertions) — in CI these files run in the SAME workflow step against
 * the SAME `metasheet_test` database, so relying on "the shared DB has fewer than 25 stray
 * running rows" would be exactly the kind of shared-DB collision this repo's fixture-isolation
 * doctrine forbids. This file therefore provisions its OWN freshly-migrated scratch database
 * (full migration set, not a hand-picked subset) so its `attendance_scheduled_runs` table is
 * empty except for what THIS file itself seeds.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

type JsonResponse = { status: number; body: Record<string, any> | null; raw: string }

function canListen(): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = options.body ? JSON.stringify(options.body) : null
    const request = http.request({
      method: options.method ?? 'GET',
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...options.headers,
      },
    }, (response) => {
      let raw = ''
      response.on('data', (chunk) => { raw += String(chunk) })
      response.on('end', () => {
        let body: Record<string, any> | null = null
        try { body = raw ? JSON.parse(raw) as Record<string, any> : null } catch { body = null }
        resolve({ status: response.statusCode ?? 0, body, raw })
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function installLoadedPlugin(server: MetaSheetServer, name: string, plugin: Record<string, unknown>) {
  const loader = (server as unknown as { pluginLoader: { loadedPlugins: Map<string, unknown> } }).pluginLoader
  loader.loadedPlugins.set(name, {
    manifest: { name, version: '1.0.0', displayName: name, description: `${name} #4770 probe` },
    plugin,
    path: `/tmp/${name}`,
    loadedAt: new Date(),
  })
}

describeIfDatabase('W4C-2 #4770 recovery-sweep call-through (real server, real plugin, real PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  // Door 1: captured directly from a probe plugin's OWN `context.services` — never read off
  // plugin-attendance's internal state (which is not test-visible).
  let hostPort: {
    sweepScheduledRuns: (options: {
      limit?: number
      recoverCandidate(candidate: { orgId: string; initiator: string; workDate: string; runId: string }): Promise<void>
    }) => Promise<{
      scanned: number
      finalized: number
      notReady: number
      skipped: number
      errored: number
      backlogRemaining: number
      neverAttemptedRunning: number
      oldestRunningAttemptAgeSeconds: number
    }>
    abandonScheduledRun: (input: {
      orgId: string
      runId: string
      adminActorId: string
      reasonCode: string
    }) => Promise<{ kind: string; [key: string]: unknown }>
  } | null = null

  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    rbacBypass: process.env.RBAC_BYPASS,
    skipPlugins: process.env.SKIP_PLUGINS,
    rollout: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
    schedulerEnabled: process.env.ATTENDANCE_SCHEDULER_ENABLED,
    schedulerIntervalMs: process.env.ATTENDANCE_SCHEDULER_INTERVAL_MS,
  }

  async function mintToken(userId: string): Promise<string> {
    const response = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}`)
    const token = response.body?.token
    if (typeof token !== 'string' || !token) throw new Error(`failed to mint token: ${response.raw}`)
    return token
  }

  async function seedRolloutOrg(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1,'legacy','v1','w4c2sweepcallthrough-seed','w4c2sweepcallthrough-actor',1,NULL)`,
      [orgId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state SET state = 'shadow', prior_state = 'legacy', version = 2 WHERE org_id = $1`,
      [orgId],
    )
  }

  /** DB-backed `user_roles`/`user_permissions` — genuine RBAC (RBAC_BYPASS is OFF in this
   *  file), unlike `users.permissions` JSONB (which `withAnyPermission`'s own DB check never
   *  reads). */
  async function seedUser(opts: { admin?: boolean; permissionCode?: string }): Promise<{ userId: string; token: string }> {
    const userId = randomUUID()
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'W4C-2 #4770 call-through fixture', 'x', 'user', '[]'::jsonb, TRUE, FALSE, 'activated')`,
      [userId, `w4c2sweepcallthrough-${userId}@example.test`],
    )
    if (opts.admin) {
      await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')`, [userId])
    }
    if (opts.permissionCode) {
      await pool.query(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)`, [userId, opts.permissionCode])
    }
    return { userId, token: await mintToken(userId) }
  }

  async function withAllowlist<T>(orgIds: readonly string[], fn: () => Promise<T>): Promise<T> {
    const prior = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = [prior, ...orgIds].filter(Boolean).join(',')
    try {
      return await fn()
    } finally {
      if (prior === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = prior
    }
  }

  /** Seeds ONE stuck `running` scheduled run directly through the real core transactional
   *  functions (never a raw INSERT — the table's own triggers reject anything that does not
   *  look like a real run). Its target is never sealed, so it stays `not_ready`/`running`
   *  forever — a genuine "cannot progress" fixture, not a timing artifact. */
  async function createStuckRun(orgId: string, workDate: string): Promise<{ runId: string; userId: string }> {
    const {
      createOrResumeAttendanceScheduledRunV1,
    } = await import('../../src/attendance/w4c2-scheduled-run')
    const { runAttendanceResultOperationTransactionV1 } = await import('../../src/attendance/w4c0-operation-registry')
    const userId = randomUUID()
    const client = await pool.connect()
    try {
      const created = await withAllowlist([orgId], () =>
        runAttendanceResultOperationTransactionV1(client as any, (trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            async () => [{ userId, targetKind: 'generate', reviewReasonCode: null }],
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error(`expected created_running, got ${created.kind}`)
      return { runId: created.runId, userId }
    } finally {
      client.release()
    }
  }

  async function runRow(runId: string): Promise<{ state: string; last_attempt_at: string | null; abandon_reason_code: string | null }> {
    const r = await pool.query(
      'SELECT state, last_attempt_at, abandon_reason_code FROM attendance_scheduled_runs WHERE run_id = $1::uuid',
      [runId],
    )
    return r.rows[0]
  }

  let adminPool: Pool
  let scratchName: string

  beforeAll(async () => {
    if (!dbUrl || !(await canListen())) throw new Error('W4C2_SWEEP_CALL_THROUGH_TEST_REQUIRES_DATABASE_AND_LOOPBACK')

    // Provision an isolated, freshly-migrated scratch database (see file-header isolation
    // note) BEFORE anything imports `../../src/index` (whose `poolManager`/`db` singletons bind
    // to `process.env.DATABASE_URL` at MODULE LOAD TIME).
    scratchName = `ms2_w4c2sweepct_${randomUUID().slice(0, 12).replace(/-/g, '')}`
    const adminUrl = new URL(dbUrl)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl)
    scratchUrl.pathname = `/${scratchName}`
    const scratchConnectionString = scratchUrl.toString()

    // Migrate via the SAME CLI script `pnpm migrate` uses (`tsx src/db/migrate.ts`), as a child
    // process — NOT an in-process `Migrator` (kysely's `FileMigrationProvider` dynamically
    // `import()`s each migration file from `node_modules` code, which is outside vitest/vite-
    // node's own TS transform graph; `tsx`'s loader hook resolves those nested extensionless
    // relative imports — e.g. one migration's `./_patterns` — correctly, while running the same
    // dynamic import from inside the vitest process does not).
    const coreBackendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const { execFileSync } = await import('node:child_process')
    execFileSync('pnpm', ['exec', 'tsx', 'src/db/migrate.ts'], {
      cwd: coreBackendDir,
      env: { ...process.env, DATABASE_URL: scratchConnectionString },
      stdio: 'pipe',
    })

    process.env.DATABASE_URL = scratchConnectionString
    // Deliberately OFF (unlike sibling route-test files) — the permission-denied leg (door 3)
    // needs GENUINE DB-backed RBAC, not a bypass.
    process.env.RBAC_BYPASS = 'false'
    process.env.SKIP_PLUGINS = 'false'
    // Non-empty at plugin-activation time only to get BOTH env-gated jobs (outbox-drain, sweep)
    // registered once — the actual per-org allowlist check happens live at call time via
    // `withAllowlist` (see #4770 fairness-test file's own doc comment).
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = `w4c2sweepcallthrough-bootstrap-${randomUUID()}`
    process.env.ATTENDANCE_SCHEDULER_ENABLED = 'true'
    // Long enough that the real interval never fires during this file's run; door 2 forces a
    // single cycle directly via `runCycle()`.
    process.env.ATTENDANCE_SCHEDULER_INTERVAL_MS = '3600000'

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const loaded = await import('../../src/index')
    server = new loaded.MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('attendance server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: scratchConnectionString })

    // Door 1 setup: `attendanceW4SegmentCalculation` is LEAST-PRIVILEGE gated in
    // `packages/core-backend/src/index.ts` (`manifest.name === 'plugin-attendance' ? {...} :
    // undefined`) — only the plugin literally named `plugin-attendance` ever receives it, so an
    // arbitrarily-named probe plugin cannot capture it. Instead: deactivate the REAL
    // plugin-attendance (already loaded from `pluginDirs` above), then reinstall + reactivate
    // the SAME cached CJS module (Node's require cache is per-path, so this is the identical
    // module instance the loader used — its own internal `attendanceW4SegmentCalculationPort`
    // closure state gets reset cleanly by this deactivate/reactivate round-trip, matching the
    // plugin runtime's own designed teardown/reload contract) under a THIN wrapper that ALSO
    // stashes the real, freshly-granted port for this file's direct-call assertions.
    const pluginRequire = createRequire(import.meta.url)
    const pluginModulePath = path.join(repoRoot, 'plugins', 'plugin-attendance', 'index.cjs')
    const realPluginModule = pluginRequire(pluginModulePath) as {
      activate(context: unknown): Promise<void>
      deactivate?(): Promise<void>
    }
    await (server as unknown as { deactivatePluginByName(name: string): Promise<unknown> }).deactivatePluginByName(
      'plugin-attendance',
    )
    installLoadedPlugin(server, 'plugin-attendance', {
      async activate(context: any) {
        hostPort = context.services?.attendanceW4SegmentCalculation ?? null
        return realPluginModule.activate(context)
      },
      async deactivate() {
        return realPluginModule.deactivate ? realPluginModule.deactivate() : undefined
      },
    })
    await (server as unknown as { activatePluginByName(name: string): Promise<unknown> }).activatePluginByName(
      'plugin-attendance',
    )
  }, 120000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
    await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
    await adminPool?.end().catch(() => undefined)
    for (const [key, value] of Object.entries({
      DATABASE_URL: priorEnv.databaseUrl,
      RBAC_BYPASS: priorEnv.rbacBypass,
      SKIP_PLUGINS: priorEnv.skipPlugins,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: priorEnv.rollout,
      ATTENDANCE_SCHEDULER_ENABLED: priorEnv.schedulerEnabled,
      ATTENDANCE_SCHEDULER_INTERVAL_MS: priorEnv.schedulerIntervalMs,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }, 60000)

  // ===============================================================================================
  // Leg 1 — core host sweep/abandon port wiring.
  // ===============================================================================================
  describe('leg 1 — core host port wiring (direct, bypassing the plugin route/scheduler layer)', () => {
    it('port.sweepScheduledRuns performs a REAL sweep against a REAL seeded row', async () => {
      expect(hostPort, 'probe plugin must have captured context.services.attendanceW4SegmentCalculation').not.toBeNull()
      const orgId = randomUUID()
      await seedRolloutOrg(orgId)
      const stuck = await createStuckRun(orgId, '2026-04-01')
      expect((await runRow(stuck.runId)).last_attempt_at).toBeNull()

      const result = await withAllowlist([orgId], () =>
        hostPort!.sweepScheduledRuns({ limit: 25, async recoverCandidate() {} }),
      )
      expect(result.scanned).toBeGreaterThanOrEqual(1)
      const row = await runRow(stuck.runId)
      expect(row.last_attempt_at).not.toBeNull()
      expect(row.state).toBe('running')
    })

    it('port.abandonScheduledRun performs a REAL abandon against a REAL seeded row', async () => {
      expect(hostPort).not.toBeNull()
      const orgId = randomUUID()
      await seedRolloutOrg(orgId)
      const stuck = await createStuckRun(orgId, '2026-04-02')
      const adminActorId = randomUUID()

      const outcome = await withAllowlist([orgId], () =>
        hostPort!.abandonScheduledRun({
          orgId,
          runId: stuck.runId,
          adminActorId,
          reasonCode: 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
        }),
      )
      expect(outcome.kind).toBe('abandoned')
      const row = await runRow(stuck.runId)
      expect(row.state).toBe('abandoned')
      expect(row.abandon_reason_code).toBe('ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED')
    })
  })

  // ===============================================================================================
  // Leg 2 — `attendance-w4-scheduled-run-sweep` scheduled job: real registration & real execution.
  // ===============================================================================================
  describe('leg 2 — scheduled job real registration and execution', () => {
    it('forcing ONE real scheduler cycle sweeps a REAL seeded row through the REGISTERED plugin job (not a direct call)', async () => {
      const { getSharedAttendanceScheduler } = await import('../../src/services/AttendanceScheduler')
      const scheduler = getSharedAttendanceScheduler()
      expect(scheduler, 'ATTENDANCE_SCHEDULER_ENABLED=true at boot must have started the shared scheduler').not.toBeNull()

      const orgId = randomUUID()
      await seedRolloutOrg(orgId)
      const stuck = await createStuckRun(orgId, '2026-04-03')
      expect((await runRow(stuck.runId)).last_attempt_at).toBeNull()

      // The tick loop's own job list is NOT scoped to this org — other registered jobs
      // (report-digest, annual-leave-accrual, etc.) also run this cycle; each is independently
      // try/caught by `runCycle()`, so this is a genuine unscoped production cycle, not a
      // synthetic single-job invocation.
      await withAllowlist([orgId], () => scheduler!.runCycle())

      const row = await runRow(stuck.runId)
      expect(row.last_attempt_at, 'the REGISTERED attendance-w4-scheduled-run-sweep job must have scanned this row').not.toBeNull()
      expect(row.state).toBe('running')
    }, 30000)
  })

  // ===============================================================================================
  // Leg 3 — abandon HTTP route: auth/org/host chain.
  // ===============================================================================================
  describe('leg 3 — abandon HTTP route auth/org/host chain', () => {
    it('a genuine attendance:admin holder abandons their own org\'s run: 200, state flips, reason recorded', async () => {
      const orgId = randomUUID()
      await seedRolloutOrg(orgId)
      const stuck = await createStuckRun(orgId, '2026-04-04')
      const admin = await seedUser({ permissionCode: 'attendance:admin' })

      const response = await withAllowlist([orgId], () =>
        requestJson(`${baseUrl}/api/attendance/auto-absence/scheduled-runs/${stuck.runId}/abandon`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${admin.token}` },
          body: { orgId, reasonCode: 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED' },
        }),
      )
      expect(response.status, response.raw).toBe(200)
      expect(response.body?.data?.kind).toBe('abandoned')
      const row = await runRow(stuck.runId)
      expect(row.state).toBe('abandoned')
      expect(row.abandon_reason_code).toBe('ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED')
    })

    it('no token: 401, zero DML', async () => {
      const orgId = randomUUID()
      await seedRolloutOrg(orgId)
      const stuck = await createStuckRun(orgId, '2026-04-05')

      const response = await withAllowlist([orgId], () =>
        requestJson(`${baseUrl}/api/attendance/auto-absence/scheduled-runs/${stuck.runId}/abandon`, {
          method: 'POST',
          body: { orgId, reasonCode: 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED' },
        }),
      )
      expect(response.status).toBe(401)
      const row = await runRow(stuck.runId)
      expect(row.state).toBe('running')
      expect(row.abandon_reason_code).toBeNull()
    })

    it('authenticated but lacking attendance:admin: 403 FORBIDDEN, zero DML — genuine RBAC, not a bypass', async () => {
      const orgId = randomUUID()
      await seedRolloutOrg(orgId)
      const stuck = await createStuckRun(orgId, '2026-04-06')
      const nonAdmin = await seedUser({})

      const response = await withAllowlist([orgId], () =>
        requestJson(`${baseUrl}/api/attendance/auto-absence/scheduled-runs/${stuck.runId}/abandon`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${nonAdmin.token}` },
          body: { orgId, reasonCode: 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED' },
        }),
      )
      expect(response.status, response.raw).toBe(403)
      expect(response.body?.error?.code).toBe('FORBIDDEN')
      const row = await runRow(stuck.runId)
      expect(row.state).toBe('running')
      expect(row.abandon_reason_code).toBeNull()
    })

    it('a real admin, wrong org + a DIFFERENT org\'s run id: 404 ATTENDANCE_SCHEDULED_RUN_NOT_FOUND, zero DML on the real row', async () => {
      const victimOrgId = randomUUID()
      const callerOrgId = randomUUID()
      await seedRolloutOrg(victimOrgId)
      await seedRolloutOrg(callerOrgId)
      const victimRun = await createStuckRun(victimOrgId, '2026-04-07')
      const admin = await seedUser({ permissionCode: 'attendance:admin' })

      // The route accepts `orgId` in the body; the caller claims `callerOrgId` (NOT the run's
      // real org) while pointing at the victim org's run id. The org-scoped SQL lookup
      // (`WHERE org_id = $1 AND run_id = $2`) finds zero rows under `callerOrgId` — the SAME
      // not-found shape as a nonexistent run — never touching the victim row.
      const response = await withAllowlist([victimOrgId, callerOrgId], () =>
        requestJson(`${baseUrl}/api/attendance/auto-absence/scheduled-runs/${victimRun.runId}/abandon`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${admin.token}` },
          body: { orgId: callerOrgId, reasonCode: 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED' },
        }),
      )
      expect(response.status, response.raw).toBe(404)
      expect(response.body?.error?.code).toBe('ATTENDANCE_SCHEDULED_RUN_NOT_FOUND')
      const row = await runRow(victimRun.runId)
      expect(row.state).toBe('running')
      expect(row.abandon_reason_code).toBeNull()
    })
  })

  // ===============================================================================================
  // Leg 4 — production tick-observability wiring (#4774 P2-1 closure).
  // ===============================================================================================
  describe('leg 4 — production Logger call-through (#4774 P2-1)', () => {
    it('port.sweepScheduledRuns emits the tick-summary line through the SAME production Logger instance index.ts wires in (`logger: this.logger`)', async () => {
      expect(hostPort).not.toBeNull()
      const orgId = randomUUID()
      await seedRolloutOrg(orgId)
      await createStuckRun(orgId, '2026-04-08')

      // Door 4: the REAL `MetaSheetServer` instance's own `Logger` (`private logger: Logger`,
      // constructed once at server boot as `new Logger('MetaSheetServer')`) — never a
      // test-supplied stand-in. `index.ts`'s port object passes THIS SAME reference through as
      // `logger: this.logger`; spying on it (rather than substituting a fake) is what makes this
      // leg discriminate on the wiring LINE itself, not on the sweep's own logger-shaped
      // contract (already covered by the fairness file's gate-3 tests).
      const productionLogger = (
        server as unknown as {
          logger: { info: (event: string, meta?: Record<string, unknown>) => void }
        }
      ).logger
      const infoCalls: Array<{ event: string; meta: Record<string, unknown> | undefined }> = []
      const infoSpy = vi
        .spyOn(productionLogger, 'info')
        .mockImplementation((event: string, meta?: Record<string, unknown>) => {
          infoCalls.push({ event, meta })
        })
      try {
        const result = await withAllowlist([orgId], () =>
          hostPort!.sweepScheduledRuns({ limit: 25, async recoverCandidate() {} }),
        )
        expect(result.scanned).toBeGreaterThanOrEqual(1)

        const tickCall = infoCalls.find((c) => c.event === 'attendance.w4_scheduled_run_sweep.tick')
        expect(
          tickCall,
          'the production Logger must have received the tick-summary line — proves index.ts:2249 `logger: this.logger` is actually wired into the booted server, not just declared in source',
        ).toBeDefined()
        expect(Object.keys(tickCall!.meta ?? {}).sort()).toEqual(
          [
            'backlogRemaining',
            'errored',
            'finalized',
            'neverAttemptedRunning',
            'notReady',
            'oldestRunningAttemptAgeSeconds',
            'scanned',
            'skipped',
          ].sort(),
        )
        for (const value of Object.values(tickCall!.meta ?? {})) {
          expect(typeof value, 'production-emitted meta must stay values-free: numbers only').toBe('number')
        }
      } finally {
        infoSpy.mockRestore()
      }
    })
  })
})
