/**
 * Attendance settlement coordination — the acquisition budget of one coordination unit (§3.2 step 9).
 *
 * One budget per coordination unit, carried across its coordination restarts and outer retries (it
 * is never reset on retry). It counts quota waits (request-path units only), connection waits
 * (including the candidate short read), tries and backoff, and waiting for the prober's result;
 * business execution and cleanup are not counted. When it runs out, the error is named after the
 * stage that accumulated the longest wait; waiting for a prober counts towards the family waited for.
 *
 * Background units (scheduled absence, sweep, import workers) do not count quota waits against the
 * budget; each of their quota waits has its own 30 s cap instead, and the time spent in it is taken
 * out of the budget's elapsed time (their deadline moves out by the quota wait).
 */
import type { CoordinationClockV1 } from './settlement-coordination-clock'

export type SettlementCoordinationStageV1 = 'class-00' | 'dedicated' | 'quota' | 'connect' | 'cleaning'

export const SETTLEMENT_COORDINATION_REQUEST_BUDGET_MS = 5000
export const SETTLEMENT_COORDINATION_BACKGROUND_QUOTA_WAIT_MS = 30_000

/** Codes when the budget runs out, per stage (§3.2 step 9). */
export const SETTLEMENT_COORDINATION_EXHAUSTION_CODES: Readonly<Record<SettlementCoordinationStageV1, string>> = Object.freeze({
  'class-00': 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY',
  dedicated: 'ATTENDANCE_SETTLEMENT_COORDINATION_BUSY',
  quota: 'ATTENDANCE_COORDINATION_CAPACITY_BUSY',
  connect: 'ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE',
  // Cleaning entries keep their existing external codes (§3.2 step 5); this is the busy default.
  cleaning: 'ATTENDANCE_CLEANING_BUSY',
})

/** Tie-break order when two stages accumulated the same wait. */
const STAGE_ORDER: readonly SettlementCoordinationStageV1[] = ['dedicated', 'class-00', 'quota', 'connect', 'cleaning']

export interface SettlementCoordinationBudgetOptionsV1 {
  readonly clock: CoordinationClockV1
  readonly limitMs?: number
  /** Background units: quota waits are capped per wait and not counted against the budget. */
  readonly background?: boolean
}

export class SettlementCoordinationBudgetV1 {
  readonly #clock: CoordinationClockV1
  readonly startedAt: number
  readonly limitMs: number
  readonly background: boolean
  readonly #waits: Record<SettlementCoordinationStageV1, number> = { 'class-00': 0, dedicated: 0, quota: 0, connect: 0, cleaning: 0 }
  /** Background units: quota-wait time that does not count against the budget. */
  #excludedMs = 0

  constructor(options: SettlementCoordinationBudgetOptionsV1) {
    this.#clock = options.clock
    this.limitMs = options.limitMs ?? SETTLEMENT_COORDINATION_REQUEST_BUDGET_MS
    this.background = options.background === true
    this.startedAt = this.#clock.now()
  }

  get deadline(): number {
    return this.startedAt + this.limitMs + this.#excludedMs
  }

  remaining(): number {
    return Math.max(0, this.deadline - this.#clock.now())
  }

  exhausted(): boolean {
    return this.remaining() <= 0
  }

  /** Deadline for one quota wait: the budget's for request units, now + 30 s for background units. */
  quotaDeadline(): number {
    return this.background ? this.#clock.now() + SETTLEMENT_COORDINATION_BACKGROUND_QUOTA_WAIT_MS : this.deadline
  }

  /** Adds a wait to a stage. Background units do not count quota waits (their deadline moves out instead). */
  record(stage: SettlementCoordinationStageV1, ms: number): void {
    if (!(ms > 0)) return
    if (stage === 'quota' && this.background) {
      this.#excludedMs += ms
      return
    }
    this.#waits[stage] += ms
  }

  waits(): Readonly<Record<SettlementCoordinationStageV1, number>> {
    return { ...this.#waits }
  }

  /** The stage that waited longest (ties broken by a fixed order). */
  dominantStage(): SettlementCoordinationStageV1 {
    let best: SettlementCoordinationStageV1 = STAGE_ORDER[0]
    for (const stage of STAGE_ORDER) if (this.#waits[stage] > this.#waits[best]) best = stage
    return best
  }

  exhaustionCode(): string {
    return SETTLEMENT_COORDINATION_EXHAUSTION_CODES[this.dominantStage()]
  }
}
