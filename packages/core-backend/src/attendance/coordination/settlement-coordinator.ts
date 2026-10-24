/**
 * Attendance settlement coordination — the shared-side coordinator (§3.2 steps 0–3 and 6–9).
 *
 * The coordinator owns the connection: a coordination unit takes quota, borrows a connection, runs
 * S1 and the handover, and hands the caller (the S3 port) a connection whose transaction is already
 * open and protected. Per attempt the order is fixed:
 *
 *   wait out any contention on the families the unit needs (no quota, no connection while waiting)
 *   → org quota → global quota → borrow (raced against min(remaining budget, DB_CONNECT_TIMEOUT))
 *   → S1 → BEGIN + S2.
 *
 * A lost try gives the connection back and returns global then org quota *before* backing off; only
 * the prober backs off, everyone else waits for its results. An uncertain outcome destroys the
 * connection. A connect that loses its race keeps its quota on the abandoned tab until it settles:
 * a late client is released at once, then the quota returns. Leaving without success (budget, error,
 * abort) hands every probe the unit holds to the head of its queue.
 *
 * After every step that hands the attempt something (quota, a connection, S1's session locks, the
 * open transaction) the attempt checks that it may go on. A closed or aborted unit, or a budget that
 * step used up, undoes what the step left — the session locks are unlocked, the transaction is rolled
 * back, and anything uncertain destroys the connection — gives everything back and fails: nothing is
 * handed over once the budget is gone (§3.2 step 9 "零业务写入"). A unit runs one acquisition,
 * candidate read or restart at a time; closing it while one is in flight cancels that one, which
 * leaves the ledger itself once everything is back.
 *
 * Nothing here is wired into production in P1-1: there is no module-level instance, no timer and no
 * environment read; `createSettlementCoordinatorV1` builds everything from what it is given.
 */
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import { settlementCoordinationBackoffMsV1 } from './settlement-coordination-backoff'
import {
  SETTLEMENT_COORDINATION_EXHAUSTION_CODES,
  SettlementCoordinationBudgetV1,
  type SettlementCoordinationStageV1,
} from './settlement-coordination-budget'
import type { SettlementCoordinationCapacityV1 } from './settlement-coordination-capacity'
import { assertNoSettlementCoordinationContextV1 } from './settlement-coordination-context'
import {
  CoordinationWaitEndedError,
  createSystemCoordinationClockV1,
  type CoordinationClockV1,
  type CoordinationTimerV1,
} from './settlement-coordination-clock'
import {
  AttendanceCoordinationConnectionUncertainError,
  SettlementCoordinationCredentialV1,
  invalidateSettlementCoordinationCredentialsV1,
  planSettlementCoordinationV1,
  releaseSettlementCoordinationSessionLocksV1,
  rollbackSettlementCoordinationTransactionV1,
  runSettlementCoordinationHandoverV1,
  runSettlementCoordinationS1V1,
  type SettlementCoordinationCommitOutcomeV1,
  type SettlementCoordinationHandoverOptionsV1,
  type SettlementCoordinationPlanV1,
  type SettlementCoordinationUncertainReasonV1,
  type SettlementCoordinationTransactionClientV1,
} from './settlement-coordination-handover'
import { SettlementCoordinationLedgerV1 } from './settlement-coordination-ledger'
import {
  SettlementCoordinationProberRegistryV1,
  type SettlementCoordinationFamilyV1,
  type SettlementCoordinationProbeTicketV1,
} from './settlement-coordination-prober'
import {
  SettlementCoordinationQuotaV1,
  type SettlementCoordinationQuotaClassV1,
  type SettlementCoordinationQuotaLeaseV1,
} from './settlement-coordination-quota'

/**
 * A pooled connection: tagged queries, pg's `release(err?)` (a truthy `err` destroys it) and pg's
 * 'error' event. pg-pool takes its own idle listener off a client it hands out, so from the borrow to
 * the release the coordinator is the listener (S1 note 1): without one, a backend lost between two
 * statements would take the whole process down.
 */
export interface SettlementCoordinationClientV1 extends SettlementCoordinationTransactionClientV1 {
  release(error?: unknown): void
  on(event: 'error', listener: (error: unknown) => void): unknown
  removeListener(event: 'error', listener: (error: unknown) => void): unknown
}

export interface SettlementCoordinationPoolV1 {
  connect(): Promise<SettlementCoordinationClientV1>
}

export interface SettlementCoordinationAttemptEventV1 {
  readonly at: number
  readonly kind: string
  readonly detail?: Readonly<Record<string, unknown>>
}

/** §3.2 step 10: one record per attempt, with every try, the handover and every wait. */
export interface SettlementCoordinationAttemptRecordV1 {
  /** The entry label of the unit (appendix D registration). */
  readonly entryLabel: string
  readonly attempt: number
  readonly org: string | null
  readonly quotaClass: SettlementCoordinationQuotaClassV1
  readonly outcome: 'handed-over' | 'failed'
  readonly code: string | null
  readonly events: readonly SettlementCoordinationAttemptEventV1[]
  readonly waits: Readonly<Record<SettlementCoordinationStageV1, number>>
}

