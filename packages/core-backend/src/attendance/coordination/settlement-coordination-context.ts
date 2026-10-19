/**
 * Attendance settlement coordination — the coordination context (§3.2 step 11).
 *
 * While a coordinated transaction's body runs, an AsyncLocalStorage carries its context: the
 * handed-over connection, the credential, the org and whether class-00 is held. The context counts
 * as active only while its credential is live on that connection. COMMIT, ROLLBACK and release all
 * invalidate the credential first, so work the body derived that runs after commit (post-commit
 * callbacks, timers started inside the body) no longer sees "inside a coordinated transaction".
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

import { SettlementCoordinationCredentialV1 } from './settlement-coordination-handover'

export interface SettlementCoordinationContextV1 {
  readonly connection: object
  readonly credential: SettlementCoordinationCredentialV1
  readonly orgLexical: string
  readonly classZeroHeld: boolean
  readonly entryLabel: string
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
  if (!context) return null
  return SettlementCoordinationCredentialV1.isLiveOn(context.credential, context.connection) ? context : null
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
