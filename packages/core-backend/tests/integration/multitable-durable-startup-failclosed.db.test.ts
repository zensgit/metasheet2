/**
 * Owner REQUEST-CHANGES (heads 5afe30f26 → 1d3854c7a) — REAL startup-level fail-closed regression (not just
 * the pure disposition/assert helpers): drives the actual `MetaSheetServer.start()` lifecycle against
 * Postgres.
 *
 * Round 1 (head 5afe30f26) P1s: with AUTOMATION_DURABLE_DELIVERY_ENABLED=true, the wired producer families
 * SUPPRESS their legacy post-commit emits, so a process that starts without the full durable chain does not
 * "degrade" — it silently strands work (no dispatcher / no webhook crash recovery).
 *
 * Round 2 (head 1d3854c7a) findings, both covered here:
 *   - P1: `this.automationService` used to be assigned right after construction and never cleared, so a REAL
 *     `init()` or `loadAndRegisterAllScheduled()` failure (object exists!) slipped past
 *     `Boolean(this.automationService)` and the server kept listening. Fixed by publish-last + an explicit
 *     `automationServiceReady` bit; regressed by S2-init / S2-load below (injected into the REAL init path).
 *   - P2: the boot used to START the dispatch loop before validating the retry scheduler, so the S1
 *     rejection left a LIVE loop handle whose next tick hit "Cannot use a pool after calling end on the
 *     pool" (visible in a green Node20 CI log). Fixed by reordering activation (validate every dependency,
 *     start the loop LAST) + a stop-and-null rollback in the catch. Regressed below by asserting, after a
 *     rejected start(): loop handle is null, the shared retry scheduler is torn down, and ZERO dispatcher DB
 *     calls occur while waiting longer than one loop interval (the probe wraps the REAL dispatcher functions
 *     pass-through; S5 is the positive control proving the probe observes real ticks).
 *
 * Matrix (each case = a REAL server lifecycle):
 *   S1      flag ON + retry scheduler disabled     → start() REJECTS naming the scheduler; loop handle null;
 *           zero dispatcher DB calls past one interval; no shared scheduler
 *   S2      flag ON + AutomationService CONSTRUCTOR throws → start() REJECTS naming AutomationService
 *   S2-init flag ON + AutomationService init() throws (object constructed) → start() REJECTS; nothing published
 *   S2-load flag ON + loadAndRegisterAllScheduled() rejects (constructor + init() succeeded) → start()
 *           REJECTS; loop handle null; zero dispatcher DB calls past one interval; nothing published
 *   S3      flag OFF + retry scheduler disabled    → starts (legacy degrade preserved)
 *   S4      flag OFF + constructor throws          → starts (legacy degrade preserved)
 *   S4-load flag OFF + load failure                → starts (publish-last never over-fires flag-OFF;
 *           automationServiceReady stays false)
 *   S5      flag ON + healthy                      → starts; loop handle live; dispatcher DB calls observed
 *           (positive control for the zero-tick assertions)
 *
 * Failure cases run FIRST (they abort mid-boot, pre-listen, and are never stopped); success lifecycles are
 * stopped together in afterAll — see the HARNESS CONSTRAINT note below for why (one shared pool per
 * process). DATABASE_URL-gated; two-point wired (vitest.config exclude + plugin-tests.yml run-list).
 */
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

// Injected fault switches — hoisted so the module-mock factory (which vitest hoists above imports) can see
// them. ctor / init / load cover the three rungs of the REAL init chain: the round-2 P1 was precisely that
// only the ctor rung was regressed while init()/load failures (object already exists) bypassed fail-closed.
const fault = vi.hoisted(() => ({
  automationCtorThrows: false,
  automationInitThrows: false,
  automationLoadThrows: false,
}))

// Behavioral DB-tick probe — pass-through wrappers around the REAL dispatcher functions the loop calls on
// every tick (findUnknownConsumerKeys + claimDueConsumers). Any durable loop tick MUST increment this
// counter before touching the DB, so "counter unchanged across > one interval" is a real zero-DB-tick
// assertion (and S5 proves the counter moves when a loop IS live — the positive control).
const dispatcherProbe = vi.hoisted(() => ({ dbCalls: 0 }))

// Mock ONLY the AutomationService class inside the otherwise-real module: the subclass throws at the
// requested rung when its switch is on, else behaves byte-identically (calls through to the real
// implementation). This injects the failure into the REAL server boot, which is otherwise untouched.
vi.mock('../../src/multitable/automation-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/automation-service')>()
  class FaultInjectedAutomationService extends actual.AutomationService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      if (fault.automationCtorThrows) {
        throw new Error('injected automation-service constructor failure (startup fail-closed regression)')
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      super(...(args as [any, any, any, any, any, any, any]))
    }

    init(): void {
      if (fault.automationInitThrows) {
        throw new Error('injected automation-service init() failure (startup fail-closed regression)')
      }
      super.init()
    }

    async loadAndRegisterAllScheduled(): Promise<void> {
      if (fault.automationLoadThrows) {
        throw new Error('injected automation-service loadAndRegisterAllScheduled failure (startup fail-closed regression)')
      }
      return super.loadAndRegisterAllScheduled()
    }
  }
  return { ...actual, AutomationService: FaultInjectedAutomationService }
})

