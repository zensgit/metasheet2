/**
 * Attendance settlement coordination — cleanup and unknown results against a real PostgreSQL
 * (P1-1 acceptance A04, S1-scope legs).
 *
 * Every `uncertain` outcome is followed by `release(err)` (in a `finally`, so a failed assertion
 * cannot leak the connection), and a second connection then confirms that the backend is gone and
 * that its advisory locks left `pg_locks`. A control leg shows why a normal release is not enough
 * after a lost result: with a one-connection pool the next checkout gets the same backend, still
 * holding the locks the lost statement really took.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import {
  AttendanceCoordinationConnectionUncertainError,
  commitSettlementCoordinationTransactionV1,
  planSettlementCoordinationV1,
  releaseSettlementCoordinationSessionLocksV1,
  rollbackSettlementCoordinationTransactionV1,
  runSettlementCoordinationHandoverV1,
  runSettlementCoordinationS1V1,
  verifySettlementCoordinationCredentialV1,
  type SettlementCoordinationPlanV1,
} from '../../src/attendance/coordination/settlement-coordination-handover'
import { SETTLEMENT_COORDINATION_KEY1 } from '../../src/attendance/coordination/settlement-coordination-key'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import {
  advisoryLocksOf,
  backendPid,
  isBigintLock,
  isDedicatedLock,
  waitForBackendGone,
} from '../helpers/settlement-coordination-db'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have a database URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

const K1 = SETTLEMENT_COORDINATION_KEY1
const HANDOVER = { isolation: 'SERIALIZABLE' as const, timeouts: { kind: 'none' as const }, entryLabel: 'test.cleanup' }
// Connections that end a test are destroyed rather than handed back (the control leg below is the
// one deliberate exception), so a failed assertion cannot leak session-level locks into a later test.
const DESTROY = new Error('test: never hand a test connection to the next test')

function canonicalPlan(): SettlementCoordinationPlanV1 {
  return planSettlementCoordinationV1(crypto.randomUUID(), { needsClassZero: true })
}

/** Runs the real statement, then throws as if the result never arrived (client-side timeout). */
function losingResults(client: PoolClient, lose: (sql: string) => boolean): AttendanceW4TransactionClientV1 {
  return {
    async query(sql: string, params?: unknown[]) {
      const result = params === undefined ? await client.query(sql) : await client.query(sql, params)
      if (lose(sql)) throw new Error('test: result lost after execution')
      return result
    },
  }
}

/** Throws before the statement reaches the server. */
function failing(client: PoolClient, fail: (sql: string) => Error | null): AttendanceW4TransactionClientV1 {
  return {
    async query(sql: string, params?: unknown[]) {
      const error = fail(sql)
      if (error) throw error
      return params === undefined ? client.query(sql) : client.query(sql, params)
    },
  }
}

/**
 * Makes matching statements on `client` itself fail before they reach the server. The object stays
 * the same, so a handover credential bound to it still identifies it (COMMIT / ROLLBACK refuse any
 * other connection). Returns the undo.
 */
function failOn(client: PoolClient, fail: (sql: string) => Error | null): () => void {
  const real = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<unknown>
  const patched = async (sql: string, params?: unknown[]) => {
    const error = typeof sql === 'string' ? fail(sql) : null
    if (error) throw error
    return params === undefined ? real(sql) : real(sql, params)
  }
  Object.defineProperty(client, 'query', { value: patched, configurable: true, writable: true })
  return () => {
    delete (client as unknown as { query?: unknown }).query
  }
}

