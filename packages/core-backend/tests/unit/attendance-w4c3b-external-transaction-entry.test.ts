/**
 * Approval change-request design lock v5.9 §3 C-1 (lock:88-92) — the W4 external transaction
 * entry's INPUT SURFACE and its two caller obligations.
 *
 * Scope of this file: only what is decidable without a database — the entry's refusals, and the
 * proof that each refusal is load-bearing (every negative has a positive control that differs in
 * exactly the one field under test and gets strictly further). The protocol's own behaviour
 * (preflight, posture resolve, outbox, seal) is NOT exercised here; it is the SAME function body
 * the HTTP entry runs (`runRequestOperationProtocolV1`) and belongs to the slice's real-DB
 * acceptance, not to a stub.
 *
 * Why the stub can prove anything at all: the two obligations are checked BEFORE the protocol
 * reaches any adapter, so a sentinel thrown from `prepareIdentity` is an unambiguous "got past the
 * gate" witness. Tests that expect a refusal assert the typed CODE, never a bare throw — a bare
 * `rejects.toThrow()` here would pass on the sentinel too and would be blind to which gate fired.
 */
import { describe, expect, it } from 'vitest'
import {
  AttendanceW4RequestBoundaryError,
  createAttendanceRequestOperationBoundaryV1,
  type AttendanceRequestOperationAdaptersV1,
} from '../../src/attendance/w4c3b-request-operation-boundary'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'

const PAST_THE_GATES = 'SENTINEL_PREPARE_IDENTITY_REACHED'

/** Thrown by the stub adapter's prepareIdentity — the "both gates passed" witness. */
class PastTheGatesError extends Error {
  constructor() {
    super(PAST_THE_GATES)
    this.name = 'PastTheGatesError'
  }
}

function stubAdapters(): AttendanceRequestOperationAdaptersV1 {
  const adapter = {
    async prepareIdentity(): Promise<never> {
      throw new PastTheGatesError()
    },
    async prepare(): Promise<never> {
      throw new PastTheGatesError()
    },
    async execute(): Promise<never> {
      throw new PastTheGatesError()
    },
  }
  return Object.freeze({
    request_create: adapter,
    request_pending_edit: adapter,
    request_decision: adapter,
    request_cancel: adapter,
  }) as unknown as AttendanceRequestOperationAdaptersV1
}

/** A PostgreSQL error as the driver surfaces it: the SQLSTATE lives on `.code`. */
function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`stub pg error ${code}`), { code })
}

/**
 * Models the two things the entry's preconditions actually interrogate: whether a transaction
 * block is open (via the SAVEPOINT probe's SQLSTATE) and the transaction isolation level. Every
 * other statement returns zero rows — the stub adapter throws before anything else is reached.
 *
 * `txnState` mirrors real PostgreSQL: `'open'` lets SAVEPOINT succeed; `'none'` raises 25P01
 * (autocommit — no transaction block); `'aborted'` raises 25P02 (open but already failed).
 * `seen` records the SQL so a test can assert a probe ran at all — a probe that never runs makes
 * an "it is checked" claim vacuous.
 */
function stubClient(
  isolation: string,
  txnState: 'open' | 'none' | 'aborted' = 'open',
): AttendanceW4TransactionClientV1 & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async query(sqlText: string) {
      seen.push(sqlText)
      if (sqlText.startsWith('SAVEPOINT ')) {
        if (txnState === 'none') throw pgError('25P01')
        if (txnState === 'aborted') throw pgError('25P02')
        return { rows: [] }
      }
      if (sqlText.includes('transaction_isolation')) {
        return { rows: [{ isolation }] }
      }
      return { rows: [] }
    },
  }
}

const VALID_OPERATION_ID = '11111111-2222-4333-8444-555555555555'

function validExternalInput(client: AttendanceW4TransactionClientV1) {
  return {
    client,
    kind: 'request_cancel' as const,
    operationId: VALID_OPERATION_ID,
    correlationId: 'cancel-round-c2-unit',
    routeVariant: null,
    routeInput: { requestId: '99999999-8888-4777-8666-555555555555' },
  }
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AttendanceW4RequestBoundaryError) return error.code
    return `NOT_A_BOUNDARY_ERROR:${(error as Error)?.name}:${(error as Error)?.message}`
  }
  return 'NO_ERROR_THROWN'
}

