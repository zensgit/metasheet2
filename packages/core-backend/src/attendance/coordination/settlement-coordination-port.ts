/**
 * Attendance settlement coordination — the core port `coordinatedTransaction` (§1.1 P1-1, §3.2
 * steps 6–8 and 11).
 *
 * The port owns one logical transaction from candidate to release. It opens a coordination unit (or
 * uses the caller's, for an outer retry), resolves the org, acquires (quota → connection → S1 →
 * BEGIN + S2), runs the body inside the coordination context on the handed-over connection, and
 * ends the transaction itself; the body never sends BEGIN, COMMIT or ROLLBACK and never releases.
 *
 *  - COMMIT goes through the commit primitive. `committed`: the context ends with the credential,
 *    the connection goes back once, global then org quota return, then the post-commit callbacks run
 *    outside the context, and last the body's deferred result (if it asked for one) is computed.
 *    `retryable` (40001 / 40P01 at COMMIT): a coordination restart with `transaction: 'ended'`, or
 *    the entry's own mapping when it must not retry (M07). `uncertain`: the connection is destroyed,
 *    no callback runs and the body is not run again; the COMMIT error object is rethrown.
 *  - The body asks for a coordination restart only with the private restart signal (what the
 *    handed-over runner turns 40001 / 40P01 into) or the recheck mismatch (the post-lock recheck
 *    found another org). A plain 40001 thrown by the body is a business error like any other.
 *  - Any other error from the body rolls back through the rollback primitive. A ROLLBACK that fails
 *    destroys the connection but never replaces the body's error.
 *  - The restart signal never leaves the port: when a counter is used up the unit rethrows the
 *    original 40001 / 40P01 object (or throws the registered conflict code for the recheck).
 *
 * Nothing here is wired into production in P1-1; the port is assembled only by tests.
 */
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import {
  AttendanceCoordinationNestingError,
  SettlementCoordinationRecheckMismatchV1,
  SettlementCoordinationRestartSignalV1,
  assertNoSettlementCoordinationContextV1,
  runInSettlementCoordinationContextV1,
} from './settlement-coordination-context'
import {
  AttendanceCoordinationConnectionUncertainError,
  SettlementCoordinationCredentialV1,
  commitSettlementCoordinationTransactionV1,
  rollbackSettlementCoordinationTransactionV1,
  verifySettlementCoordinationCredentialV1,
} from './settlement-coordination-handover'
import type {
  SettlementCoordinationHandleV1,
  SettlementCoordinationUnitRequestV1,
  SettlementCoordinationUnitV1,
  SettlementCoordinatorV1,
} from './settlement-coordinator'

export { SettlementCoordinationRecheckMismatchV1, SettlementCoordinationRestartSignalV1 }

const DEFERRED = Symbol('settlement-coordination-deferred-result')

/** A body result computed only after COMMIT, release and the post-commit callbacks. */
export interface SettlementCoordinationDeferredResultV1<T> {
  readonly [DEFERRED]: () => Promise<T>
}

export function settlementCoordinationResultAfterCommitV1<T>(produce: () => Promise<T>): SettlementCoordinationDeferredResultV1<T> {
  return Object.freeze({ [DEFERRED]: produce })
}

function isDeferred<T>(value: unknown): value is SettlementCoordinationDeferredResultV1<T> {
  return typeof value === 'object' && value !== null && DEFERRED in value
}

export interface SettlementCoordinationBodyContextV1 {
  /** The handed-over connection: its transaction is open and protected. */
  readonly client: AttendanceW4TransactionClientV1
  readonly orgLexical: string
  readonly attempt: number
  /** The `detail` of the recheck mismatch that restarted this attempt, or null. */
  readonly recheck: unknown
  /** Work to run after COMMIT, release and quota return, outside the coordination context. */
  afterCommit(callback: () => unknown): void
  /** Called once if this attempt ends without a commit (rollback, restart or uncertain COMMIT). */
  onAbandon(callback: () => void): void
}