describeIfDatabase('attendance settlement coordination — cleanup and unknown results (real database)', () => {
  let pool: Pool
  let observer: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl, max: 4 })
    observer = new Pool({ connectionString: dbUrl, max: 2 })
  })

  afterAll(async () => {
    await pool.end()
    await observer.end()
  })

  /**
   * Borrows a connection, runs `fn`, and ALWAYS destroys the connection afterwards, then confirms
   * from a separate connection that the backend and all of its advisory locks are gone.
   */
  async function withDestroyedClient(fn: (client: PoolClient, pid: number) => Promise<void>): Promise<void> {
    const client = await pool.connect()
    const pid = await backendPid(client)
    try {
      await fn(client, pid)
    } finally {
      client.release(new AttendanceCoordinationConnectionUncertainError('s1-statement-failed'))
    }
    expect(await waitForBackendGone(observer, pid)).toBe(true)
    expect(await advisoryLocksOf(observer, pid)).toEqual([])
  }

  it('releases exactly the held families when both unlocks succeed', async () => {
    const plan = canonicalPlan()
    const client = await pool.connect()
    try {
      const pid = await backendPid(client)
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      expect(await releaseSettlementCoordinationSessionLocksV1(client, plan)).toEqual({ kind: 'released' })
      expect(await advisoryLocksOf(observer, pid)).toEqual([])
    } finally {
      client.release(DESTROY)
    }
  })

  it('an unlock that returns false is uncertain; destroying the connection drops what is still held', async () => {
    const plan = canonicalPlan()
    await withDestroyedClient(async (client) => {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      // The class-00 session hold disappears out from under the unit.
      await client.query(`SELECT pg_advisory_unlock_shared(${(plan.classZeroKey as bigint).toString()}::bigint)`)
      expect(await releaseSettlementCoordinationSessionLocksV1(client, plan)).toEqual({ kind: 'uncertain', reason: 'unlock-returned-false' })
    })
  })

  it('S2 unlock returning false (session hold lost before handover) rolls back and is uncertain', async () => {
    const plan = canonicalPlan()
    await withDestroyedClient(async (client, pid) => {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      await client.query(`SELECT pg_advisory_unlock_shared(${K1}, ${plan.key.key2})`)
      expect(await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)).toEqual({ kind: 'uncertain', reason: 's2-unlock-failed' })
      // ROLLBACK already ran: out of the transaction. S2 had released the class-00 session hold, the
      // dedicated one was already gone, so nothing is left — but the unit could not know that when
      // it decided, which is why the contract still destroys the connection.
      const state = await client.query('SELECT now() = statement_timestamp() AS idle')
      expect(state.rows[0].idle).toBe(true)
      expect(await advisoryLocksOf(observer, pid)).toEqual([])
    })
  })

  it('S2 re-grant returning false (session hold lost and an exclusive holder slipped in) is uncertain', async () => {
    const plan = canonicalPlan()
    const intruder = await pool.connect()
    try {
      await withDestroyedClient(async (client) => {
        expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
        await client.query(`SELECT pg_advisory_unlock_shared(${K1}, ${plan.key.key2})`)
        await intruder.query(`SELECT pg_advisory_lock(${K1}, ${plan.key.key2})`)
        expect(await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)).toEqual({ kind: 'uncertain', reason: 's2-regrant-failed' })
      })
    } finally {
      await intruder.query(`SELECT pg_advisory_unlock(${K1}, ${plan.key.key2})`)
      intruder.release(DESTROY)
    }
  })

  it('a lost S1 result is uncertain; the locks it really took vanish only when the backend is destroyed', async () => {
    const plan = canonicalPlan()
    await withDestroyedClient(async (client, pid) => {
      const outcome = await runSettlementCoordinationS1V1(losingResults(client, () => true), plan)
      expect(outcome.kind === 'uncertain' && outcome.reason).toBe('s1-statement-failed')
      const held = await advisoryLocksOf(observer, pid)
      expect(held.some((row) => isDedicatedLock(row, plan.key.key2) && row.granted)).toBe(true)
      expect(held.some((row) => isBigintLock(row, plan.classZeroKey as bigint) && row.granted)).toBe(true)
    })
  })

  it('control: after a lost result, a normal release hands the next checkout a backend that still holds the locks', async () => {
    const single = new Pool({ connectionString: dbUrl, max: 1 })
    const plan = canonicalPlan()
    try {
      const first = await single.connect()
      const pid = await backendPid(first)
      let outcomeKind: string
      try {
        outcomeKind = (await runSettlementCoordinationS1V1(losingResults(first, () => true), plan)).kind
      } finally {
        first.release() // the forbidden mutation: no err, so the pool keeps the backend
      }
      expect(outcomeKind).toBe('uncertain')
      const second = await single.connect()
      try {
        expect(await backendPid(second)).toBe(pid)
        const held = await advisoryLocksOf(observer, pid)
        expect(held.some((row) => isDedicatedLock(row, plan.key.key2))).toBe(true)
      } finally {
        await second.query(`SELECT pg_advisory_unlock_shared(${K1}, ${plan.key.key2})`)
        await second.query(`SELECT pg_advisory_unlock_shared(${(plan.classZeroKey as bigint).toString()}::bigint)`)
        second.release()
      }
    } finally {
      await single.end()
    }
  })

  it('a lost cleanup-unlock result is uncertain and destroying the connection releases everything', async () => {
    const plan = canonicalPlan()
    await withDestroyedClient(async (client) => {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const outcome = await releaseSettlementCoordinationSessionLocksV1(failing(client, () => new Error('test: unlock lost')), plan)
      expect(outcome.kind === 'uncertain' && outcome.reason).toBe('unlock-statement-failed')
    })
  })

  it('BEGIN failing after S1 is uncertain (the session holds are dropped with the backend)', async () => {
    const plan = canonicalPlan()
    await withDestroyedClient(async (client) => {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const outcome = await runSettlementCoordinationHandoverV1(
        failing(client, (sql) => (sql.startsWith('BEGIN') ? new Error('test: begin lost') : null)),
        plan,
        HANDOVER,
      )
      expect(outcome.kind === 'uncertain' && outcome.reason).toBe('begin-failed')
    })
  })

  it('a failed ROLLBACK is uncertain', async () => {
    const plan = canonicalPlan()
    await withDestroyedClient(async (client) => {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const handover = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
      if (handover.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(handover)}`)
      const undo = failOn(client, (sql) => (sql === 'ROLLBACK' ? new Error('test: rollback lost') : null))
      const outcome = await rollbackSettlementCoordinationTransactionV1(client, handover.credential)
      undo()
      expect(outcome.kind === 'uncertain' && outcome.reason).toBe('rollback-failed')
      // Invalidated before ROLLBACK was sent, so a failed ROLLBACK cannot leave it live.
      expect(verifySettlementCoordinationCredentialV1(client, handover.credential, plan.key.org.lexical, { needsClassZero: true })).toBe(false)
    })
  })

  it('COMMIT failing with anything but 40001 / 40P01 is uncertain', async () => {
    const plan = canonicalPlan()
    await withDestroyedClient(async (client) => {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const handover = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
      if (handover.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(handover)}`)
      const ambiguous = Object.assign(new Error('test: commit outcome unknown'), { code: '08006' })
      const undo = failOn(client, (sql) => (sql === 'COMMIT' ? ambiguous : null))
      const outcome = await commitSettlementCoordinationTransactionV1(client, handover.credential)
      undo()
      expect(outcome).toEqual({ kind: 'uncertain', reason: 'commit-failed', error: ambiguous })
      // Invalidated before COMMIT was sent, so an unknown COMMIT outcome cannot leave it live.
      expect(verifySettlementCoordinationCredentialV1(client, handover.credential, plan.key.org.lexical, { needsClassZero: true })).toBe(false)
    })
  })

  it('COMMIT of a transaction that already failed is uncertain: PostgreSQL answers ROLLBACK, not an error', async () => {
    const plan = canonicalPlan()
    await withDestroyedClient(async (client, pid) => {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const handover = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
      if (handover.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(handover)}`)
      // The body swallows an error inside the transaction and carries on to COMMIT.
      await expect(client.query('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' })
      const outcome = await commitSettlementCoordinationTransactionV1(client, handover.credential)
      expect(outcome).toMatchObject({ kind: 'uncertain', reason: 'commit-not-committed' })
      expect((outcome as { error?: { command?: unknown } }).error?.command).toBe('ROLLBACK')
      expect(verifySettlementCoordinationCredentialV1(client, handover.credential, plan.key.org.lexical, { needsClassZero: true })).toBe(false)
      // The server did roll back: idle, nothing held. The contract still destroys the connection.
      const state = await client.query('SELECT now() = statement_timestamp() AS idle')
      expect(state.rows[0].idle).toBe(true)
      expect(await advisoryLocksOf(observer, pid)).toEqual([])
    })
  })

  it('a real serialization failure at COMMIT is retryable and leaves an idle connection', async () => {
    const plan = planSettlementCoordinationV1(crypto.randomUUID(), { needsClassZero: false })
    const schema = `p11_coord_ssi_${crypto.randomUUID().slice(0, 8)}`
    await observer.query(`CREATE SCHEMA ${schema}`)
    await observer.query(`CREATE TABLE ${schema}.t (id int PRIMARY KEY, v int NOT NULL)`)
    await observer.query(`INSERT INTO ${schema}.t VALUES (1, 0), (2, 0)`)
    const client = await pool.connect()
    const rival = await pool.connect()
    try {
      const pid = await backendPid(client)
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const handover = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
      if (handover.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(handover)}`)
      // Classic write skew: each transaction reads the other's row and writes its own.
      await rival.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await client.query(`SELECT v FROM ${schema}.t WHERE id = 2`)
      await rival.query(`SELECT v FROM ${schema}.t WHERE id = 1`)
      await client.query(`UPDATE ${schema}.t SET v = 1 WHERE id = 1`)
      await rival.query(`UPDATE ${schema}.t SET v = 1 WHERE id = 2`)
      await rival.query('COMMIT')
      const outcome = await commitSettlementCoordinationTransactionV1(client, handover.credential)
      expect(outcome.kind).toBe('retryable')
      expect(outcome.kind === 'retryable' && (outcome.error as { code?: string }).code).toBe('40001')
      expect(verifySettlementCoordinationCredentialV1(client, handover.credential, plan.key.org.lexical, { needsClassZero: false })).toBe(false)
      const state = await client.query('SELECT now() = statement_timestamp() AS idle')
      expect(state.rows[0].idle).toBe(true)
      expect(await advisoryLocksOf(observer, pid)).toEqual([])
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await rival.query('ROLLBACK').catch(() => undefined)
      client.release(DESTROY)
      rival.release(DESTROY)
      await observer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
  })
})
