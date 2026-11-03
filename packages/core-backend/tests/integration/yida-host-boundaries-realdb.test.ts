// #6315 host boundaries through the ACTUAL MetaSheetServer, not a hand-built runtime:
//   T1 createPluginContext hands the YiDa owner/initialization capabilities to plugin-integration-core only;
//   T2 the host readEnablement wiring opens the owner runtime for INTEGRATION_YIDA_OWNER_SEND_ENABLED === 'true' only;
//   T3 stopOnce keeps the main pool open until an in-flight owner run has drained (initialization runtime:
//      yida-host-initialization-barrier-realdb.test.ts, a second boot because stop() ends the module pool).
// Real JWT login, real plugin activation, fully migrated PostgreSQL. The host's YiDa egress (the fetch
// bound at construction, src/index.ts ~:645) refuses and is counted; no other egress is configured in this step.
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootYidaHostBoundaryServer, CORE_PLUGIN, FIXTURE_PLUGIN, proveShutdownBarrier,
  type HttpResult, type YidaHostBoundaryHarness,
} from '../utils/yida-host-boundary-server'

it('sentinel: YiDa host boundary proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('YiDa host boundaries — actual MetaSheetServer, owner runtime', () => {
  let h: YidaHostBoundaryHarness
  // Passes the router's exact-key body check and the runtime's input parse, so the first
  // refusal any request below can meet is the runtime's active/enablement admission.
  const draftBody = () => ({ config: {}, rowsText: '[]', allocation: { mode: 'original' } })
  const draft = (token: string) => h.http('POST', '/api/integration/yida-owner-send/drafts', token, draftBody())
  const refusal = (result: HttpResult, status: number, code: string) => {
    expect(result.status).toBe(status)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.body).toEqual({ ok: false, error: { code } })
  }

  beforeAll(async () => { h = await bootYidaHostBoundaryServer() }, 120000)
  afterAll(async () => { await h?.cleanup() }, 60000)

  it('T1 injection: the near-miss fixture plugin receives neither YiDa capability; both plugins are active', () => {
    // Activation failures are swallowed into pluginStatus; without these a dead fixture would pass.
    expect(h.host.pluginStatus.get(CORE_PLUGIN)?.status).toBe('active')
    expect(h.host.pluginStatus.get(FIXTURE_PLUGIN)?.status).toBe('active')
    const observed = h.fixtureObservation()
    expect(observed).toBeDefined()
    expect(observed?.called).toBe(true)
    expect(observed?.securityType).toBe('object')
    expect(observed?.owner).toBeUndefined()
    expect(observed?.init).toBeUndefined()
  })

  it('T2 enablement: only the exact string true opens the owner runtime, over real JWT HTTP', async () => {
    const before = await h.yidaTableCounts()
    expect(Object.keys(before)).toEqual(expect.arrayContaining([
      'integration_yida_approved_target', 'integration_yida_draft_operations', 'integration_yida_send_approvals']))
    try {
      // Admin passes JWT and every later ACL; 403 DISABLED (not 503 INACTIVE) also proves the
      // core plugin's injected capability is active, because the runtime checks active first.
      for (const value of [undefined, 'false', 'TRUE', '1', ' true', 'true ']) {
        if (value === undefined) delete process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED
        else process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED = value
        refusal(await draft(h.admin.token), 403, 'YIDA_OWNER_RUNTIME_DISABLED')
      }
      // Positive control on the switch itself: with exactly 'true' the same request is admitted past
      // enablement and refused later (503 UNAVAILABLE).
      // Never the admin here: a shared CI database must not receive owner draft rows.
      process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED = 'true'
      const admitted = await draft(h.reader.token)
      expect((admitted.body.error as { code?: unknown } | undefined)?.code).not.toBe('YIDA_OWNER_RUNTIME_DISABLED')
      expect((admitted.body.error as { code?: unknown } | undefined)?.code).not.toBe('YIDA_OWNER_RUNTIME_INACTIVE')
      refusal(admitted, 503, 'YIDA_SEND_APPROVAL_UNAVAILABLE')
    } finally {
      delete process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED
    }
    expect(await h.yidaTableCounts()).toEqual(before)
    expect(h.fetchCalls()).toBe(0)
  })

  it('T3 shutdown barrier: the main pool stays open while an owner run is held, and ends once after it drains', async () => {
    const { yidaOwnerRuntimeErrorCode } = await import('../../src/integration/yida-owner-runtime')
    // The object stopOnce ends (src/db/pg.ts) is the same pool the spy below watches.
    expect(h.exportedPool).toBe(h.internalPool)
    expect(h.mainPool()).toBe(h.internalPool)
    let holder: PoolClient | undefined
    let holderPid = 0
    const observation = await proveShutdownBarrier(h, {
      async hold() {
        holder = await h.pool.connect()
        holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        await holder.query('BEGIN')
        // EXCLUSIVE conflicts with the ROW SHARE lock of the runtime's
        // `... FROM integration_yida_approved_target WHERE slot = 1 FOR UPDATE`, and with nothing
        // the live actor check reads first, so the run blocks inside its authority transaction.
        await holder.query('LOCK TABLE integration_yida_approved_target IN EXCLUSIVE MODE')
      },
      // Direct private call: an open HTTP request would itself hold stopOnce at the earlier
      // HTTP-close barrier and hide whether the YiDa barrier exists.
      start: () => h.host.yidaOwnerRuntime.observe(h.adminActor, { grantId: randomUUID() }),
      async waiting() {
        const result = await h.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_locks
          WHERE locktype = 'relation' AND relation = 'integration_yida_approved_target'::regclass
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND NOT granted AND pid <> $1`, [holderPid])
        return result.rows[0].count > 0
      },
      async release() {
        const client = holder
        holder = undefined
        if (!client) return
        try { await client.query('ROLLBACK') } finally { client.release() }
      },
    })
    console.info('[yida-host-boundaries] timings', JSON.stringify({ importMs: Math.round(h.importMs), bootMs: Math.round(h.bootMs),
      ...Object.fromEntries(Object.entries(observation.timings).map(([key, value]) => [key, Math.round(value)])),
      windowMs: Math.round(observation.window.ms), samples: observation.window.samples }))

    expect(observation.waiterSeen).toBe(true)
    expect(observation.pluginsBeforeStop).toBe(2)
    expect(observation.sameStopPromise).toBe(true)
    // stopOnce latches BOTH runtimes synchronously, inside the stop() call itself.
    expect(observation.latchAtStop).toEqual({ owner: 'YIDA_OWNER_RUNTIME_INACTIVE', init: 'YIDA_INITIALIZATION_INACTIVE' })
    expect(observation.stageReached).toBe(true)
    // While the run is held and stopOnce is already at shutdownTasks:
    expect(observation.window.ms).toBeGreaterThanOrEqual(1900)
    expect(observation.window.endCalls).toBe(0)
    expect(observation.window.ending).toBe(false)
    expect(observation.window.waiterAlways).toBe(true)
    expect(observation.window.runSettled).toBe(false)
    expect(observation.window.stopSettled).toBe(false)
    // After release: the run is cancelled by stop, then (and only then) the pool ends, once.
    expect(observation.runFulfilled).toBe(false)
    expect(yidaOwnerRuntimeErrorCode(observation.runRejection)).toBe('YIDA_OWNER_RUNTIME_CANCELLED')
    expect(observation.stopSettled).toBe(true)
    expect(observation.stopError).toBeUndefined()
    expect(observation.endCalls).toBe(1)
    expect(observation.ending).toBe(true)
    expect(observation.events.indexOf('run-settled')).toBeGreaterThanOrEqual(0)
    expect(observation.events.indexOf('run-settled')).toBeLessThan(observation.events.indexOf('pool-end'))
    // stopOnce latched the host runtime itself, not only the plugin registration.
    let terminal: unknown
    try { h.host.yidaOwnerRuntime.createPluginCapability() } catch (error) { terminal = error }
    expect(yidaOwnerRuntimeErrorCode(terminal)).toBe('YIDA_OWNER_RUNTIME_INACTIVE')
    expect(h.fetchCalls()).toBe(0)
    // The helper's worst-case poll budget is about 61 s; 90 s lets a deep failure surface as its own
    // assertion rather than a generic vitest timeout.
  }, 90000)
})
