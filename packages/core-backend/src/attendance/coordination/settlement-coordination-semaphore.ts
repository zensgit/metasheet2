/**
 * Attendance settlement coordination — a first-come-first-served counting semaphore (§3.2 step 1).
 *
 * Granting and cancelling are atomic: a released permit is handed straight to the first waiter that
 * is still waiting (its state flips to `granted` synchronously), and a deadline or abort only
 * cancels a waiter whose state is still `waiting`. So a permit can never be lost between a release
 * and a cancellation that happen in the same turn, and a cancelled waiter leaves the queue at once,
 * keeping the order of everyone behind it. A waiter that is granted after its own deadline passed
 * receives the permit anyway; deciding to give it back is the caller's job (it owns the budget).
 */
import { CoordinationWaitEndedError, type CoordinationClockV1, type CoordinationTimerV1 } from './settlement-coordination-clock'

export interface CoordinationPermitV1 {
  /** Whether the permit was handed over after queueing (false: it was free when asked for). */
  readonly queued: boolean
  /** Returns the permit; a second call is a programming error and throws. */
  release(): void
}

export interface CoordinationAcquireOptionsV1 {
  readonly clock: CoordinationClockV1
  /** Absolute time (clock.now() scale) after which the wait ends with `deadline`. */
  readonly deadline?: number
  readonly signal?: AbortSignal
}

type WaiterState = 'waiting' | 'granted' | 'cancelled'

interface Waiter {
  state: WaiterState
  resolve(permit: CoordinationPermitV1): void
  reject(error: unknown): void
  cleanup(): void
}

export class CoordinationSemaphoreV1 {
  readonly capacity: number
  #available: number
  readonly #queue: Waiter[] = []

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError(`semaphore capacity must be a positive integer (got ${String(capacity)})`)
    this.capacity = capacity
    this.#available = capacity
  }

  /** Permits currently handed out (including ones granted but not yet observed by their waiter). */
  get held(): number {
    return this.capacity - this.#available
  }

  get waiting(): number {
    return this.#queue.length
  }

  /** Takes a permit only if one is free and nobody is queued (never overtakes a waiter). */
  tryAcquire(): CoordinationPermitV1 | null {
    if (this.#queue.length > 0 || this.#available < 1) return null
    this.#available -= 1
    return this.#permit(false)
  }

  acquire(options: CoordinationAcquireOptionsV1): Promise<CoordinationPermitV1> {
    const immediate = this.tryAcquire()
    if (immediate) return Promise.resolve(immediate)
    if (options.signal?.aborted) return Promise.reject(new CoordinationWaitEndedError('aborted'))
    if (options.deadline !== undefined && options.clock.now() >= options.deadline) {
      return Promise.reject(new CoordinationWaitEndedError('deadline'))
    }
    return new Promise<CoordinationPermitV1>((resolve, reject) => {
      let timer: CoordinationTimerV1 | null = null
      const onAbort = (): void => cancel('aborted')
      const waiter: Waiter = {
        state: 'waiting',
        resolve,
        reject,
        cleanup: () => {
          timer?.cancel()
          options.signal?.removeEventListener('abort', onAbort)
        },
      }
      const cancel = (reason: 'deadline' | 'aborted'): void => {
        if (waiter.state !== 'waiting') return
        waiter.state = 'cancelled'
        const index = this.#queue.indexOf(waiter)
        if (index >= 0) this.#queue.splice(index, 1)
        waiter.cleanup()
        reject(new CoordinationWaitEndedError(reason, { queued: true }))
      }
      this.#queue.push(waiter)
      if (options.deadline !== undefined) {
        timer = options.clock.setTimer(options.deadline - options.clock.now(), () => cancel('deadline'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  #permit(queued: boolean): CoordinationPermitV1 {
    let released = false
    return {
      queued,
      release: () => {
        if (released) throw new Error('coordination permit released twice')
        released = true
        this.#handOff()
      },
    }
  }

  #handOff(): void {
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift() as Waiter
      if (waiter.state !== 'waiting') continue
      waiter.state = 'granted'
      waiter.cleanup()
      waiter.resolve(this.#permit(true))
      return
    }
    this.#available += 1
  }
}
