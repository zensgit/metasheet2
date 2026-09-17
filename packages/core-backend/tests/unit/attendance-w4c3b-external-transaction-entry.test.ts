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
  runExternalTransactionAttemptInSavepointV1,
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

/**
 * Lock §3 C-3 / §11-④ (lock:126-130) — the business-refusal return contract.
 *
 * The adapter no longer throws its `ATTENDANCE_CANCELLATION_REVIEW_REQUIRED` 409 from inside
 * `execute`; it RETURNS the business outcome and the boundary decides. What these tests can prove
 * without a database is the decision itself and the savepoint discipline around it. What they
 * cannot prove — that a real refusal inside a real caller transaction leaves zero rows behind —
 * is a real-DB obligation and is NOT claimed here.
 */
const REFUSAL_HTTP_ERROR = Object.freeze({
  status: 409,
  code: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
  message: 'Approved leave cancellation requires attendance review',
  details: [{ field: 'calculation', message: 'record_missing' }],
})

/** Non-canonical org key: `parseCanonicalAttendanceRolloutOrgKeyV1` rejects it. */
const NON_CANONICAL_ORG = 'not a canonical org key'

/**
 * Reaches `adapter.execute` with no database: a non-canonical org plus a null operationId routes
 * the HTTP entry into the legacy branch, which calls `execute` directly. That is call site 1 of
 * three; all three funnel through the same `takeBusinessRefusal`.
 */
function refusingAdapters(refusal: unknown): AttendanceRequestOperationAdaptersV1 {
  const prepared = {
    orgId: NON_CANONICAL_ORG,
    actorId: '33333333-4444-4555-8666-777777777777',
    actorPosture: 'self',
    tokenSubjectUserId: null,
    subjectUserId: '33333333-4444-4555-8666-777777777777',
    subjectScope: 'self',
    commandPayload: Object.freeze({}),
    state: {},
  }
  const adapter = {
    async prepareIdentity() { return prepared },
    async prepare() { return prepared },
    async execute() { return refusal },
  }
  return Object.freeze({
    request_create: adapter,
    request_pending_edit: adapter,
    request_decision: adapter,
    request_cancel: adapter,
  }) as unknown as AttendanceRequestOperationAdaptersV1
}

/** An IDLE connection, as `runAttendanceResultOperationTransactionV1`'s own probe demands. */
function idleConnectionClient(): AttendanceW4TransactionClientV1 & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async query(sqlText: string) {
      seen.push(sqlText)
      if (sqlText.startsWith('SAVEPOINT ')) throw pgError('25P01')
      return { rows: [] }
    },
  }
}

describe('business refusal (lock §3 C-3 / §11-④) — the boundary decides throw vs return', () => {
  it('HTTP entry: throws the adapter’s OWN error object, unchanged (账侧字节等价)', async () => {
    const client = idleConnectionClient()
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release: () => undefined }),
      adapters: refusingAdapters({
        kind: 'business_refused',
        code: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
        detail: 'record_missing',
        httpError: REFUSAL_HTTP_ERROR,
      }),
    })

    let thrown: unknown = 'NOTHING_THROWN'
    try {
      await boundary.execute({
        kind: 'request_cancel',
        operationId: null,
        correlationId: 'http-entry-refusal',
        routeVariant: null,
        routeInput: { requestId: '99999999-8888-4777-8666-555555555555' },
      })
    } catch (error) {
      thrown = error
    }
    // Identity, not equality: the boundary rethrows the very instance the adapter built, so all
    // four fields (status, code, message, validation details) are whatever the adapter shipped —
    // there is no second place that could re-derive them differently.
    expect(thrown).toBe(REFUSAL_HTTP_ERROR)
    // And it is NOT converted into a boundary error: a 500 here would be a visible regression.
    expect(thrown).not.toBeInstanceOf(AttendanceW4RequestBoundaryError)
  })

  it('HTTP entry: a malformed refusal fails closed rather than throwing undefined', async () => {
    for (const malformed of [
      { kind: 'business_refused', code: '', detail: null, httpError: REFUSAL_HTTP_ERROR },
      { kind: 'business_refused', code: 'X', detail: 7, httpError: REFUSAL_HTTP_ERROR },
      { kind: 'business_refused', code: 'X', detail: null, httpError: undefined },
    ]) {
      const client = idleConnectionClient()
      const boundary = createAttendanceRequestOperationBoundaryV1({
        acquireConnection: async () => ({ client, release: () => undefined }),
        adapters: refusingAdapters(malformed),
      })
      expect(await codeOf(() => boundary.execute({
        kind: 'request_cancel',
        operationId: null,
        correlationId: 'http-entry-malformed-refusal',
        routeVariant: null,
        routeInput: { requestId: '99999999-8888-4777-8666-555555555555' },
      }))).toBe('W4C3B_REQUEST_BUSINESS_REFUSAL_INVALID')
    }
  })

  it('external entry: the attempt runs inside a boundary-owned savepoint', async () => {
    const client = stubClient('serializable')
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => {
        throw new Error('the external entry must never acquire a connection')
      },
      adapters: stubAdapters(),
    })
    await expect(boundary.executeInExternalTransaction(validExternalInput(client)))
      .rejects.toThrow(PAST_THE_GATES)

    const attempt = client.seen.filter((sql) => sql.includes('w4c3b_external_txn_attempt'))
    // The savepoint is taken BEFORE the protocol runs — a refusal discovered late must have
    // something to roll back to.
    expect(attempt).toEqual(['SAVEPOINT w4c3b_external_txn_attempt'])
    // An INFRASTRUCTURE exception is the other path (lock §3 C-3 「两条路径、两种返回」): it
    // propagates with the caller's transaction left for the caller to roll back. The boundary must
    // NOT issue ROLLBACK TO / RELEASE here — after a database error the transaction is aborted and
    // a RELEASE would itself fail, masking the real error.
    expect(attempt).not.toContain('ROLLBACK TO SAVEPOINT w4c3b_external_txn_attempt')
    expect(attempt).not.toContain('RELEASE SAVEPOINT w4c3b_external_txn_attempt')
  })
})