/** A connect that took at least the first backoff step waited; a new connection's handshake does not. */
export const SETTLEMENT_COORDINATION_LOGGED_CONNECT_WAIT_MS = 25

/**
 * §3.2 step 10: a record is worth a log line only when the attempt tried more than once or actually
 * waited — queued for quota (whether or not the permit came), waited for a connection (a lost race,
 * or at least `SETTLEMENT_COORDINATION_LOGGED_CONNECT_WAIT_MS` whatever the outcome), waited for a
 * prober or backed off. The budget still counts every millisecond; an immediate grant or a fast round
 * trip is not a wait here.
 */
export function shouldLogSettlementCoordinationAttemptV1(record: SettlementCoordinationAttemptRecordV1): boolean {
  let tries = 0
  for (const event of record.events) {
    if (event.kind === 's1') tries += 1
    else if (event.kind === 'prober-wait' || event.kind === 'backoff') return true
    else if (event.kind === 'quota' && event.detail?.queued === true) return true
    else if (event.kind === 'connect') {
      const kind = event.detail?.kind
      const waitedMs = event.detail?.waitedMs
      if (kind === 'timeout' || kind === 'aborted') return true
      if (typeof waitedMs === 'number' && waitedMs >= SETTLEMENT_COORDINATION_LOGGED_CONNECT_WAIT_MS) return true
    }
  }
  return tries > 1
}

/** Counters the coordinator keeps about itself (read by tests and, later, by metrics). */
export interface SettlementCoordinationStatsV1 {
  /** `onAttempt` observers that threw; an observer never changes an acquisition's outcome. */
  attemptObserverFailures: number
  /**
   * Recheck restarts that ran out on an entry with no registered conflict code and answered the
   * fallback code (S1 note 8: never silent). Alerting on it belongs to P1-7.
   */
  scopeChangedFallbacks: number
}

export interface SettlementCoordinatorDepsV1 {
  readonly pool: SettlementCoordinationPoolV1
  readonly quota: SettlementCoordinationQuotaV1
  readonly prober: SettlementCoordinationProberRegistryV1
  readonly ledger: SettlementCoordinationLedgerV1
  readonly clock: CoordinationClockV1
  readonly random: () => number
  /** `DB_CONNECT_TIMEOUT` of the pool. */
  readonly connectTimeoutMs: number
  readonly onAttempt?: (record: SettlementCoordinationAttemptRecordV1) => void
  readonly stats: SettlementCoordinationStatsV1
}

export interface SettlementCoordinationUnitRequestV1 {
  /**
   * Whether the entry depends on the class-00 family (W4 rollout lock) — a property of the entry, not
   * of the org. The planner decides per attempt from the org that attempt coordinates: a canonical org
   * takes class-00 when this is true, a legacy org never does (its key is not parsed). So one unit
   * stays correct when a recheck restart moves it from a canonical to a legacy org or back (Codex S3 §4 C).
   */
  readonly needsClassZero: boolean
  readonly quotaClass: SettlementCoordinationQuotaClassV1
  readonly handover: SettlementCoordinationHandoverOptionsV1
  /** Scheduled absence, sweep, import workers: quota waits capped at 30 s and outside the budget. */
  readonly background?: boolean
  /** Scanner, CLI and other callers that try exactly once: no contention state is made, read or ended. */
  readonly oneShot?: boolean
  readonly signal?: AbortSignal
  readonly budgetMs?: number
}

/** Acquisition failed with a registered busy / unavailable code; nothing was written. */
export class SettlementCoordinationAcquireError extends Error {
  readonly code: string
  readonly waits: Readonly<Record<SettlementCoordinationStageV1, number>>

  constructor(code: string, waits: Readonly<Record<SettlementCoordinationStageV1, number>>, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'SettlementCoordinationAcquireError'
    this.code = code
    this.waits = waits
  }
}

/** The request was aborted, or the unit closed, before anything was handed over; nothing was written. */
export class SettlementCoordinationAbortedError extends Error {
  readonly code = 'ATTENDANCE_COORDINATION_ABORTED'

  constructor() {
    super('ATTENDANCE_COORDINATION_ABORTED')
    this.name = 'SettlementCoordinationAbortedError'
  }
}

/**
 * The post-lock recheck kept disagreeing with the candidate (§3.2 step 6.5): the entry's registered
 * conflict code (M07: `CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED`; fallback below).
 */
export class SettlementCoordinationScopeChangedError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'SettlementCoordinationScopeChangedError'
    this.code = code
  }
}

/**
 * A restart whose claim about the transaction does not hold: the connection has been destroyed (which
 * ends whatever was open on it) and nothing is counted. `transaction-still-open`: called `ended` while
 * no COMMIT or ROLLBACK went through the primitives. `commit-not-retryable`: the COMMIT that ended it
 * was not a 40001 / 40P01 (an uncertain COMMIT is never followed by another business attempt).
 */
export class SettlementCoordinationRestartRefusedError extends Error {
  readonly code = 'ATTENDANCE_COORDINATION_RESTART_REFUSED'
  readonly reason: 'transaction-still-open' | 'commit-not-retryable'

  constructor(reason: 'transaction-still-open' | 'commit-not-retryable') {
    super(`ATTENDANCE_COORDINATION_RESTART_REFUSED:${reason}`)
    this.name = 'SettlementCoordinationRestartRefusedError'
    this.reason = reason
  }
}

