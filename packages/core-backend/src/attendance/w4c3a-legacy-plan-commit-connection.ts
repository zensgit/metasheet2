import type { PoolClient } from 'pg'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import { W4_TRANSACTION_STATEMENT_TIMEOUT_MS } from './w4c0-operation-contract'

/** Preserve the V1 transaction's existing bound while waiting for deferred
 * constraints at COMMIT. The pool's shorter read timer must not report failure
 * before the server's bounded transaction statement has finished. */
export function createAttendanceLegacyPlanCommitConnectionV1(
  client: Pick<PoolClient, 'query'>,
): AttendanceW4TransactionClientV1 {
  return {
    async query(text, values) {
      if (text !== 'COMMIT') return client.query<Record<string, unknown>>(text, values)
      const config = { text, values, query_timeout: W4_TRANSACTION_STATEMENT_TIMEOUT_MS }
      return client.query<Record<string, unknown>>(config)
    },
  }
}