/**
 * The savepoint discipline itself, driven directly. The three protocol call sites that can produce
 * a refusal are only reachable with a real database, so the entry's own wrapper is exercised here
 * against a supplied outcome — the SAME function the entry calls, not a transcription of it.
 *
 * The negative ("no ROLLBACK/RELEASE on an infrastructure exception") is asserted above; per the
 * rule that an "assert it does not happen" needs its matching positive control, the refusal
 * sequence is asserted here in full and in order.
 */
describe('external attempt savepoint (lock §3 C-3) — refusal rolls back, exception does not', () => {
  function recordingClient(): AttendanceW4TransactionClientV1 & { seen: string[] } {
    const seen: string[] = []
    return {
      seen,
      async query(sqlText: string) {
        seen.push(sqlText)
        return { rows: [] }
      },
    }
  }

  it('POSITIVE CONTROL: a business refusal issues SAVEPOINT → ROLLBACK TO → RELEASE, in order', async () => {
    const client = recordingClient()
    const refusal = { kind: 'business_refused' as const, code: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED', detail: 'record_missing' }

    const result = await runExternalTransactionAttemptInSavepointV1(client, async () => refusal)

    // The decision reaches the caller — it is a RETURN, not a throw. That is the whole contract:
    // the approval side has to still be able to write and COMMIT its C-3 closure.
    expect(result).toEqual(refusal)
    // Exact sequence, exact order. ROLLBACK TO alone leaves the savepoint DEFINED, so a missing
    // RELEASE would leave the caller inside a subtransaction the boundary created — every
    // subsequent closure write would land at the wrong nesting level.
    expect(client.seen).toEqual([
      'SAVEPOINT w4c3b_external_txn_attempt',
      'ROLLBACK TO SAVEPOINT w4c3b_external_txn_attempt',
      'RELEASE SAVEPOINT w4c3b_external_txn_attempt',
    ])
  })

  it('a successful execution releases the savepoint but does NOT roll back', async () => {
    const client = recordingClient()
    const executed = { kind: 'executed' as const, response: { ok: true } }

    const result = await runExternalTransactionAttemptInSavepointV1(client, async () => executed)

    expect(result).toEqual(executed)
    // The discriminating half of the pair above: same wrapper, different outcome, and the ROLLBACK
    // is absent. Without this case, "ROLLBACK TO is issued" could be satisfied by a wrapper that
    // rolls back unconditionally and silently discards every successful cancellation.
    expect(client.seen).toEqual([
      'SAVEPOINT w4c3b_external_txn_attempt',
      'RELEASE SAVEPOINT w4c3b_external_txn_attempt',
    ])
  })

  it('an infrastructure exception issues neither ROLLBACK TO nor RELEASE', async () => {
    const client = recordingClient()
    const infra = Object.assign(new Error('deadlock detected'), { code: '40P01' })

    await expect(runExternalTransactionAttemptInSavepointV1(client, async () => { throw infra }))
      .rejects.toBe(infra)

    // Lock §3 C-3 「两条路径、两种返回」: the caller rolls back its whole transaction. After a
    // database error the transaction is aborted, so a RELEASE issued here would itself fail and
    // would mask the real error.
    expect(client.seen).toEqual(['SAVEPOINT w4c3b_external_txn_attempt'])
  })
})