export interface SettlementCoordinatedTransactionOptionsV1<T> {
  readonly coordinator: SettlementCoordinatorV1
  readonly request: SettlementCoordinationUnitRequestV1
  /** Outer retries pass their unit (and call `beginOuterAttempt()` between calls); otherwise the port owns one. */
  readonly unit?: SettlementCoordinationUnitV1
  /** The org, or the candidate short read that finds it (§3.2 step 0). */
  readonly candidate: Readonly<{ org: string }> | Readonly<{ read: (client: AttendanceW4TransactionClientV1) => Promise<string> }>
  readonly body: (context: SettlementCoordinationBodyContextV1) => Promise<T | SettlementCoordinationDeferredResultV1<T>>
  /** 40001 / 40P01 at COMMIT: `'restart'` (default) or the entry's error, for entries that must not retry. */
  readonly onRetryableCommit?: 'restart' | ((error: unknown) => unknown)
  /**
   * `ConnectionPool` transaction depth (§3.2: the coordinator's entry asserts it is zero). Required, so an
   * entry wired in production cannot forget it; an entry outside the main process passes `() => 0`.
   */
  readonly transactionDepth: () => number
  /** A post-commit callback failed; the transaction stays committed and the remaining callbacks still run. */
  readonly onCallbackError?: (error: unknown) => void
}

async function rollbackAfterBodyError(handle: SettlementCoordinationHandleV1): Promise<void> {
  let destroyWith: unknown
  try {
    const rolled = await rollbackSettlementCoordinationTransactionV1(handle.client, handle.credential)
    if (rolled.kind === 'uncertain') destroyWith = new AttendanceCoordinationConnectionUncertainError(rolled.reason)
  } catch (error) {
    destroyWith = error
  }
  handle.end(destroyWith)
}

async function runCallbacks(callbacks: ReadonlyArray<() => unknown>, onError: ((error: unknown) => void) | undefined): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback()
    } catch (error) {
      try {
        onError?.(error)
      } catch {
        // A failing reporter cannot stop the remaining callbacks or the deferred result: the
        // transaction is committed, and a method suspended at its COMMIT must still be resumed.
      }
    }
  }
}

export async function coordinatedTransactionV1<T>(options: SettlementCoordinatedTransactionOptionsV1<T>): Promise<T> {
  assertNoSettlementCoordinationContextV1('context')
  if ((options.transactionDepth?.() ?? 0) !== 0) throw new AttendanceCoordinationNestingError('pool-transaction')
  const unit = options.unit ?? options.coordinator.openUnit(options.request)
  try {
    let org = 'org' in options.candidate ? options.candidate.org : await unit.readCandidate(options.candidate.read)
    let recheck: unknown = null
    for (;;) {
      const handle = await unit.acquire(org)
      const callbacks: Array<() => unknown> = []
      const abandoned: Array<() => void> = []
      const abandon = (): void => {
        for (const callback of abandoned.splice(0)) {
          try {
            callback()
          } catch {
            // An abandon observer cannot change how the attempt ended.
          }
        }
      }
      let outcome: T | SettlementCoordinationDeferredResultV1<T>
      try {
        outcome = await runInSettlementCoordinationContextV1(
          {
            connection: handle.client,
            orgLexical: handle.plan.key.org.lexical,
            classZeroHeld: handle.plan.classZeroKey !== null,
            entryLabel: options.request.handover.entryLabel,
            isLive: () => SettlementCoordinationCredentialV1.isLiveOn(handle.credential, handle.client),
            covers: (connection, coveredOrg, needsClassZero) =>
              verifySettlementCoordinationCredentialV1(connection, handle.credential, coveredOrg, { needsClassZero }),
          },
          () =>
            options.body({
              client: handle.client,
              orgLexical: handle.plan.key.org.lexical,
              attempt: handle.attempt,
              recheck,
              afterCommit: (callback) => {
                callbacks.push(callback)
              },
              onAbandon: (callback) => {
                abandoned.push(callback)
              },
            }),
        )
      } catch (error) {
        if (error instanceof SettlementCoordinationRestartSignalV1) {
          try {
            await unit.restart(handle, { reason: 'serialization', transaction: 'live', error: error.original })
          } finally {
            abandon()
          }
          recheck = null
          continue
        }
        if (error instanceof SettlementCoordinationRecheckMismatchV1) {
          try {
            await unit.restart(handle, { reason: 'recheck', transaction: 'live', error, conflictCode: error.conflictCode })
          } finally {
            abandon()
          }
          org = error.org
          recheck = error.detail ?? null
          continue
        }
        await rollbackAfterBodyError(handle)
        abandon()
        throw error
      }
      // The connection reported an error while held (S1 note 1): its state is unknown, so no COMMIT is
      // sent on it. Destroyed once, abandon notices run, and the connection's own error goes up.
      const lost = handle.connectionError()
      if (lost !== undefined) {
        handle.end(new AttendanceCoordinationConnectionUncertainError('connection-error'))
        abandon()
        throw lost
      }
      const committed = await commitSettlementCoordinationTransactionV1(handle.client, handle.credential)
      if (committed.kind === 'committed') {
        handle.end()
        await runCallbacks(callbacks, options.onCallbackError)
        return isDeferred<T>(outcome) ? await outcome[DEFERRED]() : (outcome as T)
      }
      if (committed.kind === 'retryable') {
        const onRetryable = options.onRetryableCommit ?? 'restart'
        if (onRetryable !== 'restart') {
          // The server already rolled the transaction back: the connection is clean.
          handle.end()
          abandon()
          throw onRetryable(committed.error)
        }
        try {
          await unit.restart(handle, { reason: 'serialization', transaction: 'ended', commit: committed })
        } finally {
          abandon()
        }
        recheck = null
        continue
      }
      // Uncertain: never committed as far as we know; no callback, no second run, connection destroyed.
      handle.end(new AttendanceCoordinationConnectionUncertainError(committed.reason))
      abandon()
      throw committed.error ?? new AttendanceCoordinationConnectionUncertainError(committed.reason)
    }
  } finally {
    if (!options.unit) unit.close()
  }
}

