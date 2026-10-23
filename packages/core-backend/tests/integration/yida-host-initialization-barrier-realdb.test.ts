// #6315 host shutdown barrier for the YiDa INITIALIZATION runtime through the ACTUAL MetaSheetServer.
// A second boot of its own: stop() ends the module-wide main pool, so one stop per process
// (the owner runtime barrier is in yida-host-boundaries-realdb.test.ts). The run is held on the
// runtime's own slot key, pg_advisory_xact_lock(0x59494441, 1), by a session lock this test owns.
// Real JWT login, real plugin activation, fully migrated PostgreSQL. The host's YiDa egress (the fetch
// bound at construction, src/index.ts ~:645) refuses and is counted; no other egress is configured in this step.
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootYidaHostBoundaryServer, CORE_PLUGIN, FIXTURE_PLUGIN, proveShutdownBarrier, type YidaHostBoundaryHarness,
} from '../utils/yida-host-boundary-server'

// lockYidaInitializationSlot: ASCII 'YIDA' as the first int4 key, permanent slot 1 as the second.
const SLOT_KEY = [0x59494441, 1] as const

it('sentinel: YiDa host initialization barrier proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('YiDa host boundaries — actual MetaSheetServer, initialization runtime', () => {
  let h: YidaHostBoundaryHarness

  beforeAll(async () => { h = await bootYidaHostBoundaryServer() }, 120000)
  afterAll(async () => { await h?.cleanup() }, 60000)

  it('injection in this boot: the near-miss fixture plugin receives neither YiDa capability; both plugins are active', () => {
    expect(h.host.pluginStatus.get(CORE_PLUGIN)?.status).toBe('active')
    expect(h.host.pluginStatus.get(FIXTURE_PLUGIN)?.status).toBe('active')
    const observed = h.fixtureObservation()
    expect(observed).toBeDefined()
    expect(observed?.called).toBe(true)
    expect(observed?.securityType).toBe('object')
    expect(observed?.init).toBeUndefined()
    expect(observed?.owner).toBeUndefined()
  })

  it('shutdown barrier: the main pool stays open while an initialization run is held, and ends once after it drains', async () => {
    const { yidaInitializationErrorCode } = await import('../../src/integration/yida-initialization-runtime')
    expect(h.exportedPool).toBe(h.internalPool)
    expect(h.mainPool()).toBe(h.internalPool)
    let holder: PoolClient | undefined
    let holderPid = 0
    const observation = await proveShutdownBarrier(h, {
      async hold() {
        holder = await h.pool.connect()
        holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        // Session-level, so it outlives any statement; the runtime reaches the key only after
        // its live actor check, inside its own RC transaction.
        await holder.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [...SLOT_KEY])
      },
      // status() takes the slot lock before it reads the anchor, so no anchor row is needed.
      // Direct private call, never HTTP: see the owner barrier test for why.
      start: () => h.host.yidaInitializationRuntime.status(h.adminActor),
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
          const unlocked = await client.query<{ unlocked: boolean }>(
            'SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked', [...SLOT_KEY])
          if (unlocked.rows[0]?.unlocked !== true) throw new Error('YIDA_HOST_BOUNDARY_UNLOCK_FAILED')
          client.release()
        } catch (error) {
          // Destroying the session drops its advisory lock as well.
          client.release(true)
          throw error
        }
      },
    })
    console.info('[yida-host-initialization-barrier] timings', JSON.stringify({ importMs: Math.round(h.importMs), bootMs: Math.round(h.bootMs),
      ...Object.fromEntries(Object.entries(observation.timings).map(([key, value]) => [key, Math.round(value)])),
      windowMs: Math.round(observation.window.ms), samples: observation.window.samples }))

    expect(observation.waiterSeen).toBe(true)
    expect(observation.pluginsBeforeStop).toBe(2)
    expect(observation.sameStopPromise).toBe(true)
    // stopOnce latches BOTH runtimes synchronously, inside the stop() call itself.
    expect(observation.latchAtStop).toEqual({ owner: 'YIDA_OWNER_RUNTIME_INACTIVE', init: 'YIDA_INITIALIZATION_INACTIVE' })
    expect(observation.stageReached).toBe(true)
    expect(observation.window.ms).toBeGreaterThanOrEqual(1900)
    expect(observation.window.endCalls).toBe(0)
    expect(observation.window.ending).toBe(false)
    expect(observation.window.waiterAlways).toBe(true)
    expect(observation.window.runSettled).toBe(false)
    expect(observation.window.stopSettled).toBe(false)
    expect(observation.runFulfilled).toBe(false)
    expect(yidaInitializationErrorCode(observation.runRejection)).toBe('YIDA_INITIALIZATION_CANCELLED')
    expect(observation.stopSettled).toBe(true)
    expect(observation.stopError).toBeUndefined()
    expect(observation.endCalls).toBe(1)
    expect(observation.ending).toBe(true)
    expect(observation.events.indexOf('run-settled')).toBeGreaterThanOrEqual(0)
    expect(observation.events.indexOf('run-settled')).toBeLessThan(observation.events.indexOf('pool-end'))
    let terminal: unknown
    try { h.host.yidaInitializationRuntime.createPluginCapability() } catch (error) { terminal = error }
    expect(yidaInitializationErrorCode(terminal)).toBe('YIDA_INITIALIZATION_INACTIVE')
    expect(h.fetchCalls()).toBe(0)
    // Worst-case poll budget about 61 s; see the owner barrier test.
  }, 90000)
})