vi.mock('../../src/multitable/automation-durable-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/automation-durable-dispatcher')>()
  return {
    ...actual,
    findUnknownConsumerKeys: (...args: Parameters<typeof actual.findUnknownConsumerKeys>) => {
      dispatcherProbe.dbCalls += 1
      return actual.findUnknownConsumerKeys(...args)
    },
    claimDueConsumers: (...args: Parameters<typeof actual.claimDueConsumers>) => {
      dispatcherProbe.dbCalls += 1
      return actual.claimDueConsumers(...args)
    },
  }
})

import { MetaSheetServer } from '../../src/index'
import { getAutomationServiceInstance } from '../../src/multitable/automation-service'
import { getSharedWebhookRetryScheduler } from '../../src/services/WebhookRetryScheduler'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const DURABLE_FLAG = 'AUTOMATION_DURABLE_DELIVERY_ENABLED'
const SCHED_DISABLE = 'WEBHOOK_RETRY_SCHEDULER_DISABLED'

// The boot site does not override intervalMs → the loop's default (1_000ms). The zero-tick windows below
// wait LONGER than two intervals, so a live (leaked) loop could not hide between polls.
const LOOP_INTERVAL_MS = 1_000
const PAST_ONE_INTERVAL_MS = 2_200

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Peek the server's private durable loop handle — the round-2 P2 asserts it is NULL after a rejection. */
function durableLoopHandle(server: MetaSheetServer): unknown {
  return (server as unknown as { durableDeliveryLoop: unknown }).durableDeliveryLoop
}

function automationReadyBit(server: MetaSheetServer): boolean {
  return (server as unknown as { automationServiceReady: boolean }).automationServiceReady
}

async function startServer(): Promise<{ server: MetaSheetServer; error: unknown }> {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
  try {
    await server.start()
    return { server, error: null }
  } catch (e) {
    return { server, error: e }
  }
}

/**
 * HARNESS CONSTRAINT — one shared global pool per process: `server.stop()` is a FULL graceful shutdown that
 * ENDS the shared poolManager pool, so any lifecycle started after a stop() sees "Cannot use a pool after
 * calling end on the pool" everywhere. Therefore:
 *   - FAILURE lifecycles (start() rejects) are NEVER stopped: the fail-closed throw fires in the boot blocks,
 *     which all run BEFORE `httpServer.listen`, so no socket exists. The activation rollback is what
 *     guarantees no durable loop/scheduler timer survives the rejection — and the failure tests ASSERT that
 *     (handle null + zero dispatcher DB calls past an interval), instead of relying on fork-exit reaping.
 *   - SUCCESS lifecycles are collected and stopped ONLY in afterAll, in reverse order, catch-wrapped: the
 *     first stop() ends the pool; later stops' pool-dependent cleanup errors are swallowed (their listeners
 *     still close; the fork exits right after).
 */
const startedServers: MetaSheetServer[] = []

async function stopQuietly(server: MetaSheetServer): Promise<void> {
  try {
    await (server as unknown as { stop: () => Promise<void> }).stop()
  } catch {
    // pool already ended by an earlier stop — remaining cleanup is reaped at fork exit
  }
}

