import { attendanceOwningSessionForClientV1, type AttendanceOwningSessionV1 } from './attendance-owning-session'
import { W4_TRANSACTION_STATEMENT_TIMEOUT_MS } from './w4c0-operation-contract'

/** Preserve the V1 transaction's existing bound while waiting for deferred
 * constraints at COMMIT. The pool's shorter read timer must not report failure
 * before the server's bounded transaction statement has finished. */
export function createAttendanceLegacyPlanCommitConnectionV1(
  client: unknown,
): AttendanceOwningSessionV1 {
  return attendanceOwningSessionForClientV1(client, {
    commitQueryTimeoutMs: W4_TRANSACTION_STATEMENT_TIMEOUT_MS,
  })
}
