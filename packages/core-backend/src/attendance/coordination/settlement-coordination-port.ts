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

export { SettlementCoordinationRestartSignalV1 }

/** The post-lock recheck found another org (§3.2 step 6.5): restart under `org`. */
export class SettlementCoordinationRecheckMismatchV1 extends Error {
  readonly org: string
  /** The entry's registered conflict code for a used-up recheck counter. */
  readonly conflictCode: string | undefined

  constructor(org: string, conflictCode?: string) {
    super('settlement coordination recheck mismatch')
    this.name = 'SettlementCoordinationRecheckMismatchV1'
    this.org = org
    this.conflictCode = conflictCode
  }
}

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
  /** Work to run after COMMIT, release and quota return, outside the coordination context. */
  afterCommit(callback: () => unknown): void
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
  /** `ConnectionPool` transaction depth: the port refuses to start inside a pool transaction. */
  readonly transactionDepth?: () => number
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
      onError?.(error)
    }
  }
}

export async function coordinatedTransactionV1<T>(options: SettlementCoordinatedTransactionOptionsV1<T>): Promise<T> {
  assertNoSettlementCoordinationContextV1('context')
  if ((options.transactionDepth?.() ?? 0) !== 0) throw new AttendanceCoordinationNestingError('pool-transaction')
  const unit = options.unit ?? options.coordinator.openUnit(options.request)
  try {
    let org = 'org' in options.candidate ? options.candidate.org : await unit.readCandidate(options.candidate.read)
    for (;;) {
      const handle = await unit.acquire(org)
      const callbacks: Array<() => unknown> = []
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
              afterCommit: (callback) => {
                callbacks.push(callback)
              },
            }),
        )
      } catch (error) {
        if (error instanceof SettlementCoordinationRestartSignalV1) {
          await unit.restart(handle, { reason: 'serialization', transaction: 'live', error: error.original })
          continue
        }
        if (error instanceof SettlementCoordinationRecheckMismatchV1) {
          await unit.restart(handle, { reason: 'recheck', transaction: 'live', error, conflictCode: error.conflictCode })
          org = error.org
          continue
        }
        await rollbackAfterBodyError(handle)
        throw error
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
          throw onRetryable(committed.error)
        }
        await unit.restart(handle, { reason: 'serialization', transaction: 'ended', commit: committed })
        continue
      }
      // Uncertain: never committed as far as we know; no callback, no second run, connection destroyed.
      handle.end(new AttendanceCoordinationConnectionUncertainError(committed.reason))
      throw committed.error ?? new AttendanceCoordinationConnectionUncertainError(committed.reason)
    }
  } finally {
    if (!options.unit) unit.close()
  }
}
