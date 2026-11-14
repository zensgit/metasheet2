/**
 * R-69 1b-ii — the HOST side of run_integration_job: the IntegrationRunPort registry, its least-privilege
 * exposure (plugin-integration-core only), and T12 — the integration-job drain rides the FINAL shutdown barrier
 * (design baseline v2.3 §10.2.3 step 9, §10.2.5 T12; the verified #6747 fact: on timeout stop() rejects
 * SHUTDOWN_TIMEOUT and the database pool is left open). No HTTP; the private fields are replaced through a type
 * assertion exactly as server-shutdown-timeout.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pool as pgPool } from '../../src/db/pg'
import { MetaSheetServer } from '../../src/index'
import type { PluginContext } from '../../src/types/plugin'
import {
  clearIntegrationRunPortForTest,
  getIntegrationRunPort,
  getIntegrationRunPortOwner,
  registerIntegrationRunPort,
  sanitizeIntegrationRunSummary,
  unregisterIntegrationRunPortOwnedBy,
  type IntegrationRunPort,
} from '../../src/core/integration-run-port'

const TIMEOUT_MESSAGE = 'Shutdown timeout; database pool left open'
const realSetTimeout = globalThis.setTimeout
const realTick = () => new Promise<void>((resolve) => { realSetTimeout(resolve, 5) })
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (condition()) return
    await realTick()
  }
  throw new Error(`condition not reached: ${label}`)
}
type ContextBuilder = { createPluginContext: (loaded: unknown) => PluginContext }
function servicesFor(name: string): Record<string, unknown> {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
  const context = (server as unknown as ContextBuilder).createPluginContext({ manifest: { name, version: '0.0.0' }, path: `/nonexistent/${name}` })
  return context.services as unknown as Record<string, unknown>
}
const port = (): IntegrationRunPort => ({ run: async () => ({ status: 'succeeded' }) })

describe('IntegrationRunPort registry (owner-tracked in its module)', () => {
  afterEach(() => { clearIntegrationRunPortForTest() })

  it('binds one port process-wide, unbinds by its own handle or by owner, and ignores a stale owner', () => {
    expect(getIntegrationRunPort()).toBeUndefined()
    const first = port()
    const unbindFirst = registerIntegrationRunPort('plugin-integration-core', first)
    expect(getIntegrationRunPort()).toBe(first)
    expect(getIntegrationRunPortOwner()).toBe('plugin-integration-core')
    const second = port()
    registerIntegrationRunPort('plugin-integration-core', second)
    unbindFirst() // stale handle: the port is now `second`, so this is a no-op
    expect(getIntegrationRunPort()).toBe(second)
    expect(unregisterIntegrationRunPortOwnedBy('plugin-some-other')).toBe(false)
    expect(getIntegrationRunPort()).toBe(second)
    expect(unregisterIntegrationRunPortOwnedBy('plugin-integration-core')).toBe(true)
    expect(getIntegrationRunPort()).toBeUndefined()
    expect(() => registerIntegrationRunPort('', port())).toThrow(TypeError)
    expect(() => registerIntegrationRunPort('x', {} as IntegrationRunPort)).toThrow(TypeError)
  })

  it('sanitizeIntegrationRunSummary keeps only the closed, values-free shape', () => {
    expect(sanitizeIntegrationRunSummary({ status: 'held', reason: 'manual_confirm_required', canApply: false, counts: { add: 2, bad: 1.5, nested: { x: 1 } }, durationMs: 12.7, missingComponents: ['PART-1'], dryRunToken: 'secret' }))
      .toEqual({ status: 'held', reason: 'manual_confirm_required', canApply: false, counts: { add: 2 }, durationMs: 12 })
    expect(sanitizeIntegrationRunSummary({ status: 'applied' })).toEqual({ status: 'failed', errorClass: 'port_summary_invalid' })
    expect(sanitizeIntegrationRunSummary(null)).toEqual({ status: 'failed', errorClass: 'port_summary_invalid' })
    expect(sanitizeIntegrationRunSummary({ status: 'failed', errorClass: 'x'.repeat(500) }).errorClass).toHaveLength(120)
  })
})

describe('host capability scoping: services.integrationRun', () => {
  afterEach(() => { clearIntegrationRunPortForTest() })

  it('is offered to plugin-integration-core only, and its register() binds owner-tracked and returns the unbind', () => {
    const services = servicesFor('plugin-integration-core')
    const capability = services.integrationRun as { register(port: IntegrationRunPort): () => void } | undefined
    expect(capability).toBeDefined()
    const p = port()
    const unbind = capability!.register(p)
    expect(getIntegrationRunPort()).toBe(p)
    expect(getIntegrationRunPortOwner()).toBe('plugin-integration-core')
    unbind()
    expect(getIntegrationRunPort()).toBeUndefined()
    for (const name of ['plugin-integration-core-shadow', 'Plugin-Integration-Core', ' plugin-integration-core', 'plugin-attendance', 'plugin-some-other']) {
      const other = servicesFor(name)
      expect(typeof other.security, name).toBe('object')
      expect(other.integrationRun, name).toBeUndefined()
    }
  })
})

describe('T5a (service half): stopProducerAdmissions aborts the shutdown signal BEFORE the scheduler drain', () => {
  it('the signal the executor listens to is aborted first, then scheduler.destroy() runs; the abort reason is a values-free code', async () => {
    const { AutomationService } = await import('../../src/multitable/automation-service')
    const { EventBus } = await import('../../src/integration/events/event-bus')
    const service = new AutomationService(new EventBus(), {} as never, vi.fn(async () => ({ rows: [], rowCount: 0 })) as never)
    const signal = service.shutdownSignalForTest
    expect(signal.aborted).toBe(false)
    const scheduler = (service as unknown as { scheduler: { destroy(): Promise<void> } }).scheduler
    let abortedWhenDestroyCalled: boolean | null = null
    const originalDestroy = scheduler.destroy.bind(scheduler)
    scheduler.destroy = vi.fn(async () => { abortedWhenDestroyCalled = signal.aborted; return originalDestroy() })
    await service.stopProducerAdmissions()
    expect(scheduler.destroy).toHaveBeenCalledTimes(1)
    expect(abortedWhenDestroyCalled).toBe(true)
    expect(signal.aborted).toBe(true)
    expect((signal.reason as Error).message).toBe('AUTOMATION_SHUTDOWN')
    await expect(service.drainIntegrationJobs()).resolves.toBeUndefined()
  })
})

type Host = {
  automationService: unknown
  yidaOwnerRuntime: { stop(): Promise<void> }
  yidaInitializationRuntime: { stop(): Promise<void> }
  yidaConnectionTestRuntime: { stop(): Promise<void> }
  logger: { warn(message: string): void }
  waitForShutdownBarrier(tasks: Array<Promise<unknown>>, failureCode: string, timeoutMessage: string): Promise<void>
}
function bareHost() {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const host = server as unknown as Host
  for (const field of ['yidaOwnerRuntime', 'yidaInitializationRuntime', 'yidaConnectionTestRuntime'] as const) host[field] = { stop: async () => undefined }
  const warn = vi.spyOn(host.logger, 'warn')
  const barrier = vi.spyOn(host, 'waitForShutdownBarrier')
  const finalBarrierCalls = () => barrier.mock.calls.filter(([, code]) => code === 'SHUTDOWN_TIMEOUT')
  const producerBarrierCalls = () => barrier.mock.calls.filter(([, code]) => code === 'APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED')
  const timeoutWarnings = () => warn.mock.calls.filter(([message]) => message === TIMEOUT_MESSAGE).length
  return { server, host, finalBarrierCalls, producerBarrierCalls, timeoutWarnings }
}

describe('T12: the integration-job drain is a FINAL-barrier shutdown task', () => {
  beforeEach(() => { vi.stubEnv('NODE_ENV', 'test') })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('a hung drainIntegrationJobs() holds the FINAL barrier: stop() rejects SHUTDOWN_TIMEOUT at 10 s, the pool stays open, and the earlier producer barrier was not the one that failed', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const drain = vi.fn(() => new Promise<void>(() => undefined))
    const stopProducerAdmissions = vi.fn(async () => undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { server, host, finalBarrierCalls, producerBarrierCalls, timeoutWarnings } = bareHost()
    host.automationService = {
      stopProducerAdmissions,
      drainTransitiveCompletionProducers: async () => undefined,
      detachCompletionConsumers: () => undefined,
      drainCompletionConsumers: async () => undefined,
      drainIntegrationJobs: drain,
    }
    let outcome: 'pending' | 'resolved' | { rejected: unknown } = 'pending'
    const stop = server.stop()
    stop.then(() => { outcome = 'resolved' }, (error: unknown) => { outcome = { rejected: error } })
    await until(() => finalBarrierCalls().length === 1, 'final barrier installed')
    await vi.advanceTimersByTimeAsync(0)
    expect(stopProducerAdmissions).toHaveBeenCalledTimes(1)
    expect(drain).toHaveBeenCalledTimes(1)
    // the producer barriers all settled (their timers are gone); the hung drain sits in the FINAL barrier only
    expect(producerBarrierCalls().length).toBeGreaterThanOrEqual(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toMatchObject({ rejected: expect.objectContaining({ message: 'SHUTDOWN_TIMEOUT' }) })
    expect(timeoutWarnings()).toBe(1)
    expect(poolEnd).not.toHaveBeenCalled()
    await expect(stop).rejects.toThrow(/^SHUTDOWN_TIMEOUT$/)
  })

  it('a settled drain passes the final barrier and the pool closes once; a bare server (no automation service) and a pre-1b-ii service double (no drainIntegrationJobs) both pass without creating a timer', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const drained = bareHost()
    const drain = vi.fn(async () => undefined)
    drained.host.automationService = {
      stopProducerAdmissions: async () => undefined,
      drainTransitiveCompletionProducers: async () => undefined,
      detachCompletionConsumers: () => undefined,
      drainCompletionConsumers: async () => undefined,
      drainIntegrationJobs: drain,
    }
    await drained.server.stop()
    expect(drain).toHaveBeenCalledTimes(1)
    expect(drained.finalBarrierCalls()).toHaveLength(1)
    expect(drained.timeoutWarnings()).toBe(0)
    expect(poolEnd).toHaveBeenCalledTimes(1)

    const legacy = bareHost()
    legacy.host.automationService = {
      stopProducerAdmissions: async () => undefined,
      drainTransitiveCompletionProducers: async () => undefined,
      detachCompletionConsumers: () => undefined,
      drainCompletionConsumers: async () => undefined,
    }
    await legacy.server.stop()
    expect(legacy.finalBarrierCalls()).toHaveLength(1)
    expect(poolEnd).toHaveBeenCalledTimes(2)

    const bare = bareHost()
    await bare.server.stop()
    expect(bare.finalBarrierCalls()).toHaveLength(1)
    expect(poolEnd).toHaveBeenCalledTimes(3)
  })
})