describeIfDatabase('durable-delivery startup fail-closed (REAL MetaSheetServer.start lifecycle)', () => {
  afterEach(() => {
    delete process.env[DURABLE_FLAG]
    delete process.env[SCHED_DISABLE]
    fault.automationCtorThrows = false
    fault.automationInitThrows = false
    fault.automationLoadThrows = false
  })

  afterAll(async () => {
    for (const server of startedServers.reverse()) {
      await stopQuietly(server)
    }
  })

  test('S1 flag ON + retry scheduler disabled → REJECTS naming the scheduler; loop handle null; zero DB ticks past one interval', async () => {
    process.env[DURABLE_FLAG] = 'true'
    process.env[SCHED_DISABLE] = '1'
    const { server, error } = await startServer()
    // start() rejected in the pre-listen boot blocks — nothing to stop (see harness constraint above).
    expect(error).toBeTruthy()
    expect(String(error)).toMatch(/fail-closed.*webhook retry scheduler/)
    // Round-2 P2: the rejection must leave NO live durable machinery — a null handle AND behavioral silence.
    expect(durableLoopHandle(server)).toBeNull()
    expect(getSharedWebhookRetryScheduler()).toBeNull()
    const before = dispatcherProbe.dbCalls
    await sleep(PAST_ONE_INTERVAL_MS)
    expect(PAST_ONE_INTERVAL_MS).toBeGreaterThan(LOOP_INTERVAL_MS)
    expect(dispatcherProbe.dbCalls).toBe(before)
  })

  test('S2 flag ON + AutomationService constructor throws → REJECTS naming AutomationService (fail-closed)', async () => {
    process.env[DURABLE_FLAG] = 'true'
    fault.automationCtorThrows = true
    const { server, error } = await startServer()
    expect(error).toBeTruthy()
    expect(String(error)).toMatch(/fail-closed.*AutomationService/)
    expect(durableLoopHandle(server)).toBeNull()
    // The retry scheduler had already started (it boots before the durable block) — the fail-closed
    // rollback must tear it down so the aborted process leaves no ticking DB timer.
    expect(getSharedWebhookRetryScheduler()).toBeNull()
  })

  test('S2-init flag ON + AutomationService init() throws (object constructed) → REJECTS (publish-last, fail-closed)', async () => {
    process.env[DURABLE_FLAG] = 'true'
    fault.automationInitThrows = true
    // NOTE: an EARLIER failing lifecycle (S1) legitimately published its fully-inited service before its
    // scheduler assert aborted, and failure lifecycles never run stop() — so the singleton observable is
    // "THIS lifecycle published nothing NEW", not "the singleton is null".
    const publishedBefore = getAutomationServiceInstance()
    const { server, error } = await startServer()
    // Round-2 P1: the object EXISTS (constructor succeeded) — readiness, not existence, must gate the boot.
    expect(error).toBeTruthy()
    expect(String(error)).toMatch(/fail-closed.*AutomationService/)
    expect(automationReadyBit(server)).toBe(false)
    expect(getAutomationServiceInstance()).toBe(publishedBefore)
    expect(durableLoopHandle(server)).toBeNull()
    expect(getSharedWebhookRetryScheduler()).toBeNull()
  })

  test('S2-load flag ON + loadAndRegisterAllScheduled rejects (ctor+init succeeded) → REJECTS; loop null; zero DB ticks past one interval', async () => {
    process.env[DURABLE_FLAG] = 'true'
    fault.automationLoadThrows = true
    const publishedBefore = getAutomationServiceInstance()
    const { server, error } = await startServer()
    expect(error).toBeTruthy()
    expect(String(error)).toMatch(/fail-closed.*AutomationService/)
    expect(automationReadyBit(server)).toBe(false)
    expect(getAutomationServiceInstance()).toBe(publishedBefore)
    expect(durableLoopHandle(server)).toBeNull()
    expect(getSharedWebhookRetryScheduler()).toBeNull()
    const before = dispatcherProbe.dbCalls
    await sleep(PAST_ONE_INTERVAL_MS)
    expect(dispatcherProbe.dbCalls).toBe(before)
  })

  test('S3 flag OFF + retry scheduler disabled → starts (legacy degrade-and-continue preserved)', async () => {
    process.env[SCHED_DISABLE] = '1'
    const { server, error } = await startServer()
    startedServers.push(server)
    expect(error).toBeNull()
    expect((server.getAddress() as { port?: number } | null)?.port).toBeTruthy()
  })

  test('S4 flag OFF + AutomationService constructor throws → starts (legacy degrade-and-continue preserved)', async () => {
    fault.automationCtorThrows = true
    const { server, error } = await startServer()
    startedServers.push(server)
    expect(error).toBeNull()
    expect((server.getAddress() as { port?: number } | null)?.port).toBeTruthy()
  })

  test('S4-load flag OFF + load failure → starts degraded (publish-last never over-fires; readiness stays false)', async () => {
    fault.automationLoadThrows = true
    const { server, error } = await startServer()
    startedServers.push(server)
    expect(error).toBeNull()
    expect((server.getAddress() as { port?: number } | null)?.port).toBeTruthy()
    expect(automationReadyBit(server)).toBe(false)
    expect(durableLoopHandle(server)).toBeNull()
  })

  test('S5 flag ON + healthy chain → starts; loop handle live; dispatcher DB calls observed (positive control)', async () => {
    process.env[DURABLE_FLAG] = 'true'
    const { server, error } = await startServer()
    startedServers.push(server)
    expect(error).toBeNull()
    expect((server.getAddress() as { port?: number } | null)?.port).toBeTruthy()
    expect(automationReadyBit(server)).toBe(true)
    expect(durableLoopHandle(server)).not.toBeNull()
    // Positive control for the S1/S2-load zero-tick assertions: with a REAL loop running, the probe MUST
    // move within a few intervals — proving the counter actually observes dispatcher DB activity.
    const before = dispatcherProbe.dbCalls
    const deadline = Date.now() + 10_000
    while (dispatcherProbe.dbCalls === before && Date.now() < deadline) {
      await sleep(200)
    }
    expect(dispatcherProbe.dbCalls).toBeGreaterThan(before)
  })
})
