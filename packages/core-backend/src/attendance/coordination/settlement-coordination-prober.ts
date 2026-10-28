/**
 * Attendance settlement coordination — one prober per (org, lock family) (§3.2 step 1, L-05).
 *
 * When a queued-type try loses on a family, that (org, family) enters contention and the loser
 * becomes its prober. Other units of the same org that need the family wait in arrival order for
 * results instead of taking quota or borrowing connections; units that do not need it are not
 * affected. The prober keeps trying itself after each failure (failure never changes the prober) and
 * every result it reports — failure or undetermined — is news that restarts the takeover clock.
 *
 *  - Contention ends when any unit observes the family's lock free (for the dedicated family that is
 *    `k_ok` true, even when class-00 failed in the same S1); every waiter then re-enters from the top.
 *  - A prober that leaves without success (budget, error, abort) hands the probe to the head of the
 *    queue before it goes; only a lost prober (silent for `takeoverMs`, 400 ms) is replaced by the
 *    head through the timer. An empty queue ends the contention.
 *  - Every hand-over or takeover bumps the state's epoch. A superseded prober still holding the old
 *    epoch is not a prober any more: its reports are ignored and it must queue as a waiter.
 *  - A state with no waiters and no news for `staleMs` (30 s) is dropped — hygiene, not correctness.
 *  - Entering contention is synchronous, so two units that lose in the same turn produce one prober
 *    and one waiter. Granting a role to a waiter and cancelling the waiter are atomic, as in the
 *    semaphore.
 *
 * Callers that try only once (scanner, CLI, other one-shot checks) never use this registry. Timers
 * exist only while a contention state exists; nothing here runs at import time.
 */
import { CoordinationWaitEndedError, type CoordinationClockV1, type CoordinationTimerV1 } from './settlement-coordination-clock'

export type SettlementCoordinationFamilyV1 = 'dedicated' | 'class-00'

export const SETTLEMENT_COORDINATION_PROBER_TAKEOVER_MS = 400
export const SETTLEMENT_COORDINATION_PROBER_STALE_MS = 30_000

export interface SettlementCoordinationProbeTicketV1 {
  readonly org: string
  readonly family: SettlementCoordinationFamilyV1
  readonly epoch: number
  readonly unit: symbol
}

export type SettlementCoordinationProbeWaitResultV1 =
  | Readonly<{ kind: 'retry' }>
  | Readonly<{ kind: 'prober'; ticket: SettlementCoordinationProbeTicketV1 }>

export type SettlementCoordinationProbeFailureRoleV1 =
  | Readonly<{ role: 'prober'; ticket: SettlementCoordinationProbeTicketV1 }>
  | Readonly<{ role: 'waiter' }>

interface Waiter {
  readonly unit: symbol
  state: 'waiting' | 'resolved' | 'cancelled'
  resolve(result: SettlementCoordinationProbeWaitResultV1): void
  cleanup(): void
}

interface ContentionState {
  readonly key: string
  readonly org: string
  readonly family: SettlementCoordinationFamilyV1
  epoch: number
  prober: symbol
  readonly queue: Waiter[]
  /** Last result reported by the current prober (or the moment it became prober). */
  lastNewsAt: number
  /** Last activity of any kind: news, a waiter joining or leaving. */
  lastActivityAt: number
  takeoverTimer: CoordinationTimerV1 | null
  staleTimer: CoordinationTimerV1 | null
}

export interface SettlementCoordinationProberOptionsV1 {
  readonly clock: CoordinationClockV1
  readonly takeoverMs?: number
  readonly staleMs?: number
}

export class SettlementCoordinationProberRegistryV1 {
  readonly #clock: CoordinationClockV1
  readonly #takeoverMs: number
  readonly #staleMs: number
  readonly #states = new Map<string, ContentionState>()