export const SETTLEMENT_COORDINATION_SCOPE_CHANGED = 'ATTENDANCE_COORDINATION_SCOPE_CHANGED'
/** `W4_TRANSACTION_MAX_RETRIES`: each inner counter allows two restarts. */
export const SETTLEMENT_COORDINATION_INNER_RESTART_LIMIT = 2

export type SettlementCoordinationRestartV1 =
  /**
   * `live`: the handed-over transaction is still open (its credential is live) and is rolled back.
   * `serialization`: 40001 / 40P01 inside the transaction; `recheck`: the post-lock recheck disagreed
   * with the candidate. `error` is rethrown unchanged when the serialization counter is used up;
   * `conflictCode` is the entry's registered code for a used-up recheck counter.
   */
  | Readonly<{ reason: 'serialization' | 'recheck'; transaction: 'live'; error: unknown; conflictCode?: string }>
  /**
   * `ended`: the transaction already ended at COMMIT with 40001 / 40P01 — the server rolled it back, so
   * no ROLLBACK is sent. `commit` is the outcome the commit primitive returned; only `retryable` is
   * accepted, and its error is the one rethrown when the counter is used up.
   */
  | Readonly<{ reason: 'serialization'; transaction: 'ended'; commit: SettlementCoordinationCommitOutcomeV1 }>

export const SETTLEMENT_COORDINATION_CONNECTION_UNAVAILABLE = 'ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE'
export const SETTLEMENT_COORDINATION_CAPACITY_BUSY = 'ATTENDANCE_COORDINATION_CAPACITY_BUSY'

/** The resources of one handed-over attempt. */
export interface SettlementCoordinationHandleV1 {
  readonly client: SettlementCoordinationClientV1
  readonly credential: SettlementCoordinationCredentialV1
  readonly plan: SettlementCoordinationPlanV1
  readonly attempt: number
  /**
   * Ends the attempt: the connection goes back to the pool (destroyed when `error` is given, or when
   * the connection reported an error while held), then the global quota, then the org quota. Exactly once.
   */
  end(error?: unknown): void
  /** The first error the connection reported (pg's 'error' event) while this unit held it, or undefined. */
  connectionError(): unknown
}

/** One borrowed connection's error watch: the listener this unit installed and what it heard. */
interface ConnectionWatch {
  readonly listener: (error: unknown) => void
  error: unknown
}

interface ActiveAttempt {
  readonly client: SettlementCoordinationClientV1
  readonly lease: SettlementCoordinationQuotaLeaseV1
  readonly plan: SettlementCoordinationPlanV1
  readonly credential: SettlementCoordinationCredentialV1
  ended: boolean
}

class AttemptRecorder {
  readonly events: SettlementCoordinationAttemptEventV1[] = []

  constructor(
    private readonly clock: CoordinationClockV1,
    readonly attempt: number,
    readonly quotaClass: SettlementCoordinationQuotaClassV1,
    public org: string | null,
  ) {}

  event(kind: string, detail?: Record<string, unknown>): void {
    this.events.push(Object.freeze({ at: this.clock.now(), kind, ...(detail ? { detail: Object.freeze({ ...detail }) } : {}) }))
  }
}

export class SettlementCoordinationUnitV1 {
  readonly #deps: SettlementCoordinatorDepsV1
  readonly #request: SettlementCoordinationUnitRequestV1
  readonly #id = Symbol('settlement-coordination-unit')
  readonly budget: SettlementCoordinationBudgetV1
  readonly #tickets = new Map<SettlementCoordinationFamilyV1, SettlementCoordinationProbeTicketV1>()
  /** Aborted by the request's signal or by `close()`; every wait of the unit listens to it. */
  readonly #abort = new AbortController()
  readonly #forwardAbort = (): void => this.#abort.abort()
  #attempt = 0
  #retry = 0
  #active: ActiveAttempt | null = null
  #activeHandle: SettlementCoordinationHandleV1 | null = null
  /** An acquisition, candidate read or restart is in flight (set before its first await). */
  #busy = false
  #closed = false
  #left = false
  #serializationRestarts = 0
  #recheckRestarts = 0
  /** Connections this unit holds, each with the 'error' listener installed at the borrow. */
  readonly #watched = new Map<SettlementCoordinationClientV1, ConnectionWatch>()
  /** Acquisition refusals raised by this unit itself (see `refused`). */
  readonly #refusals = new WeakSet<object>()

