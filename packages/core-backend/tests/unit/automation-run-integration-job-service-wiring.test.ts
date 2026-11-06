/**
 * R-69 1b-ii — the PRODUCTION AutomationService hands its executor the three run_integration_job deps
 * (automation-service.ts, the `deps` literal in the constructor). Every other suite proves I-4, T12 and port
 * reachability on an executor built by the test itself; this one reads the executor the real service built:
 *   - `integrationRunPort`: the module registry's port, LATE-BOUND (the plugin activates after this constructor;
 *     an unbound registry answers null, fail closed — never a stale capture);
 *   - `shutdownSignal`: the service's own controller, the one `stopProducerAdmissions()` aborts (I-4);
 *   - `trackIntegrationJobTask`: lands a continuation in the set `drainIntegrationJobs()` waits on (T12).
 * The private fields are read through a type assertion exactly as server-shutdown-timeout.test.ts does. No HTTP,
 * no database (the query function is a stub that is never reached), no plugin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import type { AutomationDeps } from '../../src/multitable/automation-executor'
import { clearIntegrationRunPortForTest, registerIntegrationRunPort, type IntegrationRunPort } from '../../src/core/integration-run-port'

type Internals = { executor: { deps: AutomationDeps }; integrationJobsInFlight: Set<Promise<void>> }
const realSetTimeout = globalThis.setTimeout
const pause = (ms: number) => new Promise<void>((resolve) => { realSetTimeout(resolve, ms) })

describe('AutomationService wires the run_integration_job deps into the executor it builds (production wiring)', () => {
  afterEach(() => { clearIntegrationRunPortForTest() })

  it('the port getter is late-bound to the registry, the shutdown signal is the service controller, and a tracked continuation holds drainIntegrationJobs()', async () => {
    const service = new AutomationService(new EventBus(), {} as never, vi.fn(async () => ({ rows: [], rowCount: 0 })) as never)
    const internals = service as unknown as Internals
    const deps = internals.executor.deps
    try {
      // port: nothing bound yet ⇒ null (fail closed); after the plugin registers ⇒ THAT port through the SAME getter;
      // after it unbinds ⇒ null again. A getter that captured the registry's value at construction would stay null.
      expect(typeof deps.integrationRunPort).toBe('function')
      expect(deps.integrationRunPort!()).toBeNull()
      const port: IntegrationRunPort = { run: async () => ({ status: 'succeeded' }) }
      const unbind = registerIntegrationRunPort('plugin-integration-core', port)
      expect(deps.integrationRunPort!()).toBe(port)
      unbind()
      expect(deps.integrationRunPort!()).toBeNull()

      // shutdown signal: the very signal the service aborts in stopProducerAdmissions() (asserted below)
      expect(deps.shutdownSignal).toBe(service.shutdownSignalForTest)
      expect(deps.shutdownSignal!.aborted).toBe(false)

      // continuation tracking: a tracked promise keeps drainIntegrationJobs() pending until it settles
      expect(typeof deps.trackIntegrationJobTask).toBe('function')
      let release!: () => void
      const continuation = new Promise<void>((resolve) => { release = resolve })
      deps.trackIntegrationJobTask!(continuation)
      expect(internals.integrationJobsInFlight.size).toBe(1)
      let drained = false
      const drain = service.drainIntegrationJobs().then(() => { drained = true })
      await pause(20)
      expect(drained).toBe(false)
      release()
      await drain
      expect(drained).toBe(true)
      expect(internals.integrationJobsInFlight.size).toBe(0)
    } finally {
      // I-4: the abort reaches the signal the executor holds (and the scheduler is destroyed either way)
      await service.stopProducerAdmissions()
    }
    expect(deps.shutdownSignal!.aborted).toBe(true)
  })
})
