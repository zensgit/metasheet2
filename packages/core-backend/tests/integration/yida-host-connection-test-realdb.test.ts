// Owner-run YiDa 测试连接 (ADR adr-yida-connection-test-20261028) through the ACTUAL MetaSheetServer:
//   C1 createPluginContext hands the connection-test capability to plugin-integration-core only, and the
//      real plugin activates it (403 DISABLED, not 503 INACTIVE, while the switch is off);
//   C2 the host readEnablement wiring opens it for INTEGRATION_YIDA_CONNECTION_TEST_ENABLED === 'true' only, and
//      the send switch does not; a live non-admin is DENIED; no anchor in this database is UNAVAILABLE;
//   C3 stopOnce keeps the main pool open until an in-flight connection-test run has drained.
// Real JWT login, real plugin activation, fully migrated PostgreSQL (no anchor is ever written here: the
// anchor is immutable and this database is shared). The host fetch refuses and is counted: every path
// below is a refusal before any exchange, so it must stay at zero. The positive one-exchange path is
// tests/integration/yida-connection-test-http-realdb.test.ts (own schema, anchor, synthetic token sink).
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootYidaHostBoundaryServer, CORE_PLUGIN, FIXTURE_PLUGIN, proveShutdownBarrier,
  type HttpResult, type YidaHostBoundaryHarness,
} from '../utils/yida-host-boundary-server'

const SLOT_KEY = [0x59494441, 1] as const
const path = '/api/integration/yida-owner-send/initialization/connection-test'
const body = () => ({ commandId: randomUUID(), mode: 'candidate',
  material: { appKey: ' synthetic-host-probe-key ', appSecret: ' synthetic-host-probe-secret ' } })

it('sentinel: YiDa host connection-test proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('YiDa host boundaries — actual MetaSheetServer, connection-test runtime', () => {
  let h: YidaHostBoundaryHarness
  const refusal = (result: HttpResult, status: number, code: string) => {
    expect(result.status).toBe(status)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.body).toEqual({ ok: false, error: { code } })
  }
  beforeAll(async () => { h = await bootYidaHostBoundaryServer() }, 120000)
  afterAll(async () => { await h?.cleanup() }, 60000)

  it('C1 injection: the near-miss fixture plugin receives no connection-test capability; both plugins are active', () => {
    expect(h.host.pluginStatus.get(CORE_PLUGIN)?.status).toBe('active')
    expect(h.host.pluginStatus.get(FIXTURE_PLUGIN)?.status).toBe('active')
    const observed = h.fixtureObservation()
    expect(observed?.called).toBe(true)
    expect(observed?.securityType).toBe('object')
    expect(observed?.probe).toBeUndefined()
    expect(observed?.owner).toBeUndefined()
    expect(observed?.init).toBeUndefined()
  })

  it('C2 enablement: only its own exact string true opens it; refusals never reach an exchange or a write', async () => {
    const before = await h.yidaTableCounts()
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['integration_yida_initialization_anchor', 'integration_yida_initializations']))
    try {
      // The send switch ON does not open the connection test.
      process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED = 'true'
      for (const value of [undefined, 'false', 'TRUE', '1', ' true', 'true ']) {
        if (value === undefined) delete process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED
        else process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED = value
        // DISABLED (not INACTIVE) also proves the real plugin activated the injected capability.
        refusal(await h.http('POST', path, h.admin.token, body()), 403, 'YIDA_CONNECTION_TEST_DISABLED')
      }
      delete process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED
      process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED = 'true'
      // A JWT user who fails the live integration ACL.
      refusal(await h.http('POST', path, h.reader.token, body()), 403, 'YIDA_CONNECTION_TEST_DENIED')
      // A live admin, but this shared database has no server anchor: closed UNAVAILABLE, still no exchange.
      refusal(await h.http('POST', path, h.admin.token, body()), 503, 'YIDA_CONNECTION_TEST_UNAVAILABLE')
      // Closed body before the runtime.
      refusal(await h.http('POST', path, h.admin.token, { ...body(), mode: 'stored' }), 400, 'YIDA_OWNER_HTTP_INPUT')
    } finally {
      delete process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED
      delete process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED
    }
    expect(await h.yidaTableCounts()).toEqual(before)
    expect(h.fetchCalls()).toBe(0)
  })

  it('C3 shutdown barrier: the main pool stays open while a connection-test run is held, and ends once after it drains', async () => {
    const { yidaConnectionTestErrorCode } = await import('../../src/integration/yida-connection-test-runtime')
    expect(h.exportedPool).toBe(h.internalPool)
    let holder: PoolClient | undefined
    let holderPid = 0
    process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED = 'true'
    try {
      const observation = await proveShutdownBarrier(h, {
        async hold() {
          holder = await h.pool.connect()
          holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          // The runtime reaches the slot key after its live actor check, inside its own RC transaction.
          await holder.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [...SLOT_KEY])
        },
        // Direct private call, never HTTP (an open request would hold the earlier HTTP-close barrier).
        start: () => h.host.yidaConnectionTestRuntime.test(h.adminActor, body() as never),
        async waiting() {
          const result = await h.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_locks
            WHERE locktype = 'advisory' AND classid = $1::integer::oid AND objid = $2::integer::oid AND objsubid = 2
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND NOT granted AND pid <> $3`, [...SLOT_KEY, holderPid])
          return result.rows[0].count > 0
        },
        async release() {
          const client = holder
          holder = undefined
          if (!client) return
          try {
            const unlocked = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked', [...SLOT_KEY])
            if (unlocked.rows[0]?.unlocked !== true) throw new Error('YIDA_HOST_BOUNDARY_UNLOCK_FAILED')
            client.release()
          } catch (error) { client.release(true); throw error }
        },
      })
      console.info('[yida-host-connection-test] timings', JSON.stringify({ importMs: Math.round(h.importMs), bootMs: Math.round(h.bootMs),
        ...Object.fromEntries(Object.entries(observation.timings).map(([key, value]) => [key, Math.round(value)])),
        windowMs: Math.round(observation.window.ms), samples: observation.window.samples }))
      expect(observation.waiterSeen).toBe(true)
      expect(observation.sameStopPromise).toBe(true)
      expect(observation.stageReached).toBe(true)
      expect(observation.window.ms).toBeGreaterThanOrEqual(1900)
      expect(observation.window.endCalls).toBe(0)
      expect(observation.window.ending).toBe(false)
      expect(observation.window.waiterAlways).toBe(true)
      expect(observation.window.runSettled).toBe(false)
      expect(observation.window.stopSettled).toBe(false)
      expect(observation.runFulfilled).toBe(false)
      expect(yidaConnectionTestErrorCode(observation.runRejection)).toBe('YIDA_CONNECTION_TEST_CANCELLED')
      expect(observation.stopSettled).toBe(true)
      expect(observation.stopError).toBeUndefined()
      expect(observation.endCalls).toBe(1)
      expect(observation.events.indexOf('run-settled')).toBeGreaterThanOrEqual(0)
      expect(observation.events.indexOf('run-settled')).toBeLessThan(observation.events.indexOf('pool-end'))
      let terminal: unknown
      try { h.host.yidaConnectionTestRuntime.createPluginCapability() } catch (error) { terminal = error }
      expect(yidaConnectionTestErrorCode(terminal)).toBe('YIDA_CONNECTION_TEST_INACTIVE')
      expect(h.fetchCalls()).toBe(0)
    } finally { delete process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED }
  }, 90000)
})
