import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import { acquireAttendanceW7CompositeFactsLocksV1 } from './w7-resolver/w7-composite-lock-order'

/** Same key as D1's exclusive configuration writer; pinned against that writer. */
export function buildAttendanceTimezoneRuntimeOrgLockKeyV1(orgId: string): string {
  return JSON.stringify(['attendance-timezone-policy-v1', orgId])
}

/**
 * Acquire after sealed-operation replay, before source reads and parent/request
 * locks. The existing timeline -> schedule helper remains the only acquisition
 * of those two families. Runtime reads share the org policy lock; D1 writes use
 * the conflicting exclusive mode.
 */
export async function acquireAttendanceTimezoneRuntimeLocksV1(
  trx: AttendanceW4TransactionClientV1,
  input: { orgId: string; userId: string; mode?: 'shared' | 'exclusive' },
): Promise<void> {
  if (input.mode !== undefined && input.mode !== 'shared' && input.mode !== 'exclusive') {
    throw new Error('ATTENDANCE_TIMEZONE_INVALID_LOCK_MODE')
  }
  const policyLock = input.mode === 'exclusive'
    ? 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'
    : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))'
  await trx.query(policyLock, [
    buildAttendanceTimezoneRuntimeOrgLockKeyV1(input.orgId),
  ])
  await acquireAttendanceW7CompositeFactsLocksV1(trx, { orgKey: input.orgId, userId: input.userId })
}
