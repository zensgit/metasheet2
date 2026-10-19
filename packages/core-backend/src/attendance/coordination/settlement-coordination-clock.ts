/**
 * Attendance settlement coordination — the clock every wait goes through.
 *
 * Quotas, budgets, backoff and the prober never call `Date.now()` or `setTimeout` directly: they take
 * a clock, so tests drive time by hand and production gets a monotonic clock whose timers do not keep
 * the process alive (a CLI that finished its work must be able to exit). Creating a clock has no side
 * effect; nothing here runs at import time.
 */

export interface CoordinationTimerV1 {
  cancel(): void
}

export interface CoordinationClockV1 {
  /** Monotonic milliseconds. */
  now(): number
  /** Runs `fn` after `ms`; the timer never keeps the process alive. */
  setTimer(ms: number, fn: () => void): CoordinationTimerV1
  /** Resolves after `ms`; rejects with `CoordinationWaitEndedError('aborted')` when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export type CoordinationWaitEndReasonV1 = 'deadline' | 'aborted'

/** A wait (quota, sleep, prober result) ended before it was satisfied. */
export class CoordinationWaitEndedError extends Error {
  readonly code = 'ATTENDANCE_COORDINATION_WAIT_ENDED'
  readonly reason: CoordinationWaitEndReasonV1
  /** Whether the waiter had joined a queue before the wait ended (false: it ended on entry). */
  readonly queued: boolean

  constructor(reason: CoordinationWaitEndReasonV1, options: Readonly<{ queued?: boolean }> = {}) {
    super(`ATTENDANCE_COORDINATION_WAIT_ENDED:${reason}`)
    this.name = 'CoordinationWaitEndedError'
    this.reason = reason
    this.queued = options.queued === true
  }
}

/** Sleep built on any `setTimer`, so the system clock and test clocks share the abort semantics. */
export function sleepOnTimers(clock: Pick<CoordinationClockV1, 'setTimer'>, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CoordinationWaitEndedError('aborted'))
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      timer.cancel()
      reject(new CoordinationWaitEndedError('aborted'))
    }
    const timer = clock.setTimer(Math.max(0, ms), () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createSystemCoordinationClockV1(): CoordinationClockV1 {
  const clock: CoordinationClockV1 = {
    now: () => performance.now(),
    setTimer(ms, fn) {
      const handle = setTimeout(fn, Math.max(0, ms))
      handle.unref?.()
      return { cancel: () => clearTimeout(handle) }
    },
    sleep: (ms, signal) => sleepOnTimers(clock, ms, signal),
  }
  return clock
}
