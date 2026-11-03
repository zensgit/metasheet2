/**
 * Attendance settlement coordination — the coordination context (§3.2 step 11).
 *
 * While a coordinated transaction's body runs, an AsyncLocalStorage carries its context: the
 * handed-over connection, the org and whether class-00 is held, plus two checks the port supplies
 * over the transaction's credential. The context counts as active only while that credential is live
 * on the connection. COMMIT, ROLLBACK and release all invalidate the credential first, so work the
 * body derived that runs after commit (post-commit callbacks, timers started inside the body) no
 * longer sees "inside a coordinated transaction".
 *
 * This module imports nothing from the rest of the package: the W4 runner and the class-00 helper
 * read it without pulling the coordinator into their import graph.
 *
 * Two nesting guards read it:
 *  - acquiring coordination quota while a context is active is refused, in production as in tests;
 *  - main-pool access inside an active context throws in tests and is only counted in production
 *    (`'count'` is the default mode; hooking the production pool belongs to S4).
 *
 * Creating the storage object at import time has no side effect: no timer, no I/O, no environment
 * read.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface SettlementCoordinationContextV1 {
  readonly connection: object
  readonly orgLexical: string
  readonly classZeroHeld: boolean
  readonly entryLabel: string
  /** Whether the transaction's credential is still live on `connection`. */
  isLive(): boolean
  /** No round trip: whether the live credential is `connection`'s and covers `org` (and class-00 when asked). */
  covers(connection: object, org: unknown, needsClassZero: boolean): boolean
}

/**
 * 40001 / 40P01 inside a handed-over runner: the coordination unit restarts (§3.2 step 8). Only the
 * coordinated-transaction port catches it; it never reaches the port's caller.
 */
export class SettlementCoordinationRestartSignalV1 extends Error {
  readonly original: unknown

  constructor(original: unknown) {
    super('settlement coordination restart')
    this.name = 'SettlementCoordinationRestartSignalV1'
    this.original = original
  }
}

/**
 * The post-lock recheck found another org or scope (§3.2 step 6.5): the coordination unit restarts
 * under `org`. `detail` is handed to the next attempt's body (the requirement read under the lock).
 */
export class SettlementCoordinationRecheckMismatchV1 extends Error {
  readonly org: string
  /** The entry's registered conflict code for a used-up recheck counter. */
  readonly conflictCode: string | undefined
  readonly detail: unknown

  constructor(org: string, conflictCode?: string, detail?: unknown) {
    super('settlement coordination recheck mismatch')
    this.name = 'SettlementCoordinationRecheckMismatchV1'
    this.org = org
    this.conflictCode = conflictCode
    this.detail = detail
  }
}

export type SettlementCoordinationNestingKindV1 = 'context' | 'quota' | 'main-pool' | 'pool-transaction'

/** A coordination entry or main-pool access where the contract forbids nesting. */
export class AttendanceCoordinationNestingError extends Error {
  readonly code = 'ATTENDANCE_COORDINATION_NESTED'
  readonly kind: SettlementCoordinationNestingKindV1
  readonly detail: string | null

  constructor(kind: SettlementCoordinationNestingKindV1, detail: string | null = null) {
    super(`ATTENDANCE_COORDINATION_NESTED:${kind}${detail ? `:${detail}` : ''}`)
    this.name = 'AttendanceCoordinationNestingError'
    this.kind = kind
    this.detail = detail
  }
}

const storage = new AsyncLocalStorage<SettlementCoordinationContextV1>()

/** The context of the coordinated transaction this async flow is in, or null once it has ended. */
export function currentSettlementCoordinationContextV1(): SettlementCoordinationContextV1 | null {
  const context = storage.getStore()
  return context && context.isLive() ? context : null
}

/** Runs `body` inside `context`. Only the coordinated-transaction port calls this. */
export function runInSettlementCoordinationContextV1<T>(context: SettlementCoordinationContextV1, body: () => Promise<T>): Promise<T> {
  if (currentSettlementCoordinationContextV1()) return Promise.reject(new AttendanceCoordinationNestingError('context'))
  return storage.run(context, body)
}

/** Refuses when an active coordination context exists (coordinator entry, quota acquisition). */
export function assertNoSettlementCoordinationContextV1(kind: SettlementCoordinationNestingKindV1): void {
  if (currentSettlementCoordinationContextV1()) throw new AttendanceCoordinationNestingError(kind)
}

export type SettlementCoordinationNestingModeV1 = 'throw' | 'count'

const mainPoolGuard: { mode: SettlementCoordinationNestingModeV1; counted: number } = { mode: 'count', counted: 0 }

/** Tests switch the main-pool guard to `'throw'`; production keeps `'count'`. Returns the previous mode. */
export function setSettlementCoordinationNestingModeV1(mode: SettlementCoordinationNestingModeV1): SettlementCoordinationNestingModeV1 {
  if (mode !== 'throw' && mode !== 'count') throw new TypeError(`unknown nesting mode ${String(mode)}`)
  const previous = mainPoolGuard.mode
  mainPoolGuard.mode = mode
  return previous
}

/** Main-pool accesses counted inside an active context since the process started (production mode). */
export function settlementCoordinationNestedMainPoolAccessesV1(): number {
  return mainPoolGuard.counted
}

/**
 * Called on main-pool access. Outside an active context it does nothing. Inside one it throws in
 * `'throw'` mode and counts in `'count'` mode.
 */
export function noteSettlementCoordinationMainPoolAccessV1(detail: string): void {
  if (!currentSettlementCoordinationContextV1()) return
  if (mainPoolGuard.mode === 'throw') throw new AttendanceCoordinationNestingError('main-pool', detail)
  mainPoolGuard.counted += 1
}
