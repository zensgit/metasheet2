/**
 * Attendance settlement coordination — the acquisition budget of one coordination unit (§3.2 step 9).
 *
 * One budget per coordination unit, carried across its coordination restarts and outer retries (it
 * is never reset on retry). Only the waits it counts spend it: quota waits (request-path units only),
 * connection waits (including the candidate short read), tries and backoff, and waiting for the
 * prober's result. Business execution, cleanup and the outer loop's jitter sleep (step 8(c)) happen
 * between those waits and spend nothing: what remains is the limit minus what was recorded, never the
 * time since the unit was opened. When it runs out, the error is named after the stage that
 * accumulated the longest wait; waiting for a prober counts towards the family waited for.
 *
 * Background units (scheduled absence, sweep, import workers) do not count quota waits at all; each
 * of their quota waits has its own 30 s cap instead.
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
  readonly limitMs: number
  readonly background: boolean
  readonly #waits: Record<SettlementCoordinationStageV1, number> = { 'class-00': 0, dedicated: 0, quota: 0, connect: 0, cleaning: 0 }
  #spentMs = 0

  constructor(options: SettlementCoordinationBudgetOptionsV1) {
    this.#clock = options.clock
    this.limitMs = options.limitMs ?? SETTLEMENT_COORDINATION_REQUEST_BUDGET_MS
    this.background = options.background === true
  }

  /** What the counted waits have spent so far. */
  get spentMs(): number {
    return this.#spentMs
  }

  remaining(): number {
    return Math.max(0, this.limitMs - this.#spentMs)
  }

  exhausted(): boolean {
    return this.#spentMs >= this.limitMs
  }

  /** Deadline for a counted wait that starts now: it may spend at most what remains. */
  deadline(): number {
    return this.#clock.now() + this.remaining()
  }

  /** Deadline for one quota wait: the budget's for request units, now + 30 s for background units. */
  quotaDeadline(): number {
    return this.background ? this.#clock.now() + SETTLEMENT_COORDINATION_BACKGROUND_QUOTA_WAIT_MS : this.deadline()
  }

  /** Spends `ms` on a stage. Background units do not count quota waits. */
  record(stage: SettlementCoordinationStageV1, ms: number): void {
    if (!(ms > 0)) return
    if (stage === 'quota' && this.background) return
    this.#waits[stage] += ms
    this.#spentMs += ms
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
