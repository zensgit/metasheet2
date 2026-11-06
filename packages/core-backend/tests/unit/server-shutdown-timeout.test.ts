import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pool as pgPool } from '../../src/db/pg'
import { MetaSheetServer } from '../../src/index'

// R-71 ⑦.2 gate 10: the final shutdown barrier's SHUTDOWN_TIMEOUT branch (MetaSheetServer.stopOnce).
// A YiDa drain that never settles must hold the database pool open: the bounded 10 s wait rejects with
// the values-free code SHUTDOWN_TIMEOUT and pool.end() is never reached, even if the drain settles later.
// No HTTP and no change to src/index.ts: the three private YiDa runtimes are replaced through a type
// assertion, the same technique as approval-completion-shutdown-lifecycle.test.ts.

const RUNTIMES = ['yidaOwnerRuntime', 'yidaInitializationRuntime', 'yidaConnectionTestRuntime'] as const
type RuntimeField = (typeof RUNTIMES)[number]
type Drain = () => Promise<void>
type ShutdownHost = Record<RuntimeField, { stop(): Promise<void> }> & {
  logger: { warn(message: string): void }
  waitForShutdownBarrier(tasks: Array<Promise<unknown>>, failureCode: string, timeoutMessage: string): Promise<void>
}

const TIMEOUT_MESSAGE = 'Shutdown timeout; database pool left open'
// Captured before any test installs fake timers, so polling never moves the fake clock.
const realSetTimeout = globalThis.setTimeout
const realTick = () => new Promise<void>((resolve) => { realSetTimeout(resolve, 5) })

function shutdownHost(drains: Partial<Record<RuntimeField, Drain>> = {}) {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const host = server as unknown as ShutdownHost
  const stops = {} as Record<RuntimeField, ReturnType<typeof vi.fn>>
  for (const field of RUNTIMES) {
    stops[field] = vi.fn(drains[field] ?? (async () => undefined))
    host[field] = { stop: stops[field] as unknown as () => Promise<void> }
  }
  const warn = vi.spyOn(host.logger, 'warn')
  const barrier = vi.spyOn(host, 'waitForShutdownBarrier')
  const finalBarrierCalls = () => barrier.mock.calls.filter(([, code]) => code === 'SHUTDOWN_TIMEOUT')
  const timeoutWarnings = () => warn.mock.calls.filter(([message]) => message === TIMEOUT_MESSAGE).length
  return { server, stops, finalBarrierCalls, timeoutWarnings }
}

type Outcome = { state: 'pending' } | { state: 'resolved' } | { state: 'rejected'; error: unknown }

function observe(stop: Promise<void>): { current: Outcome } {
  const outcome: { current: Outcome } = { current: { state: 'pending' } }
  stop.then(
    () => { outcome.current = { state: 'resolved' } },
    (error: unknown) => { outcome.current = { state: 'rejected', error } },
  )
  return outcome
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (condition()) return
    await realTick()
  }
  throw new Error(`condition not reached: ${label}`)
}

describe('MetaSheetServer final shutdown barrier timeout (SHUTDOWN_TIMEOUT)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each(RUNTIMES)('a hung %s drain times out at exactly 10,000 ms and leaves the database pool open', async (hungField) => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    let release!: () => void
    const hung = new Promise<void>((resolve) => { release = resolve })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { server, stops, finalBarrierCalls, timeoutWarnings } = shutdownHost({ [hungField]: () => hung })

    const stop = server.stop()
    const outcome = observe(stop)
    // Every YiDa drain is started synchronously, before any other shutdown work.
    for (const field of RUNTIMES) expect(stops[field]).toHaveBeenCalledTimes(1)
    await until(() => finalBarrierCalls().length === 1, 'final barrier installed')
    await vi.advanceTimersByTimeAsync(0)
    // Only the final barrier's own 10 s timer is pending; every earlier barrier settled and cleared its timer.
    expect(vi.getTimerCount()).toBe(1)
    expect(finalBarrierCalls()[0][2]).toBe(TIMEOUT_MESSAGE)

    await vi.advanceTimersByTimeAsync(9_999)
    expect(outcome.current).toEqual({ state: 'pending' })
    expect(timeoutWarnings()).toBe(0)
    expect(poolEnd).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.current.state).toBe('rejected')
    const { error } = outcome.current as { state: 'rejected'; error: unknown }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('SHUTDOWN_TIMEOUT')
    expect(timeoutWarnings()).toBe(1)
    expect(poolEnd).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    // The drain settling after the deadline does not resume teardown or close the pool.
    release()
    await vi.advanceTimersByTimeAsync(0)
    await realTick()
    expect(poolEnd).not.toHaveBeenCalled()
    // stop() is latched: a second call returns the same rejected promise and starts no new drain.
    expect(server.stop()).toBe(stop)
    await expect(stop).rejects.toThrow(/^SHUTDOWN_TIMEOUT$/)
    for (const field of RUNTIMES) expect(stops[field]).toHaveBeenCalledTimes(1)
    expect(finalBarrierCalls()).toHaveLength(1)
    expect(poolEnd).not.toHaveBeenCalled()
  })

  it.each(RUNTIMES)('a rejected %s drain fails the barrier with SHUTDOWN_TIMEOUT without waiting and leaves the pool open', async (failedField) => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const { server, timeoutWarnings } = shutdownHost({
      [failedField]: () => Promise.reject(new Error('drain sentinel')),
    })

    const started = Date.now()
    await expect(server.stop()).rejects.toThrow(/^SHUTDOWN_TIMEOUT$/)
    expect(Date.now() - started).toBeLessThan(9_000)
    expect(timeoutWarnings()).toBe(0)
    expect(poolEnd).not.toHaveBeenCalled()
  })

  it('control: settled YiDa drains pass the barrier and the pool closes exactly once', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const { server, stops, finalBarrierCalls, timeoutWarnings } = shutdownHost()

    await server.stop()
    for (const field of RUNTIMES) expect(stops[field]).toHaveBeenCalledTimes(1)
    expect(finalBarrierCalls()).toHaveLength(1)
    expect(timeoutWarnings()).toBe(0)
    expect(poolEnd).toHaveBeenCalledTimes(1)
  })
})
