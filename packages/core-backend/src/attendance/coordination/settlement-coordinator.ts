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
import {
  CoordinationWaitEndedError,
  createSystemCoordinationClockV1,
  type CoordinationClockV1,
  type CoordinationTimerV1,
} from './settlement-coordination-clock'
import {
  AttendanceCoordinationConnectionUncertainError,
  invalidateSettlementCoordinationCredentialsV1,
  planSettlementCoordinationV1,
  runSettlementCoordinationHandoverV1,
  runSettlementCoordinationS1V1,
  type SettlementCoordinationCredentialV1,
  type SettlementCoordinationHandoverOptionsV1,
  type SettlementCoordinationPlanV1,
  type SettlementCoordinationUncertainReasonV1,
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

/** A pooled connection: queries plus pg's `release(err?)` (a truthy `err` destroys it). */
export interface SettlementCoordinationClientV1 extends AttendanceW4TransactionClientV1 {
  release(error?: unknown): void
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
  readonly attempt: number
  readonly org: string | null
  readonly quotaClass: SettlementCoordinationQuotaClassV1
  readonly outcome: 'handed-over' | 'failed'
  readonly code: string | null
  readonly events: readonly SettlementCoordinationAttemptEventV1[]
  readonly waits: Readonly<Record<SettlementCoordinationStageV1, number>>
}

/** A record is worth a log line only when the attempt tried more than once or waited at all. */
export function shouldLogSettlementCoordinationAttemptV1(record: SettlementCoordinationAttemptRecordV1): boolean {
  const tries = record.events.filter((event) => event.kind === 's1').length
  return tries > 1 || Object.values(record.waits).some((ms) => ms > 0)
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
}

export interface SettlementCoordinationUnitRequestV1 {
  readonly needsClassZero: boolean
  readonly quotaClass: SettlementCoordinationQuotaClassV1
  readonly handover: SettlementCoordinationHandoverOptionsV1
  /** Scheduled absence, sweep, import workers: quota waits capped at 30 s and outside the budget. */
  readonly background?: boolean
  /** Scanner, CLI and other callers that try exactly once: no contention state is made or read. */
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

/** The request was aborted while the unit waited; nothing was written. */
export class SettlementCoordinationAbortedError extends Error {
  readonly code = 'ATTENDANCE_COORDINATION_ABORTED'

  constructor() {
    super('ATTENDANCE_COORDINATION_ABORTED')
    this.name = 'SettlementCoordinationAbortedError'
  }
}

export const SETTLEMENT_COORDINATION_CONNECTION_UNAVAILABLE = 'ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE'
export const SETTLEMENT_COORDINATION_CAPACITY_BUSY = 'ATTENDANCE_COORDINATION_CAPACITY_BUSY'

/** The resources of one handed-over attempt. */
export interface SettlementCoordinationHandleV1 {
  readonly client: SettlementCoordinationClientV1
  readonly credential: SettlementCoordinationCredentialV1
  readonly plan: SettlementCoordinationPlanV1
  readonly attempt: number
  /**
   * Ends the attempt: the connection goes back to the pool (destroyed when `error` is given), then
   * the global quota, then the org quota. Exactly once.
   */
  end(error?: unknown): void
}

interface ActiveAttempt {
  readonly client: SettlementCoordinationClientV1
  readonly lease: SettlementCoordinationQuotaLeaseV1
  readonly plan: SettlementCoordinationPlanV1
  readonly credential: SettlementCoordinationCredentialV1
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
  #attempt = 0
  #retry = 0
  #active: ActiveAttempt | null = null
  #closed = false

  constructor(deps: SettlementCoordinatorDepsV1, request: SettlementCoordinationUnitRequestV1) {
    this.#deps = deps
    this.#request = request
    this.budget = new SettlementCoordinationBudgetV1({ clock: deps.clock, limitMs: request.budgetMs, background: request.background })
    deps.ledger.enter(this.#id, request.quotaClass)
  }

  /** Whether the unit currently holds a handed-over attempt. */
  get active(): boolean {
    return this.#active !== null
  }

  /**
   * §3.2 step 0, for entries without a pre-read: one short borrow outside quota, raced and counted
   * like any borrow; `read` runs its (at most two) autocommit reads and the connection goes back.
   */
  async readCandidate<T>(read: (client: AttendanceW4TransactionClientV1) => Promise<T>): Promise<T> {
    this.#assertIdle()
    const client = await this.#borrow(null, null)
    const started = this.#deps.clock.now()
    let destroyWith: unknown
    try {
      return await read(client)
    } catch (error) {
      destroyWith = error instanceof Error ? error : new Error('candidate read failed')
      throw error
    } finally {
      this.budget.record('connect', this.#deps.clock.now() - started)
      client.release(destroyWith)
      this.#deps.ledger.dropClient(this.#id)
    }
  }

  async acquire(org: unknown): Promise<SettlementCoordinationHandleV1> {
    this.#assertIdle()
    const plan = planSettlementCoordinationV1(org, { needsClassZero: this.#request.needsClassZero })
    const lexical = plan.key.org.lexical
    const families: SettlementCoordinationFamilyV1[] = plan.classZeroKey === null ? ['dedicated'] : ['dedicated', 'class-00']
    this.#attempt += 1
    const record = new AttemptRecorder(this.#deps.clock, this.#attempt, this.#request.quotaClass, lexical)
    try {
      for (;;) {
        this.#throwIfAborted()
        if (this.budget.exhausted()) throw this.#exhausted()
        if (!this.#request.oneShot && (await this.#waitForContention(lexical, families, record))) continue

        const lease = await this.#takeQuota(lexical, record)
        const client = await this.#borrow(lease, record)
        // From here until the resources are given back, destroyed or handed over, this attempt owns
        // them; anything unexpected destroys the connection and returns the quota.
        let owned = true
        try {
          const tryStarted = this.#deps.clock.now()
          const s1 = await runSettlementCoordinationS1V1(client, plan)
          record.event('s1', { kind: s1.kind, ...(s1.kind === 'contended' ? { family: s1.family } : {}), ...(s1.kind === 'uncertain' ? { reason: s1.reason } : {}) })

          if (s1.kind === 'uncertain') {
            this.budget.record('dedicated', this.#deps.clock.now() - tryStarted)
            owned = false
            this.#destroy(client, lease, s1.reason, record)
            for (const ticket of this.#tickets.values()) this.#deps.prober.reportUndetermined(ticket)
            throw new AttendanceCoordinationConnectionUncertainError(s1.reason)
          }

          if (s1.kind === 'acquired') {
            this.budget.record('dedicated', this.#deps.clock.now() - tryStarted)
            for (const family of families) this.#deps.prober.reportFree(lexical, family)
            this.#tickets.clear()
            const handover = await runSettlementCoordinationHandoverV1(client, plan, this.#request.handover)
            record.event('handover', { kind: handover.kind, ...(handover.kind === 'uncertain' ? { reason: handover.reason } : {}) })
            if (handover.kind === 'uncertain') {
              owned = false
              this.#destroy(client, lease, handover.reason, record)
              throw new AttendanceCoordinationConnectionUncertainError(handover.reason)
            }
            owned = false
            this.#active = { client, lease, plan, credential: handover.credential }
            this.#emit(record, 'handed-over', null)
            return this.#handle(this.#active, this.#attempt)
          }

          // Contended: give everything back before anyone backs off.
          const family = s1.family
          this.budget.record(family, this.#deps.clock.now() - tryStarted)
          if (family === 'class-00') {
            // k_ok was true: the dedicated family's contention is over even though class-00 lost.
            this.#deps.prober.reportFree(lexical, 'dedicated')
            this.#tickets.delete('dedicated')
          }
          owned = false
          this.#giveBack(client, lease, record)
          if (this.#request.oneShot) throw new SettlementCoordinationAcquireError(SETTLEMENT_COORDINATION_EXHAUSTION_CODES[family], this.budget.waits())
          const role = this.#deps.prober.reportFailure(lexical, family, this.#id, this.#tickets.get(family))
          if (role.role === 'prober') {
            this.#tickets.set(family, role.ticket)
            this.#retry += 1
            const delay = settlementCoordinationBackoffMsV1(this.#retry, this.#deps.random, this.budget.remaining())
            record.event('backoff', { family, ms: delay })
            const slept = this.#deps.clock.now()
            try {
              await this.#deps.clock.sleep(delay, this.#request.signal)
            } finally {
              this.budget.record(family, this.#deps.clock.now() - slept)
            }
          } else {
            this.#tickets.delete(family)
          }
        } finally {
          if (owned) {
            invalidateSettlementCoordinationCredentialsV1(client)
            client.release(new Error('settlement coordination attempt failed unexpectedly'))
            this.#deps.ledger.dropClient(this.#id)
            lease.release()
            this.#deps.ledger.dropLease(this.#id)
            record.event('destroyed', { reason: 'unexpected' })
          }
        }
      }
    } catch (error) {
      this.#handOverProbes()
      const mapped = this.#mapError(error)
      this.#emit(record, 'failed', (mapped as { code?: unknown }).code as string | undefined ?? null)
      throw mapped
    }
  }

  /** Leaves the coordinator. A unit that still holds an attempt is a programming error: it is destroyed. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#handOverProbes()
    const active = this.#active
    if (active) {
      this.#active = null
      invalidateSettlementCoordinationCredentialsV1(active.client)
      active.client.release(new Error('settlement coordination unit closed while holding an attempt'))
      this.#deps.ledger.dropClient(this.#id)
      active.lease.release()
      this.#deps.ledger.dropLease(this.#id)
      this.#deps.ledger.exit(this.#id)
      throw new Error('settlement coordination unit closed while holding an attempt')
    }
    this.#deps.ledger.exit(this.#id)
  }

  #assertIdle(): void {
    if (this.#closed) throw new Error('settlement coordination unit is closed')
    if (this.#active) throw new Error('settlement coordination unit already holds an attempt (overlapping acquisition)')
  }

  #throwIfAborted(): void {
    if (this.#request.signal?.aborted) throw new SettlementCoordinationAbortedError()
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
        result = await this.#deps.prober.wait(org, family, this.#id, { deadline: this.budget.deadline, signal: this.#request.signal })
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
        signal: this.#request.signal,
      })
    } catch (error) {
      this.budget.record('quota', this.#deps.clock.now() - started)
      if (error instanceof CoordinationWaitEndedError && error.reason === 'deadline') {
        throw this.#request.background
          ? new SettlementCoordinationAcquireError(SETTLEMENT_COORDINATION_CAPACITY_BUSY, this.budget.waits())
          : this.#exhausted()
      }
      throw error
    }
    this.budget.record('quota', this.#deps.clock.now() - started)
    this.#deps.ledger.takeLease(this.#id)
    record.event('quota', { waitedMs: this.#deps.clock.now() - started })
    return lease
  }

  /**
   * Borrows a connection, raced against min(remaining budget, DB_CONNECT_TIMEOUT). A connect that
   * loses the race keeps `lease` until it settles: a late client is released, then the lease.
   */
  async #borrow(lease: SettlementCoordinationQuotaLeaseV1 | null, record: AttemptRecorder | null): Promise<SettlementCoordinationClientV1> {
    const clock = this.#deps.clock
    const signal = this.#request.signal
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
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
        return true
      }
      if (signal?.aborted) {
        finish({ kind: 'aborted' })
      } else {
        timer = clock.setTimer(raceMs, () => finish({ kind: 'timeout' }))
        signal?.addEventListener('abort', onAbort, { once: true })
      }
      connecting.then(
        (client) => void finish({ kind: 'client', client }),
        (error) => void finish({ kind: 'error', error }),
      )
    })
    this.budget.record('connect', clock.now() - started)
    record?.event('connect', { kind: outcome.kind, waitedMs: clock.now() - started })
    if (outcome.kind === 'client') {
      this.#deps.ledger.takeClient(this.#id)
      return outcome.client
    }
    if (outcome.kind === 'error') {
      if (lease) {
        lease.release()
        this.#deps.ledger.dropLease(this.#id)
      }
      throw new SettlementCoordinationAcquireError(SETTLEMENT_COORDINATION_CONNECTION_UNAVAILABLE, this.budget.waits(), outcome.error)
    }
    // Lost the race: the connect may still settle. Its quota stays out until it does.
    const settle = lease ? this.#deps.ledger.abandonConnect(this.#request.quotaClass) : () => undefined
    if (lease) this.#deps.ledger.dropLease(this.#id)
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
    if (outcome.kind === 'aborted') throw new SettlementCoordinationAbortedError()
    throw new SettlementCoordinationAcquireError(SETTLEMENT_COORDINATION_CONNECTION_UNAVAILABLE, this.budget.waits())
  }

  /** A lost try: the connection is clean (S1 left nothing held), so it goes back; then global, then org. */
  #giveBack(client: SettlementCoordinationClientV1, lease: SettlementCoordinationQuotaLeaseV1, record: AttemptRecorder): void {
    client.release()
    this.#deps.ledger.dropClient(this.#id)
    lease.release()
    this.#deps.ledger.dropLease(this.#id)
    record.event('released')
  }

  #destroy(
    client: SettlementCoordinationClientV1,
    lease: SettlementCoordinationQuotaLeaseV1,
    reason: SettlementCoordinationUncertainReasonV1,
    record: AttemptRecorder,
  ): void {
    invalidateSettlementCoordinationCredentialsV1(client)
    client.release(new AttendanceCoordinationConnectionUncertainError(reason))
    this.#deps.ledger.dropClient(this.#id)
    lease.release()
    this.#deps.ledger.dropLease(this.#id)
    record.event('destroyed', { reason })
  }

  #handOverProbes(): void {
    for (const ticket of this.#tickets.values()) this.#deps.prober.handOver(ticket)
    this.#tickets.clear()
  }

  #handle(active: ActiveAttempt, attempt: number): SettlementCoordinationHandleV1 {
    let ended = false
    return Object.freeze({
      client: active.client,
      credential: active.credential,
      plan: active.plan,
      attempt,
      end: (error?: unknown) => {
        if (ended) throw new Error('settlement coordination attempt ended twice')
        ended = true
        if (this.#active === active) this.#active = null
        invalidateSettlementCoordinationCredentialsV1(active.client)
        active.client.release(error)
        this.#deps.ledger.dropClient(this.#id)
        active.lease.release()
        this.#deps.ledger.dropLease(this.#id)
      },
    })
  }

  #emit(record: AttemptRecorder, outcome: 'handed-over' | 'failed', code: string | null): void {
    this.#deps.onAttempt?.(
      Object.freeze({
        attempt: record.attempt,
        org: record.org,
        quotaClass: record.quotaClass,
        outcome,
        code,
        events: Object.freeze([...record.events]),
        waits: this.budget.waits(),
      }),
    )
  }
}

export class SettlementCoordinatorV1 {
  readonly deps: SettlementCoordinatorDepsV1

  constructor(deps: SettlementCoordinatorDepsV1) {
    this.deps = deps
  }

  openUnit(request: SettlementCoordinationUnitRequestV1): SettlementCoordinationUnitV1 {
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
  })
}