  constructor(options: SettlementCoordinationProberOptionsV1) {
    this.#clock = options.clock
    this.#takeoverMs = options.takeoverMs ?? SETTLEMENT_COORDINATION_PROBER_TAKEOVER_MS
    this.#staleMs = options.staleMs ?? SETTLEMENT_COORDINATION_PROBER_STALE_MS
  }

  /** Whether `unit` must wait before trying `family` (contention exists and someone else probes it). */
  mustWait(org: string, family: SettlementCoordinationFamilyV1, unit: symbol): boolean {
    const state = this.#states.get(stateKey(org, family))
    return state !== undefined && state.prober !== unit
  }

  /** True only for the ticket of the current prober of its (org, family). */
  isCurrent(ticket: SettlementCoordinationProbeTicketV1): boolean {
    const state = this.#states.get(stateKey(ticket.org, ticket.family))
    return state !== undefined && state.epoch === ticket.epoch && state.prober === ticket.unit
  }

  /**
   * A queued-type try of `unit` lost on `family`. Without contention, `unit` becomes the prober.
   * The current prober (valid ticket) broadcasts a failure and stays prober. Anyone else — including
   * a prober superseded by a takeover — must wait.
   */
  reportFailure(
    org: string,
    family: SettlementCoordinationFamilyV1,
    unit: symbol,
    ticket?: SettlementCoordinationProbeTicketV1,
  ): SettlementCoordinationProbeFailureRoleV1 {
    const key = stateKey(org, family)
    let state = this.#states.get(key)
    if (!state) {
      const now = this.#clock.now()
      state = { key, org, family, epoch: 1, prober: unit, queue: [], lastNewsAt: now, lastActivityAt: now, takeoverTimer: null, staleTimer: null }
      this.#states.set(key, state)
      this.#onNews(state)
      return Object.freeze({ role: 'prober' as const, ticket: ticketOf(state) })
    }
    if (ticket && state.epoch === ticket.epoch && state.prober === unit) {
      this.#onNews(state)
      return Object.freeze({ role: 'prober' as const, ticket: ticketOf(state) })
    }
    return Object.freeze({ role: 'waiter' as const })
  }

  /** The prober could not decide (statement error, destroyed connection): still news. */
  reportUndetermined(ticket: SettlementCoordinationProbeTicketV1): void {
    if (!this.isCurrent(ticket)) return
    this.#onNews(this.#states.get(stateKey(ticket.org, ticket.family)) as ContentionState)
  }

  /** The family's lock was observed free by any unit: contention ends and every waiter re-enters. */
  reportFree(org: string, family: SettlementCoordinationFamilyV1): void {
    const state = this.#states.get(stateKey(org, family))
    if (state) this.#end(state)
  }

  /** The prober leaves without success: the head of the queue becomes prober, or contention ends. */
  handOver(ticket: SettlementCoordinationProbeTicketV1): void {
    if (!this.isCurrent(ticket)) return
    this.#promoteHead(this.#states.get(stateKey(ticket.org, ticket.family)) as ContentionState)
  }

