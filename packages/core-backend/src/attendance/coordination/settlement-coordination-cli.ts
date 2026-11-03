/**
 * Attendance settlement coordination — the CLI variant of the coordinated-transaction port
 * (§1.1 P1-1 "另有 CLI 变体", §3.5 "按协调器 CLI 变体退避，不阻塞").
 *
 * An independent process (a transition or repair CLI) has its own pool, no request budget to
 * protect and no neighbours to share a prober with. Its unit therefore tries exactly once per
 * attempt (`oneShot`: no contention state is made, read or ended, and nothing waits on another
 * process's prober), and the variant retries a refused acquisition itself: a fresh unit for every
 * attempt, a backoff sleep in between that no budget counts, and no retry for anything other than
 * that unit's own refusal — decided on the unit (`refused`), never on the error class, because the
 * same class can arrive after COMMIT from a callback or a deferred result, and a business error, an
 * exhausted restart counter, a conflict code or an uncertain connection reach the caller the first
 * time. The backoff timer keeps the process alive: a CLI waiting for its next attempt must not exit
 * under it.
 *
 * The coordinator comes from `createSettlementCoordinationCliCoordinatorV1`, which validates the
 * capacity before constructing anything (S3 note 9: a pool too small for the layout fails with a
 * named code, not with the semaphore's RangeError). The §3.6 floors are the service process's
 * (`reservedConnections ≥ 4`, `txnSlots ≥ 2`); a CLI's private pool is laid out as small as the
 * primitives allow — one short unit at a time, with `SETTLEMENT_COORDINATION_CLI_MIN_POOL_MAX`
 * connections — and anything larger goes to short units.
 *
 * Nothing in production builds this: the static inertness guard pins the factory and the port.
 */
import {
  deriveSettlementCoordinationCapacityV1,
  type SettlementCoordinationCapacityInputV1,
  type SettlementCoordinationCapacityV1,
} from './settlement-coordination-capacity'
import type { CoordinationClockV1 } from './settlement-coordination-clock'
import { coordinatedTransactionV1, type SettlementCoordinatedTransactionOptionsV1 } from './settlement-coordination-port'
import {
  SettlementCoordinationAbortedError,
  SettlementCoordinationAcquireError,
  createSettlementCoordinatorV1,
  type SettlementCoordinationAttemptRecordV1,
  type SettlementCoordinationPoolV1,
  type SettlementCoordinationUnitRequestV1,
  type SettlementCoordinatorV1,
} from './settlement-coordinator'

// ---------------------------------------------------------------------------
// Capacity for a private pool
// ---------------------------------------------------------------------------

/** EXCL 1 + SCAN 1 + LONG 1 + TXN 1, nothing reserved. */
export const SETTLEMENT_COORDINATION_CLI_MIN_POOL_MAX = 4

/** The CLI pool cannot carry the coordination layout. */
export class AttendanceCoordinationCapacityError extends Error {
  readonly code = 'ATTENDANCE_COORDINATION_CAPACITY_INVALID'
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`ATTENDANCE_COORDINATION_CAPACITY_INVALID: ${problems.join('; ')}`)
    this.name = 'AttendanceCoordinationCapacityError'
    this.problems = problems
  }
}

/** What the primitives need of any layout: positive slot counts, nothing beyond the pool. */
export function validateSettlementCoordinationCliCapacityV1(capacity: SettlementCoordinationCapacityV1): string[] {
  const problems: string[] = []
  const positive: Array<[string, number]> = [
    ['poolMax', capacity.poolMax],
    ['exclusiveSlots', capacity.exclusiveSlots],
    ['longTxnSlots', capacity.longTxnSlots],
    ['txnSlots', capacity.txnSlots],
    ['orgTxnSlots', capacity.orgTxnSlots],
  ]
  for (const [name, value] of positive) {
    if (!Number.isSafeInteger(value) || value < 1) problems.push(`${name} must be a positive integer (got ${String(value)})`)
  }
  if (!Number.isSafeInteger(capacity.reservedConnections) || capacity.reservedConnections < 0) {
    problems.push(`reservedConnections must be a non-negative integer (got ${String(capacity.reservedConnections)})`)
  }
  if (capacity.orgTxnSlots > capacity.txnSlots) problems.push('orgTxnSlots must not exceed txnSlots')
  const total = capacity.exclusiveSlots + capacity.scanSlots + capacity.longTxnSlots + capacity.txnSlots + capacity.reservedConnections
  if (total > capacity.poolMax) problems.push(`EXCL + SCAN + LONG + TXN + RESERVED (${total}) exceeds poolMax (${capacity.poolMax})`)
  return problems
}

/**
 * The smallest layout for a CLI pool of `poolMax` connections, every field overridable. Throws
 * `AttendanceCoordinationCapacityError` instead of letting a semaphore fail later.
 */
export function deriveSettlementCoordinationCliCapacityV1(
  poolMax: number,
  overrides: Omit<SettlementCoordinationCapacityInputV1, 'poolMax'> = {},
): SettlementCoordinationCapacityV1 {
  const exclusiveSlots = overrides.exclusiveSlots ?? 1
  const longTxnSlots = overrides.longTxnSlots ?? 1
  const reservedConnections = overrides.reservedConnections ?? 0
  const capacity = deriveSettlementCoordinationCapacityV1({
    poolMax,
    exclusiveSlots,
    longTxnSlots,
    reservedConnections,
    txnSlots: overrides.txnSlots ?? poolMax - exclusiveSlots - 1 - longTxnSlots - reservedConnections,
    orgTxnSlots: overrides.orgTxnSlots ?? 1,
  })
  const problems = validateSettlementCoordinationCliCapacityV1(capacity)
  if (problems.length > 0) throw new AttendanceCoordinationCapacityError(problems)
  return capacity
}