describe('W4 external transaction entry (lock §3 C-1) — input surface', () => {
  it('POSITIVE CONTROL: a well-formed input on a SERIALIZABLE transaction reaches the protocol', async () => {
    const client = stubClient('serializable')
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => {
        throw new Error('the external entry must never acquire a connection')
      },
      adapters: stubAdapters(),
    })

    // Reaching `prepareIdentity` is the whole claim: both obligations passed and the protocol ran.
    await expect(boundary.executeInExternalTransaction(validExternalInput(client)))
      .rejects.toThrow(PAST_THE_GATES)
    // The isolation probe is not merely declared — it executed.
    expect(client.seen.some((sql) => sql.includes('transaction_isolation'))).toBe(true)
  })

  it('refuses a caller-owned transaction that is not SERIALIZABLE (obligation 1)', async () => {
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => {
        throw new Error('the external entry must never acquire a connection')
      },
      adapters: stubAdapters(),
    })

    // `execute`'s own runner opens BEGIN ISOLATION LEVEL SERIALIZABLE; a caller-owned READ
    // COMMITTED transaction runs the identical protocol under a weaker snapshot.
    expect(await codeOf(() =>
      boundary.executeInExternalTransaction(validExternalInput(stubClient('read committed')))))
      .toBe('W4C3B_REQUEST_EXTERNAL_TRANSACTION_ISOLATION_INVALID')

    expect(await codeOf(() =>
      boundary.executeInExternalTransaction(validExternalInput(stubClient('repeatable read')))))
      .toBe('W4C3B_REQUEST_EXTERNAL_TRANSACTION_ISOLATION_INVALID')
  })

  it('refuses an autocommit caller even when the isolation level READS as serializable', async () => {
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => {
        throw new Error('the external entry must never acquire a connection')
      },
      adapters: stubAdapters(),
    })

    // The fail-OPEN case an isolation-only check cannot see. `current_setting` also answers for
    // the implicit single-statement transaction of an autocommit connection, reporting
    // `default_transaction_isolation` — so on a deployment configured
    // `default_transaction_isolation = serializable` this input satisfies the isolation predicate
    // while having no transaction at all: every protocol statement would autocommit separately.
    // Note the fixture: isolation SAYS serializable, so a green here could only come from the
    // open-transaction probe, not from the isolation check.
    const autocommit = stubClient('serializable', 'none')
    expect(await codeOf(() => boundary.executeInExternalTransaction(validExternalInput(autocommit))))
      .toBe('W4C3B_REQUEST_EXTERNAL_TRANSACTION_NOT_OPEN')
    expect(autocommit.seen.some((sql) => sql.startsWith('SAVEPOINT '))).toBe(true)

    // An open-but-aborted transaction (25P02) can no longer commit anything, so running the
    // protocol in it could only produce a doomed write. Same refusal.
    expect(await codeOf(() =>
      boundary.executeInExternalTransaction(validExternalInput(stubClient('serializable', 'aborted')))))
      .toBe('W4C3B_REQUEST_EXTERNAL_TRANSACTION_NOT_OPEN')
  })

  it('leaves no probe savepoint behind in the caller’s subtransaction stack', async () => {
    const client = stubClient('serializable')
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => {
        throw new Error('the external entry must never acquire a connection')
      },
      adapters: stubAdapters(),
    })
    await expect(boundary.executeInExternalTransaction(validExternalInput(client)))
      .rejects.toThrow(PAST_THE_GATES)

    // ROLLBACK TO alone leaves the savepoint DEFINED, so RELEASE must follow it — the caller owns
    // this transaction and must be left inside no subtransaction the boundary created.
    const probeStatements = client.seen.filter((sql) => sql.includes('w4c3b_external_txn_probe'))
    expect(probeStatements).toEqual([
      'SAVEPOINT w4c3b_external_txn_probe',
      'ROLLBACK TO SAVEPOINT w4c3b_external_txn_probe',
      'RELEASE SAVEPOINT w4c3b_external_txn_probe',
    ])
  })

  it('refuses a null operationId — the legacy branch skips the very W4 protocol this entry reuses', async () => {
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => {
        throw new Error('the external entry must never acquire a connection')
      },
      adapters: stubAdapters(),
    })

    // `execute` accepts null here and routes into the legacy branch (no preflight, no identity
    // congruence, no outbox, no seal). The external entry must not offer that degradation.
    const code = await codeOf(() => boundary.executeInExternalTransaction({
      ...validExternalInput(stubClient('serializable')),
      operationId: null as unknown as string,
    }))
    expect(code).toBe('W4C3B_REQUEST_EXTERNAL_TRANSACTION_INPUT_INVALID')
  })

  it('run mode and authorization credentials are UNREPRESENTABLE in the input (lock §3 C-1)', async () => {
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => {
        throw new Error('the external entry must never acquire a connection')
      },
      adapters: stubAdapters(),
    })

    // 「运行模式、授权凭据不得由普通请求参数指定」. The check is a CLOSED key set, not a
    // per-key blocklist, so this holds for any future credential-shaped key as well — the two
    // below are witnesses, not the enumeration (enumerating traps does not converge).
    for (const smuggled of [
      { acceptedWritePosture: 'authoritative' },
      { actorPosture: 'operator' },
    ]) {
      const code = await codeOf(() => boundary.executeInExternalTransaction({
        ...validExternalInput(stubClient('serializable')),
        ...smuggled,
      } as never))
      expect(code).toBe('W4C3B_REQUEST_EXTERNAL_TRANSACTION_INPUT_INVALID')
    }
  })

  it('refuses a client that is not a query-capable transaction client', async () => {
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => {
        throw new Error('the external entry must never acquire a connection')
      },
      adapters: stubAdapters(),
    })

    for (const client of [null, {}, { query: 'not-a-function' }]) {
      const code = await codeOf(() => boundary.executeInExternalTransaction({
        ...validExternalInput(stubClient('serializable')),
        client: client as never,
      }))
      expect(code).toBe('W4C3B_REQUEST_EXTERNAL_TRANSACTION_INPUT_INVALID')
    }
  })

  it('the HTTP entry still exists and is a separate method (the refactor did not replace it)', () => {
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => {
        throw new Error('not reached')
      },
      adapters: stubAdapters(),
    })
    expect(typeof boundary.execute).toBe('function')
    expect(typeof boundary.executeInExternalTransaction).toBe('function')
    expect(boundary.execute).not.toBe(boundary.executeInExternalTransaction)
  })
})