  /** Waits, in arrival order, for the contention on (org, family) to end or for the probe to be handed over. */
  wait(
    org: string,
    family: SettlementCoordinationFamilyV1,
    unit: symbol,
    options: Readonly<{ deadline?: number; signal?: AbortSignal }> = {},
  ): Promise<SettlementCoordinationProbeWaitResultV1> {
    const state = this.#states.get(stateKey(org, family))
    if (!state) return Promise.resolve(Object.freeze({ kind: 'retry' as const }))
    if (state.prober === unit) return Promise.resolve(Object.freeze({ kind: 'prober' as const, ticket: ticketOf(state) }))
    if (options.signal?.aborted) return Promise.reject(new CoordinationWaitEndedError('aborted'))
    if (options.deadline !== undefined && this.#clock.now() >= options.deadline) {
      return Promise.reject(new CoordinationWaitEndedError('deadline'))
    }
    return new Promise<SettlementCoordinationProbeWaitResultV1>((resolve, reject) => {
      let timer: CoordinationTimerV1 | null = null
      const onAbort = (): void => cancel('aborted')
      const waiter: Waiter = {
        unit,
        state: 'waiting',
        resolve,
        cleanup: () => {
          timer?.cancel()
          options.signal?.removeEventListener('abort', onAbort)
        },
      }
      const cancel = (reason: 'deadline' | 'aborted'): void => {
        if (waiter.state !== 'waiting') return
        waiter.state = 'cancelled'
        const current = this.#states.get(stateKey(org, family))
        if (current) {
          const index = current.queue.indexOf(waiter)
          if (index >= 0) current.queue.splice(index, 1)
          current.lastActivityAt = this.#clock.now()
          this.#armTimers(current)
        }
        waiter.cleanup()
        reject(new CoordinationWaitEndedError(reason, { queued: true }))
      }
      state.queue.push(waiter)
      // Joining is activity, not news: it never postpones the takeover of a silent prober.
      state.lastActivityAt = this.#clock.now()
      this.#armTimers(state)
      if (options.deadline !== undefined) timer = this.#clock.setTimer(options.deadline - this.#clock.now(), () => cancel('deadline'))
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Current contention states (for tests and the attempt ledger). */
  snapshot(): ReadonlyArray<Readonly<{ org: string; family: SettlementCoordinationFamilyV1; epoch: number; waiting: number }>> {
    return [...this.#states.values()].map((state) => ({ org: state.org, family: state.family, epoch: state.epoch, waiting: state.queue.length }))
  }

  #onNews(state: ContentionState): void {
    const now = this.#clock.now()
    state.lastNewsAt = now
    state.lastActivityAt = now
    this.#armTimers(state)
  }

  /**
   * While someone waits: the takeover timer, due `takeoverMs` after the prober's last news. While
   * nobody waits: the stale timer, due `staleMs` after the last activity. Never both.
   */
  #armTimers(state: ContentionState): void {
    state.takeoverTimer?.cancel()
    state.staleTimer?.cancel()
    state.takeoverTimer = null
    state.staleTimer = null
    if (this.#states.get(state.key) !== state) return
    const now = this.#clock.now()
    if (state.queue.length > 0) {
      state.takeoverTimer = this.#clock.setTimer(Math.max(0, state.lastNewsAt + this.#takeoverMs - now), () => this.#promoteHead(state))
    } else {
      state.staleTimer = this.#clock.setTimer(Math.max(0, state.lastActivityAt + this.#staleMs - now), () => this.#end(state))
    }
  }

  #promoteHead(state: ContentionState): void {
    if (this.#states.get(state.key) !== state) return
    while (state.queue.length > 0) {
      const head = state.queue.shift() as Waiter
      if (head.state !== 'waiting') continue
      head.state = 'resolved'
      head.cleanup()
      state.epoch += 1
      state.prober = head.unit
      // The new prober starts with a fresh takeover clock.
      const now = this.#clock.now()
      state.lastNewsAt = now
      state.lastActivityAt = now
      this.#armTimers(state)
      head.resolve(Object.freeze({ kind: 'prober' as const, ticket: ticketOf(state) }))
      return
    }
    this.#end(state)
  }

  #end(state: ContentionState): void {
    if (this.#states.get(state.key) !== state) return
    this.#states.delete(state.key)
    state.takeoverTimer?.cancel()
    state.staleTimer?.cancel()
    state.takeoverTimer = null
    state.staleTimer = null
    for (const waiter of state.queue.splice(0)) {
      if (waiter.state !== 'waiting') continue
      waiter.state = 'resolved'
      waiter.cleanup()
      waiter.resolve(Object.freeze({ kind: 'retry' as const }))
    }
  }
}

function stateKey(org: string, family: SettlementCoordinationFamilyV1): string {
  return `${family}\u0000${org}`
}

function ticketOf(state: ContentionState): SettlementCoordinationProbeTicketV1 {
  return Object.freeze({ org: state.org, family: state.family, epoch: state.epoch, unit: state.prober })
}
