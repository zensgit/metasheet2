/**
 * Owner REQUEST-CHANGES (head 5afe30f26) — REAL startup-level fail-closed regression (not just the pure
 * disposition/assert helpers): drives the actual `MetaSheetServer.start()` lifecycle against Postgres.
 *
 * The two P1s: with AUTOMATION_DURABLE_DELIVERY_ENABLED=true, the wired producer families SUPPRESS their
 * legacy post-commit emits, so a process that starts without the full durable chain does not "degrade" — it
 * silently strands work:
 *   - AutomationService init failure was swallowed → `if (this.automationService)` SKIPPED durable boot →
 *     no dispatcher, every outbox row stranded, no exception anywhere.
 *   - the webhook retry scheduler could be disabled (WEBHOOK_RETRY_SCHEDULER_DISABLED=1) or fail init and
 *     startup continued — but the DURABLE webhook leg fire-and-forgets its send and relies on that
 *     scheduler (pending rows + first-attempt stray grace) for crash recovery.
 *
 * Matrix (each case = a REAL server lifecycle):
 *   S1 flag ON + retry scheduler disabled            → start() REJECTS (fail-closed names the scheduler)
 *   S2 flag ON + AutomationService init failure      → start() REJECTS (fail-closed names AutomationService;
 *      the failure is injected into the REAL init path via a module mock whose constructor throws on demand
 *      — everything else in the boot is real)
 *   S3 flag OFF + retry scheduler disabled           → starts (legacy degrade preserved)
 *   S4 flag OFF + AutomationService init failure     → starts (legacy degrade preserved)
 *   S5 flag ON + healthy                             → starts (fail-closed never over-fires; positive control)
 *
 * Failure cases run FIRST (they abort mid-boot, pre-listen, and are never stopped); success lifecycles are
 * stopped together in afterAll — see the HARNESS CONSTRAINT note below for why (one shared pool per
 * process). DATABASE_URL-gated; two-point wired (vitest.config exclude + plugin-tests.yml run-list).
 */
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

// Injected fault switch — hoisted so the module-mock factory (which vitest hoists above imports) can see it.
const fault = vi.hoisted(() => ({ automationCtorThrows: false }))

// Mock ONLY the AutomationService class inside the otherwise-real module: the subclass throws at construction
// when the switch is on, else behaves byte-identically (calls through to the real constructor). This injects
// the "AutomationService initialization failed" path into the REAL server boot, which is otherwise untouched.
vi.mock('../../src/multitable/automation-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/automation-service')>()
  class FaultInjectedAutomationService extends actual.AutomationService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      if (fault.automationCtorThrows) {
        throw new Error('injected automation-service init failure (startup fail-closed regression)')
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      super(...(args as [any, any, any, any, any, any, any]))
    }
  }
  return { ...actual, AutomationService: FaultInjectedAutomationService }
})

import { MetaSheetServer } from '../../src/index'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const DURABLE_FLAG = 'AUTOMATION_DURABLE_DELIVERY_ENABLED'
const SCHED_DISABLE = 'WEBHOOK_RETRY_SCHEDULER_DISABLED'

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
 *     which all run BEFORE `httpServer.listen` (index.ts ~2909), so no socket exists; leaked timers from the
 *     earlier init blocks are reaped when the vitest fork exits.
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
  })

  afterAll(async () => {
    for (const server of startedServers.reverse()) {
      await stopQuietly(server)
    }
  })

  test('S1 flag ON + retry scheduler disabled → startup REJECTS naming the scheduler (fail-closed)', async () => {
    process.env[DURABLE_FLAG] = 'true'
    process.env[SCHED_DISABLE] = '1'
    const { error } = await startServer()
    // start() rejected in the pre-listen boot blocks — nothing to stop (see harness constraint above).
    expect(error).toBeTruthy()
    expect(String(error)).toMatch(/fail-closed.*webhook retry scheduler/)
  })

  test('S2 flag ON + AutomationService init failure → startup REJECTS naming AutomationService (fail-closed)', async () => {
    process.env[DURABLE_FLAG] = 'true'
    fault.automationCtorThrows = true
    const { error } = await startServer()
    expect(error).toBeTruthy()
    expect(String(error)).toMatch(/fail-closed.*AutomationService/)
  })

  test('S3 flag OFF + retry scheduler disabled → starts (legacy degrade-and-continue preserved)', async () => {
    process.env[SCHED_DISABLE] = '1'
    const { server, error } = await startServer()
    startedServers.push(server)
    expect(error).toBeNull()
    expect((server.getAddress() as { port?: number } | null)?.port).toBeTruthy()
  })

  test('S4 flag OFF + AutomationService init failure → starts (legacy degrade-and-continue preserved)', async () => {
    fault.automationCtorThrows = true
    const { server, error } = await startServer()
    startedServers.push(server)
    expect(error).toBeNull()
    expect((server.getAddress() as { port?: number } | null)?.port).toBeTruthy()
  })

  test('S5 flag ON + healthy chain → starts (fail-closed never over-fires; durable loop boots for real)', async () => {
    process.env[DURABLE_FLAG] = 'true'
    const { server, error } = await startServer()
    startedServers.push(server)
    expect(error).toBeNull()
    expect((server.getAddress() as { port?: number } | null)?.port).toBeTruthy()
  })
})
