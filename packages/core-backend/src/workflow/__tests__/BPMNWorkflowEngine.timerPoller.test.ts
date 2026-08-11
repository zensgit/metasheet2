/**
 * #4770/#4779 owner ruling 2026-08-05 (Plan B): `BPMNWorkflowEngine`'s minute
 * timer poller (`startTimerProcessor`) must stay OFF by default and, when
 * enabled, must be trackable/stoppable via `shutdown()`.
 *
 * These are the discriminating legs for both halves of that ruling, at the
 * lowest level that exercises the real production code path (no mocking of
 * `BPMNWorkflowEngine` itself — only `node-cron`'s `schedule` call is spied
 * on, via the SAME module-cache singleton `BPMNWorkflowEngine.ts` itself
 * `require()`s, so a spy installed here observes calls made from inside the
 * class):
 *
 *  - env unset (or any value other than the exact literal `'true'`) ⇒
 *    `cron.schedule` is never called and nothing is registered under
 *    `TIMER_PROCESSOR_JOB_KEY` in `timerJobs` — i.e. no poll query is ever
 *    scheduled, not just "the query itself is skipped once running".
 *  - env `=== 'true'` ⇒ `cron.schedule('* * * * *', ...)` is called exactly
 *    once, the returned task is tracked in `timerJobs`, and `shutdown()`
 *    calls `.stop()` on it.
 *
 * `cron.schedule` is stubbed to return a fake stoppable task (never a real
 * `setInterval`-backed one) so this suite never schedules an actual
 * repeating timer against a real (or absent) database connection. Because
 * that stub's callback never runs, it cannot exercise `shutdown()`'s
 * `timerProcessorTick` drain — the two tests at the bottom of this file
 * cover that separately, by seeding `timerProcessorTick` directly.
 */
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BPMNWorkflowEngine } from '../BPMNWorkflowEngine'
import { BPMN_TIMER_POLLER_ENABLED_ENV } from '../bpmnTimerPollerConfig'

const require = createRequire(import.meta.url)
// The EXACT same require-cache singleton `BPMNWorkflowEngine.ts` itself binds to
// its module-scope `cron` variable via `require('node-cron')` — Node's module
// cache is keyed by resolved path, so this is not a separate copy.
const cronModule = require('node-cron') as { schedule: (...args: unknown[]) => unknown }

const TIMER_PROCESSOR_JOB_KEY = '__timer_processor_poller__'

type EngineInternals = {
  startTimerProcessor: () => void
  timerJobs: Map<string, { start: () => void; stop: () => void }>
  timerProcessorTick: Promise<void>
}

function internals(engine: BPMNWorkflowEngine): EngineInternals {
  return engine as unknown as EngineInternals
}

describe('BPMNWorkflowEngine timer poller env-gate (#4770/#4779 Plan B)', () => {
  let scheduleSpy: ReturnType<typeof vi.spyOn>
  let fakeTask: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    delete process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    fakeTask = { start: vi.fn(), stop: vi.fn() }
    scheduleSpy = vi.spyOn(cronModule, 'schedule').mockReturnValue(fakeTask)
  })

  afterEach(() => {
    scheduleSpy.mockRestore()
    if (originalEnv === undefined) delete process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    else process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = originalEnv
  })

  it('does not call cron.schedule and does not register a poller job when the env flag is unset', () => {
    const engine = new BPMNWorkflowEngine()
    internals(engine).startTimerProcessor()

    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(internals(engine).timerJobs.has(TIMER_PROCESSOR_JOB_KEY)).toBe(false)
    expect(internals(engine).timerJobs.size).toBe(0)
  })

  it('does not call cron.schedule when the env flag is set to a near-miss value ("TRUE", not exact "true")', () => {
    process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = 'TRUE'
    const engine = new BPMNWorkflowEngine()
    internals(engine).startTimerProcessor()

    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(internals(engine).timerJobs.size).toBe(0)
  })

  it('calls cron.schedule("* * * * *", fn) exactly once and tracks the returned task when the env flag is "true"', () => {
    process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = 'true'
    const engine = new BPMNWorkflowEngine()
    internals(engine).startTimerProcessor()

    expect(scheduleSpy).toHaveBeenCalledTimes(1)
    expect(scheduleSpy).toHaveBeenCalledWith('* * * * *', expect.any(Function))
    expect(internals(engine).timerJobs.get(TIMER_PROCESSOR_JOB_KEY)).toBe(fakeTask)
    expect(internals(engine).timerJobs.size).toBe(1)
  })

  it('shutdown() stops the tracked poller task when the poller was enabled', async () => {
    process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = 'true'
    const engine = new BPMNWorkflowEngine()
    internals(engine).startTimerProcessor()

    expect(fakeTask.stop).not.toHaveBeenCalled()
    await engine.shutdown()
    expect(fakeTask.stop).toHaveBeenCalledTimes(1)
  })

  it('shutdown() is a no-op-safe call when the poller was never started (env unset)', async () => {
    const engine = new BPMNWorkflowEngine()
    internals(engine).startTimerProcessor()

    await expect(engine.shutdown()).resolves.toBeUndefined()
    expect(fakeTask.stop).not.toHaveBeenCalled()
  })

  // The two tests above stub `cron.schedule` to a task whose callback never runs, so they
  // cannot exercise `shutdown()`'s `await this.timerProcessorTick.catch(() => undefined)`
  // drain line — `timerProcessorTick` stays the constructor's initial `Promise.resolve()`
  // regardless of whether that line exists. These two tests seed `timerProcessorTick`
  // directly (bypassing `startTimerProcessor`/`cron` entirely) to assert the drain's actual
  // observable behavior: shutdown() must not resolve before an in-flight tick does, and a
  // REJECTED tick (a real production case — the tick body's own try/catch prevents this in
  // practice, but the drain must not depend on that) must not make shutdown() reject either.
  it('shutdown() awaits an in-flight timerProcessorTick before resolving (ordering, not just "was called")', async () => {
    const engine = new BPMNWorkflowEngine()
    const order: string[] = []
    let releaseTick!: () => void
    const pendingTick = new Promise<void>((resolve) => {
      releaseTick = () => {
        order.push('tick')
        resolve()
      }
    })
    internals(engine).timerProcessorTick = pendingTick

    const shutdownDone = engine.shutdown().then(() => {
      order.push('shutdown')
    })

    // Give shutdown() a chance to resolve prematurely if it does NOT await the tick.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual([])

    releaseTick()
    await shutdownDone
    expect(order).toEqual(['tick', 'shutdown'])
  })

  it('shutdown() resolves (not rejects) even when timerProcessorTick is a rejected promise', async () => {
    const engine = new BPMNWorkflowEngine()
    internals(engine).timerProcessorTick = Promise.reject(new Error('tick failed mid-flight'))

    await expect(engine.shutdown()).resolves.toBeUndefined()
  })
})