/** The attempt that a suspended method was waiting on ended without a commit. */
export class SettlementCoordinationAttemptAbandonedError extends Error {
  readonly code = 'ATTENDANCE_COORDINATION_ATTEMPT_ABANDONED'

  constructor() {
    super('ATTENDANCE_COORDINATION_ATTEMPT_ABANDONED')
    this.name = 'SettlementCoordinationAttemptAbandonedError'
  }
}

/**
 * Bridges a method written around its own COMMIT to the port. `start` runs the method with a
 * `commit` that, instead of sending COMMIT, suspends the method until the port has committed and
 * released (and rejects if the attempt ends otherwise). The body's result is deferred, so whatever
 * the method does after its COMMIT — post-commit work, the final read — runs after release and
 * outside the coordination context, in the order the method already has.
 *
 * The body resolves once the method asks to commit; an error the method throws before that is the
 * body's error (the port rolls back). A method that returns without asking to commit is refused.
 */
export async function handOverToSuspendedMethodV1<T>(
  context: SettlementCoordinationBodyContextV1,
  start: (commit: () => Promise<void>) => Promise<T>,
): Promise<SettlementCoordinationDeferredResultV1<T>> {
  let requestCommit!: () => void
  const commitRequested = new Promise<void>((resolve) => {
    requestCommit = resolve
  })
  let releaseCommit!: () => void
  let abandonCommit!: (error: unknown) => void
  const committed = new Promise<void>((resolve, reject) => {
    releaseCommit = resolve
    abandonCommit = reject
  })
  committed.catch(() => undefined)
  context.onAbandon(() => abandonCommit(new SettlementCoordinationAttemptAbandonedError()))
  let asked = false
  const running = start(async () => {
    // One COMMIT per attempt: a second call is a programming error in the method, never a second COMMIT.
    if (asked) throw new Error('settlement coordination: commit() called twice in one attempt')
    asked = true
    requestCommit()
    await committed
  })
  // The method's own outcome is observed through the race below and through the deferred result.
  running.catch(() => undefined)
  await Promise.race([
    commitRequested,
    running.then(() => {
      throw new Error('settlement coordination: the handed-over method returned without asking to commit')
    }),
  ])
  return settlementCoordinationResultAfterCommitV1(async () => {
    releaseCommit()
    return running
  })
}