export interface SettlementCoordinationCliCoordinatorOptionsV1 {
  readonly pool: SettlementCoordinationPoolV1
  /** The CLI pool's `max`. */
  readonly poolMax: number
  readonly capacity?: Omit<SettlementCoordinationCapacityInputV1, 'poolMax'>
  /** Default 10 s: a CLI waits for a connection of its own pool, not for a request's. */
  readonly connectTimeoutMs?: number
  readonly clock?: CoordinationClockV1
  readonly random?: () => number
  readonly onAttempt?: (record: SettlementCoordinationAttemptRecordV1) => void
}

/** A coordinator over the CLI's own pool, with the capacity validated first. */
export function createSettlementCoordinationCliCoordinatorV1(options: SettlementCoordinationCliCoordinatorOptionsV1): SettlementCoordinatorV1 {
  return createSettlementCoordinatorV1({
    pool: options.pool,
    capacity: deriveSettlementCoordinationCliCapacityV1(options.poolMax, options.capacity),
    connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
    clock: options.clock,
    random: options.random,
    onAttempt: options.onAttempt,
  })
}

// ---------------------------------------------------------------------------
// One-shot attempts with the CLI's own backoff
// ---------------------------------------------------------------------------

export const SETTLEMENT_COORDINATION_CLI_DEFAULT_ATTEMPTS = 5
/** Sleep before the next attempt after the n-th refusal; the last entry repeats. */
export const SETTLEMENT_COORDINATION_CLI_DEFAULT_BACKOFF_MS: readonly number[] = Object.freeze([200, 500, 1000, 2000])
export const SETTLEMENT_COORDINATION_CLI_DEFAULT_JITTER = 0.25

export interface SettlementCoordinationCliRetryV1 {
  /** Attempts in all, each a fresh one-shot unit. Default 5. */
  readonly attempts?: number
  /** Backoff schedule in milliseconds; the last entry repeats. */
  readonly backoffMs?: readonly number[]
  /** Fraction of the schedule entry spread symmetrically around it (0 … 1). Default 0.25. */
  readonly jitter?: number
  /** Resolves after `ms`, or as soon as `signal` aborts. The default timer keeps the process alive. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
  /** Observer of each refused attempt, for the CLI's own progress output. */
  readonly onBusy?: (info: { readonly attempt: number; readonly error: SettlementCoordinationAcquireError; readonly sleepMs: number }) => void
}

export interface SettlementCoordinationCliTransactionOptionsV1<T> extends Omit<SettlementCoordinatedTransactionOptionsV1<T>, 'request' | 'unit'> {
  /** `oneShot` is set here; `background` defaults to true (a CLI is not a request path). */
  readonly request: Omit<SettlementCoordinationUnitRequestV1, 'oneShot'>
  readonly retry?: SettlementCoordinationCliRetryV1
}

/** Referenced on purpose: the process must stay up while the CLI waits for its next attempt. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Runs the coordinated transaction as a CLI does: one try per attempt, the CLI's own backoff between
 * refused attempts, and every attempt a fresh unit, so nothing is carried from one to the next.
 */
export async function coordinatedTransactionCliV1<T>(options: SettlementCoordinationCliTransactionOptionsV1<T>): Promise<T> {
  const retry = options.retry ?? {}
  const attempts = retry.attempts ?? SETTLEMENT_COORDINATION_CLI_DEFAULT_ATTEMPTS
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new TypeError(`settlement coordination CLI: attempts must be a positive integer (got ${String(attempts)})`)
  const schedule = retry.backoffMs ?? SETTLEMENT_COORDINATION_CLI_DEFAULT_BACKOFF_MS
  const jitter = retry.jitter ?? SETTLEMENT_COORDINATION_CLI_DEFAULT_JITTER
  if (!(jitter >= 0 && jitter <= 1)) throw new TypeError(`settlement coordination CLI: jitter must be within 0 and 1 (got ${String(jitter)})`)
  const sleep = retry.sleep ?? defaultSleep
  const random = retry.random ?? Math.random
  const { retry: _retry, request: requested, ...rest } = options
  const request: SettlementCoordinationUnitRequestV1 = { background: true, ...requested, oneShot: true }
  for (let attempt = 1; ; attempt += 1) {
    const unit = options.coordinator.openUnit(request)
    let error: unknown
    try {
      return await coordinatedTransactionV1<T>({ ...rest, request, unit })
    } catch (thrown) {
      error = thrown
    } finally {
      // Closed before any backoff: a unit waiting for its next attempt would still count as in flight.
      unit.close()
    }
    // Only this attempt's own refused acquisition is retried: it wrote nothing. The same error class
    // from a body, a post-commit callback or a deferred result is not, since the outer transaction
    // may already be committed.
    if (!unit.refused(error) || attempt >= attempts) throw error
    if (request.signal?.aborted) throw new SettlementCoordinationAbortedError()
    const base = schedule.length === 0 ? 0 : schedule[Math.min(attempt, schedule.length) - 1]
    const sleepMs = Math.max(0, Math.round(base * (1 + jitter * (2 * random() - 1))))
    retry.onBusy?.({ attempt, error: error as SettlementCoordinationAcquireError, sleepMs })
    await sleep(sleepMs, request.signal)
    if (request.signal?.aborted) throw new SettlementCoordinationAbortedError()
  }
}
