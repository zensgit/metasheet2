/**
 * A hand-driven clock for coordination tests: time moves only on `advance`, due timers fire in time
 * order, and promise chains get to settle between timers, so races between a grant and a deadline
 * can be staged deterministically.
 */
import {
  sleepOnTimers,
  type CoordinationClockV1,
  type CoordinationTimerV1,
} from '../../src/attendance/coordination/settlement-coordination-clock'

interface PendingTimer {
  at: number
  seq: number
  fn: () => void
  cancelled: boolean
}

/** Lets every pending promise reaction run (setImmediate runs after the microtask queue drains). */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export class ManualCoordinationClock implements CoordinationClockV1 {
  #now = 0
  #seq = 0
  readonly #timers: PendingTimer[] = []

  now(): number {
    return this.#now
  }

  setTimer(ms: number, fn: () => void): CoordinationTimerV1 {
    const timer: PendingTimer = { at: this.#now + Math.max(0, ms), seq: (this.#seq += 1), fn, cancelled: false }
    this.#timers.push(timer)
    return {
      cancel: () => {
        timer.cancelled = true
      },
    }
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleepOnTimers(this, ms, signal)
  }

  /** Timers that are scheduled and not cancelled. */
  get pendingTimers(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms
    for (;;) {
      await settle()
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!due) break
      due.cancelled = true
      this.#now = due.at
      due.fn()
    }
    this.#now = target
    await settle()
  }
}