  constructor(deps: SettlementCoordinatorDepsV1, request: SettlementCoordinationUnitRequestV1) {
    this.#deps = deps
    this.#request = request
    this.budget = new SettlementCoordinationBudgetV1({ clock: deps.clock, limitMs: request.budgetMs, background: request.background })
    deps.ledger.enter(this.#id, request.quotaClass)
    if (request.signal?.aborted) this.#abort.abort()
    else request.signal?.addEventListener('abort', this.#forwardAbort, { once: true })
  }

  /** Whether the unit currently holds a handed-over attempt. */
  get active(): boolean {
    return this.#active !== null
  }

  /**
   * Whether `error` is an acquisition refusal this unit raised itself (a candidate read or an
   * acquisition that wrote nothing), as opposed to the same error class arriving from anywhere else —
   * a body, a post-commit callback or another unit. Outer retries decide on this, never on the class.
   */
  refused(error: unknown): boolean {
    return typeof error === 'object' && error !== null && this.#refusals.has(error)
  }

  /**
   * §3.2 step 0, for entries without a pre-read: one short borrow outside quota, raced and counted
   * like any borrow; `read` runs its (at most two) autocommit reads and the connection goes back.
   */
  async readCandidate<T>(read: (client: AttendanceW4TransactionClientV1) => Promise<T>): Promise<T> {
    assertNoSettlementCoordinationContextV1('quota')
    this.#assertIdle()
    this.#busy = true
    try {
      this.#throwIfStopped()
      let client: SettlementCoordinationClientV1
      try {
        client = await this.#borrow(null, null)
      } catch (error) {
        if (error instanceof SettlementCoordinationAcquireError) this.#refusals.add(error)
        throw error
      }
      const started = this.#deps.clock.now()
      let destroyWith: unknown
      let candidate: T
      try {
        candidate = await read(client)
      } catch (error) {
        destroyWith = error instanceof Error ? error : new Error('candidate read failed')
        throw error
      } finally {
        this.budget.record('connect', this.#deps.clock.now() - started)
        invalidateSettlementCoordinationCredentialsV1(client)
        this.#release(client, destroyWith)
        this.#deps.ledger.dropClient(this.#id)
      }
      // Closed or aborted while the read ran: the caller is gone, so no candidate is handed out.
      if (this.#cancelled()) throw new SettlementCoordinationAbortedError()
      return candidate
    } finally {
      this.#busy = false
      if (this.#closed) this.#leave()
    }
  }

  async acquire(org: unknown): Promise<SettlementCoordinationHandleV1> {
    // No quota of any kind inside a coordinated transaction (§3.2 step 1 "禁止嵌套"), in production as in tests.
    assertNoSettlementCoordinationContextV1('quota')
    this.#assertIdle()
    this.#busy = true
    let record: AttemptRecorder | null = null
    try {
      const plan = planSettlementCoordinationV1(org, { needsClassZero: this.#request.needsClassZero })
      const lexical = plan.key.org.lexical
      const families: SettlementCoordinationFamilyV1[] = plan.classZeroKey === null ? ['dedicated'] : ['dedicated', 'class-00']
      this.#attempt += 1
      record = new AttemptRecorder(this.#deps.clock, this.#attempt, this.#request.quotaClass, lexical)
      for (;;) {
        this.#throwIfStopped()
        if (!this.#request.oneShot && (await this.#waitForContention(lexical, families, record))) continue

        const lease = await this.#takeQuota(lexical, record)
        // The lease is this attempt's to give back until `#borrow` takes it over.
        const stopBeforeBorrow = this.#stopReason()
        if (stopBeforeBorrow) {
          this.#returnLease(lease)
          record.event('released')
          throw stopBeforeBorrow
        }
        const client = await this.#borrow(lease, record)
        // From here until the resources are given back, destroyed or handed over, this attempt owns
        // them; anything unexpected destroys the connection and returns the quota.
        let owned = true
        try {
          const stopBeforeTry = this.#stopReason()
          if (stopBeforeTry) {
            owned = false
            this.#giveBack(client, lease, record)
            throw stopBeforeTry
          }
          const tryStarted = this.#deps.clock.now()
          const s1 = await runSettlementCoordinationS1V1(client, plan)
          record.event('s1', { kind: s1.kind, ...(s1.kind === 'contended' ? { family: s1.family } : {}), ...(s1.kind === 'uncertain' ? { reason: s1.reason } : {}) })
          this.budget.record(s1.kind === 'contended' ? s1.family : 'dedicated', this.#deps.clock.now() - tryStarted)

          if (s1.kind === 'uncertain') {
            owned = false
            this.#destroy(client, lease, s1.reason, record)
            for (const ticket of this.#tickets.values()) this.#deps.prober.reportUndetermined(ticket)
            throw new AttendanceCoordinationConnectionUncertainError(s1.reason)
          }

          if (s1.kind === 'acquired') {
            if (!this.#request.oneShot) for (const family of families) this.#deps.prober.reportFree(lexical, family)
            this.#tickets.clear()
            const stopAfterTry = this.#stopReason()
            if (stopAfterTry) {
              owned = false
              await this.#unlockAndGiveBack(client, lease, plan, record)
              throw stopAfterTry
            }
            const handoverStarted = this.#deps.clock.now()
            let handoverDecidedAt: number | null = null
            const handover = await runSettlementCoordinationHandoverV1(client, plan, this.#request.handover, {
              decided: () => {
                handoverDecidedAt = this.#deps.clock.now()
              },
            })
            record.event('handover', { kind: handover.kind, ...(handover.kind === 'uncertain' ? { reason: handover.reason } : {}) })
            // S2's transaction-level re-grant is part of the try (§3.2 step 6.4); the ROLLBACK a failed
            // handover runs before it returns is cleanup and is not.
            this.budget.record('dedicated', (handoverDecidedAt ?? this.#deps.clock.now()) - handoverStarted)
            if (handover.kind === 'uncertain') {
              owned = false
              this.#destroy(client, lease, handover.reason, record)
              throw new AttendanceCoordinationConnectionUncertainError(handover.reason)
            }
            const stopAfterHandover = this.#stopReason()
            if (stopAfterHandover) {
              owned = false
              await this.#rollbackAndGiveBack(client, lease, handover.credential, record)
              throw stopAfterHandover
            }
            owned = false
            const active: ActiveAttempt = { client, lease, plan, credential: handover.credential, ended: false }
            this.#active = active
            this.#activeHandle = this.#handle(active, this.#attempt)
            this.#busy = false
            this.#emit(record, 'handed-over', null)
            return this.#activeHandle
          }

          // Contended: give everything back before anyone backs off.
          const family = s1.family
          owned = false
          this.#giveBack(client, lease, record)
          if (this.#request.oneShot) throw new SettlementCoordinationAcquireError(SETTLEMENT_COORDINATION_EXHAUSTION_CODES[family], this.budget.waits())
          if (family === 'class-00') {
            // k_ok was true: the dedicated family's contention is over even though class-00 lost.
            this.#deps.prober.reportFree(lexical, 'dedicated')
            this.#tickets.delete('dedicated')
          }
          const role = this.#deps.prober.reportFailure(lexical, family, this.#id, this.#tickets.get(family))
          if (role.role === 'prober') {
            this.#tickets.set(family, role.ticket)
            this.#retry += 1
            const delay = settlementCoordinationBackoffMsV1(this.#retry, this.#deps.random, this.budget.remaining())
            record.event('backoff', { family, ms: delay })
            const slept = this.#deps.clock.now()
            try {
              await this.#deps.clock.sleep(delay, this.#abort.signal)
            } finally {
              this.budget.record(family, this.#deps.clock.now() - slept)
            }
          } else {
            this.#tickets.delete(family)
          }
        } finally {
          if (owned) {
            invalidateSettlementCoordinationCredentialsV1(client)
            this.#release(client, new Error('settlement coordination attempt failed unexpectedly'))
            this.#deps.ledger.dropClient(this.#id)
            this.#returnLease(lease)
            record.event('destroyed', { reason: 'unexpected' })
          }
        }
      }
    } catch (error) {
      this.#busy = false
      this.#handOverProbes()
      const mapped = this.#mapError(error)
      if (mapped instanceof SettlementCoordinationAcquireError) this.#refusals.add(mapped)
      if (record) this.#emit(record, 'failed', (mapped as { code?: unknown }).code as string | undefined ?? null)
      if (this.#closed) this.#leave()
      throw mapped
    }
  }

  /** Inner restart counters (40001 / 40P01; recheck mismatch); each outer attempt starts them at zero. */
  get innerRestarts(): Readonly<{ serialization: number; recheck: number }> {
    return { serialization: this.#serializationRestarts, recheck: this.#recheckRestarts }
  }

  /** An outer retry (§3.2 step 8(c)) is a new acquisition of the same unit: both inner counters restart. */
  beginOuterAttempt(): void {
    this.#assertIdle()
    this.#serializationRestarts = 0
    this.#recheckRestarts = 0
  }

  /**
   * Coordination restart (§3.2 step 8): ends the transaction of `handle` as `input.transaction`
   * says, gives the connection back (destroyed when ROLLBACK failed), returns global then org quota,
   * and counts the restart. Only the budget and the two inner counters survive into the next
   * acquisition. When a counter goes past its limit the restart still converts the resources first,
   * then a serialization restart rethrows the original error unchanged and a recheck restart throws
   * the registered conflict code. A claim that does not hold (a live transaction called `ended`, an
   * `ended` one without a retryable COMMIT, an ended one called `live`) destroys the connection and
   * is refused without counting.
   */
  async restart(handle: SettlementCoordinationHandleV1, input: SettlementCoordinationRestartV1): Promise<void> {
    const active = this.#active
    if (this.#activeHandle !== handle || !active) throw new Error('settlement coordination restart for an attempt this unit does not hold')
    if (this.#busy) throw new Error('settlement coordination unit is already busy (overlapping restart)')
    this.#busy = true
    try {
      let destroyWith: unknown
      let refused: unknown
      if (input.transaction === 'live') {
        try {
          const rolled = await rollbackSettlementCoordinationTransactionV1(active.client, active.credential)
          if (rolled.kind === 'uncertain') destroyWith = new AttendanceCoordinationConnectionUncertainError(rolled.reason)
        } catch (error) {
          // The credential did not match: the transaction state is unknown, so the connection goes.
          refused = error
          destroyWith = error
        }
      } else if (SettlementCoordinationCredentialV1.isLiveOn(active.credential, active.client)) {
        // No COMMIT or ROLLBACK went through the primitives, so the transaction is still open: only
        // destroying the connection is sure to end it.
        refused = new SettlementCoordinationRestartRefusedError('transaction-still-open')
        destroyWith = refused
      } else if (input.commit?.kind !== 'retryable') {
        refused = new SettlementCoordinationRestartRefusedError('commit-not-retryable')
        destroyWith = refused
      }
      this.#endAttempt(active, destroyWith)
      if (refused !== undefined) throw refused
      if (input.reason === 'serialization') {
        this.#serializationRestarts += 1
        if (this.#serializationRestarts > SETTLEMENT_COORDINATION_INNER_RESTART_LIMIT) {
          throw input.transaction === 'live' ? input.error : (input.commit as { error: unknown }).error
        }
      } else {
        this.#recheckRestarts += 1
        if (this.#recheckRestarts > SETTLEMENT_COORDINATION_INNER_RESTART_LIMIT) {
          if (input.conflictCode === undefined) this.#deps.stats.scopeChangedFallbacks += 1
          throw new SettlementCoordinationScopeChangedError(input.conflictCode ?? SETTLEMENT_COORDINATION_SCOPE_CHANGED)
        }
      }
    } finally {
      this.#busy = false
      if (this.#closed) this.#leave()
    }
  }

  /**
   * Leaves the coordinator. Closing while an acquisition or a candidate read is in flight cancels it:
   * its waits end, it gives back whatever it holds, fails with `ATTENDANCE_COORDINATION_ABORTED` and
   * leaves the ledger once it settles. A restart in flight finishes converting its resources and
   * returns as usual before the unit leaves. Closing while the unit holds a handed-over attempt is a
   * programming error: the attempt is destroyed and close throws.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#abort.abort()
    if (this.#busy) return
    const active = this.#active
    if (active) {
      this.#endAttempt(active, new Error('settlement coordination unit closed while holding an attempt'))
      this.#leave()
      throw new Error('settlement coordination unit closed while holding an attempt')
    }
    this.#leave()
  }

  #leave(): void {
    if (this.#left) return
    this.#left = true
    this.#handOverProbes()
    this.#request.signal?.removeEventListener('abort', this.#forwardAbort)
    this.#deps.ledger.exit(this.#id)
  }

  #assertIdle(): void {
    if (this.#closed) throw new Error('settlement coordination unit is closed')
    if (this.#busy) throw new Error('settlement coordination unit is already busy (overlapping acquisition)')
    if (this.#active) throw new Error('settlement coordination unit already holds an attempt (overlapping acquisition)')
  }

  #cancelled(): boolean {
    return this.#closed || this.#abort.signal.aborted
  }

  /** Why the attempt may not go on (closed or aborted first, then a spent budget), or null. */
  #stopReason(): Error | null {
    if (this.#cancelled()) return new SettlementCoordinationAbortedError()
    if (this.budget.exhausted()) return this.#exhausted()
    return null
  }

  #throwIfStopped(): void {
    const stop = this.#stopReason()
    if (stop) throw stop
  }

  #exhausted(): SettlementCoordinationAcquireError {
    return new SettlementCoordinationAcquireError(this.budget.exhaustionCode(), this.budget.waits())
  }

  #mapError(error: unknown): unknown {
    if (error instanceof CoordinationWaitEndedError) {
      return error.reason === 'aborted' ? new SettlementCoordinationAbortedError() : this.#exhausted()
    }
    return error
  }

  /** Returns true after waiting (the caller re-checks every family from the top). */
  async #waitForContention(org: string, families: readonly SettlementCoordinationFamilyV1[], record: AttemptRecorder): Promise<boolean> {
    for (const family of families) {
      if (!this.#deps.prober.mustWait(org, family, this.#id)) continue
      // The dedicated prober keeps probing even while class-00 is contended by someone else, so the
      // units that need only the dedicated family are not held up behind class-00.
      const dedicated = this.#tickets.get('dedicated')
      if (family === 'class-00' && dedicated && this.#deps.prober.isCurrent(dedicated)) continue
      const started = this.#deps.clock.now()
      record.event('prober-wait', { family })
      let result
      try {
        result = await this.#deps.prober.wait(org, family, this.#id, { deadline: this.budget.deadline(), signal: this.#abort.signal })
      } finally {
        this.budget.record(family, this.#deps.clock.now() - started)
      }
      record.event('prober-result', { family, kind: result.kind })
      if (result.kind === 'prober') this.#tickets.set(family, result.ticket)
      return true
    }
    return false
  }

  async #takeQuota(org: string, record: AttemptRecorder): Promise<SettlementCoordinationQuotaLeaseV1> {
    const started = this.#deps.clock.now()
    let lease: SettlementCoordinationQuotaLeaseV1
    try {
      lease = await this.#deps.quota.acquire(org, this.#request.quotaClass, {
        clock: this.#deps.clock,
        deadline: this.budget.quotaDeadline(),
        signal: this.#abort.signal,
      })
    } catch (error) {
      this.budget.record('quota', this.#deps.clock.now() - started)
      const ended = error instanceof CoordinationWaitEndedError ? error : null
      record.event('quota', { waitedMs: this.#deps.clock.now() - started, queued: ended?.queued === true, ended: ended?.reason ?? 'error' })
      if (error instanceof CoordinationWaitEndedError && error.reason === 'deadline') {
        throw this.#request.background
          ? new SettlementCoordinationAcquireError(SETTLEMENT_COORDINATION_CAPACITY_BUSY, this.budget.waits())
          : this.#exhausted()
      }
      throw error
    }
    this.budget.record('quota', this.#deps.clock.now() - started)
    try {
      this.#deps.ledger.takeLease(this.#id)
    } catch (error) {
      lease.release()
      throw error
    }
    record.event('quota', { waitedMs: this.#deps.clock.now() - started, queued: lease.queued })
    return lease
  }

  /**
   * Borrows a connection, raced against min(remaining budget, DB_CONNECT_TIMEOUT). Whatever happens,
   * `lease` is taken care of when this throws: returned at once on a connect error, kept on the
   * abandoned tab after a lost race until the connect settles (a late client is released, then the
   * lease).
   */
  async #borrow(lease: SettlementCoordinationQuotaLeaseV1 | null, record: AttemptRecorder | null): Promise<SettlementCoordinationClientV1> {
    const clock = this.#deps.clock
    const signal = this.#abort.signal
    const started = clock.now()
    const raceMs = Math.max(0, Math.min(this.budget.remaining(), this.#deps.connectTimeoutMs))
    const connecting = this.#deps.pool.connect()
    type Outcome = { kind: 'client'; client: SettlementCoordinationClientV1 } | { kind: 'error'; error: unknown } | { kind: 'timeout' } | { kind: 'aborted' }
    const outcome = await new Promise<Outcome>((resolve) => {
      let settled = false
      let timer: CoordinationTimerV1 | null = null
      const onAbort = (): void => {
        finish({ kind: 'aborted' })
      }
      const finish = (value: Outcome): boolean => {
        if (settled) return false
        settled = true
        timer?.cancel()
        signal.removeEventListener('abort', onAbort)
        resolve(value)
        return true
      }
      if (signal.aborted) {
        finish({ kind: 'aborted' })
      } else {
        timer = clock.setTimer(raceMs, () => finish({ kind: 'timeout' }))
        signal.addEventListener('abort', onAbort, { once: true })
      }
      connecting.then(
        (client) => void finish({ kind: 'client', client }),
        (error) => void finish({ kind: 'error', error }),
      )
    })
    this.budget.record('connect', clock.now() - started)
    record?.event('connect', { kind: outcome.kind, waitedMs: clock.now() - started })
    if (outcome.kind === 'client') {
      try {
        this.#deps.ledger.takeClient(this.#id)
      } catch (error) {
        outcome.client.release(error instanceof Error ? error : new Error('settlement coordination ledger refused the connection'))
        if (lease) this.#returnLease(lease)
        throw error
      }
      this.#watch(outcome.client)
      return outcome.client
    }
    if (outcome.kind === 'error') {
      if (lease) this.#returnLease(lease)
      throw new SettlementCoordinationAcquireError(SETTLEMENT_COORDINATION_CONNECTION_UNAVAILABLE, this.budget.waits(), outcome.error)
    }
    // Lost the race: the connect may still settle, and its quota stays out until it does. The handler
    // is in place before any bookkeeping below, so nothing can strand the late client.
    const settle = lease ? this.#deps.ledger.abandonConnect(this.#request.quotaClass) : () => undefined
    connecting.then(
      (late) => {
        try {
          late.release()
        } finally {
          lease?.release()
          settle()
        }
      },
      () => {
        lease?.release()
        settle()
      },
    )
    if (lease) this.#deps.ledger.dropLease(this.#id)
    if (outcome.kind === 'aborted') throw new SettlementCoordinationAbortedError()
    throw new SettlementCoordinationAcquireError(SETTLEMENT_COORDINATION_CONNECTION_UNAVAILABLE, this.budget.waits())
  }

  #returnLease(lease: SettlementCoordinationQuotaLeaseV1): void {
    lease.release()
    this.#deps.ledger.dropLease(this.#id)
  }

  /**
   * Installs this unit's 'error' listener on a connection it now holds. The listener only records the
   * first error; nothing is sent on the connection from it. What it heard makes every later end of the
   * connection a destroy, and the port refuses to COMMIT on it.
   */
  #watch(client: SettlementCoordinationClientV1): void {
    const watch: ConnectionWatch = {
      listener: (error: unknown) => {
        if (watch.error === undefined) watch.error = error ?? new Error('settlement coordination connection reported an error')
      },
      error: undefined,
    }
    this.#watched.set(client, watch)
    client.on('error', watch.listener)
  }

  /**
   * The one way this unit gives a held connection back: its listener comes off first (so it never
   * outlives the borrow or reaches the next borrower; other listeners are left alone), then pg's
   * `release`, destroying when asked to or when the connection reported an error while held.
   */
  #release(client: SettlementCoordinationClientV1, error?: unknown): void {
    const watch = this.#watched.get(client)
    if (watch) {
      this.#watched.delete(client)
      client.removeListener('error', watch.listener)
    }
    const heard = watch?.error
    const destroyWith = error ?? (heard === undefined ? undefined : heard instanceof Error ? heard : new AttendanceCoordinationConnectionUncertainError('connection-error'))
    client.release(destroyWith)
  }

  /** A clean connection (nothing held on its session) goes back; then global, then org. */
  #giveBack(client: SettlementCoordinationClientV1, lease: SettlementCoordinationQuotaLeaseV1, record: AttemptRecorder): void {
    invalidateSettlementCoordinationCredentialsV1(client)
    this.#release(client)
    this.#deps.ledger.dropClient(this.#id)
    this.#returnLease(lease)
    record.event('released')
  }

  /** S1 took the session locks but the attempt may not go on: unlock exactly those, then give back. */
  async #unlockAndGiveBack(
    client: SettlementCoordinationClientV1,
    lease: SettlementCoordinationQuotaLeaseV1,
    plan: SettlementCoordinationPlanV1,
    record: AttemptRecorder,
  ): Promise<void> {
    const unlocked = await releaseSettlementCoordinationSessionLocksV1(client, plan)
    if (unlocked.kind === 'uncertain') {
      this.#destroy(client, lease, unlocked.reason, record)
      return
    }
    record.event('unlocked')
    this.#giveBack(client, lease, record)
  }

  /** The transaction is open on the connection but the attempt may not go on: roll it back, then give back. */
  async #rollbackAndGiveBack(
    client: SettlementCoordinationClientV1,
    lease: SettlementCoordinationQuotaLeaseV1,
    credential: SettlementCoordinationCredentialV1,
    record: AttemptRecorder,
  ): Promise<void> {
    const rolled = await rollbackSettlementCoordinationTransactionV1(client, credential)
    if (rolled.kind === 'uncertain') {
      this.#destroy(client, lease, rolled.reason, record)
      return
    }
    record.event('rolled-back')
    this.#giveBack(client, lease, record)
  }

  #destroy(
    client: SettlementCoordinationClientV1,
    lease: SettlementCoordinationQuotaLeaseV1,
    reason: SettlementCoordinationUncertainReasonV1,
    record: AttemptRecorder,
  ): void {
    invalidateSettlementCoordinationCredentialsV1(client)
    this.#release(client, new AttendanceCoordinationConnectionUncertainError(reason))
    this.#deps.ledger.dropClient(this.#id)
    this.#returnLease(lease)
    record.event('destroyed', { reason })
  }

  #handOverProbes(): void {
    for (const ticket of this.#tickets.values()) this.#deps.prober.handOver(ticket)
    this.#tickets.clear()
  }

  /** Ends a handed-over attempt exactly once: connection (destroyed when `error` is given), then global, then org quota. */
  #endAttempt(active: ActiveAttempt, error?: unknown): void {
    if (active.ended) throw new Error('settlement coordination attempt ended twice')
    active.ended = true
    if (this.#active === active) {
      this.#active = null
      this.#activeHandle = null
    }
    invalidateSettlementCoordinationCredentialsV1(active.client)
    this.#release(active.client, error)
    this.#deps.ledger.dropClient(this.#id)
    active.lease.release()
    this.#deps.ledger.dropLease(this.#id)
  }

  #handle(active: ActiveAttempt, attempt: number): SettlementCoordinationHandleV1 {
    return Object.freeze({
      client: active.client,
      credential: active.credential,
      plan: active.plan,
      attempt,
      end: (error?: unknown) => this.#endAttempt(active, error),
      connectionError: () => this.#watched.get(active.client)?.error,
    })
  }

  /** Hands the record to the observer. An observer that throws is counted and otherwise ignored. */
  #emit(record: AttemptRecorder, outcome: 'handed-over' | 'failed', code: string | null): void {
    const observer = this.#deps.onAttempt
    if (!observer) return
    try {
      observer(
        Object.freeze({
          entryLabel: this.#request.handover.entryLabel,
          attempt: record.attempt,
          org: record.org,
          quotaClass: record.quotaClass,
          outcome,
          code,
          events: Object.freeze([...record.events]),
          waits: this.budget.waits(),
        }),
      )
    } catch {
      this.#deps.stats.attemptObserverFailures += 1
    }
  }
}

export class SettlementCoordinatorV1 {
  readonly deps: SettlementCoordinatorDepsV1

  constructor(deps: SettlementCoordinatorDepsV1) {
    this.deps = deps
  }

  openUnit(request: SettlementCoordinationUnitRequestV1): SettlementCoordinationUnitV1 {
    assertNoSettlementCoordinationContextV1('quota')
    return new SettlementCoordinationUnitV1(this.deps, request)
  }
}

/** Builds a coordinator and its state from what it is given; nothing is shared between calls. */
export function createSettlementCoordinatorV1(input: {
  readonly pool: SettlementCoordinationPoolV1
  readonly capacity: SettlementCoordinationCapacityV1
  readonly connectTimeoutMs: number
  readonly clock?: CoordinationClockV1
  readonly random?: () => number
  readonly takeoverMs?: number
  readonly onAttempt?: (record: SettlementCoordinationAttemptRecordV1) => void
}): SettlementCoordinatorV1 {
  const clock = input.clock ?? createSystemCoordinationClockV1()
  return new SettlementCoordinatorV1({
    pool: input.pool,
    quota: new SettlementCoordinationQuotaV1(input.capacity),
    prober: new SettlementCoordinationProberRegistryV1({ clock, takeoverMs: input.takeoverMs }),
    ledger: new SettlementCoordinationLedgerV1(),
    clock,
    random: input.random ?? Math.random,
    connectTimeoutMs: input.connectTimeoutMs,
    onAttempt: input.onAttempt,
    stats: { attemptObserverFailures: 0, scopeChangedFallbacks: 0 },
  })
}
