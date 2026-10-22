/**
 * Attendance settlement coordination — the coordinated-transaction port on a real PostgreSQL and a
 * real `pg.Pool` (P1-1 acceptance A10 lifecycle and A07 retry ownership, S3 legs).
 *
 *  - a committed body's write persists; the backend goes back idle and holds nothing; post-commit
 *    callbacks run after release, outside the coordination context, and can borrow from the pool;
 *  - a business error rolls back: nothing persists and the backend is idle;
 *  - a real serialization failure inside the handed-over runner restarts the unit, and the second
 *    attempt commits on another try; a real serialization failure at COMMIT restarts too, without a
 *    ROLLBACK;
 *  - inside the coordinated transaction the class-00 helper sends nothing while the backend holds
 *    class-00 at transaction level;
 *  - a backend terminated inside the body makes the COMMIT uncertain: the connection is destroyed,
 *    no callback runs and the COMMIT error reaches the caller.
 *
 * Observations go through a separate pool; borrowed test connections are destroyed at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import { deriveSettlementCoordinationCapacityV1 } from '../../src/attendance/coordination/settlement-coordination-capacity'
import { currentSettlementCoordinationContextV1 } from '../../src/attendance/coordination/settlement-coordination-context'
import { planSettlementCoordinationV1 } from '../../src/attendance/coordination/settlement-coordination-handover'
import { coordinatedTransactionV1 } from '../../src/attendance/coordination/settlement-coordination-port'
import {
  createSettlementCoordinatorV1,
  type SettlementCoordinationUnitRequestV1,
  type SettlementCoordinatorV1,
} from '../../src/attendance/coordination/settlement-coordinator'
import { runAttendanceResultOperationHandedOverV1 } from '../../src/attendance/w4c0-operation-registry'
import { acquireAttendanceCalculationRolloutLock, parseCanonicalAttendanceRolloutOrgKeyV1 } from '../../src/attendance/w4c0-identity'
import { advisoryLocksOf, backendPid, isBigintLock, waitForBackendGone } from '../helpers/settlement-coordination-db'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have a database URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

const DESTROY = new Error('test: never hand a test connection to the next test')
const REQUEST: SettlementCoordinationUnitRequestV1 = {
  needsClassZero: true,
  quotaClass: 'short',
  handover: { isolation: 'SERIALIZABLE', timeouts: { kind: 'w4-runner' }, entryLabel: 'test.port' },
}

describeIfDatabase('attendance settlement coordination — the coordinated-transaction port (real database)', () => {
  let observer: Pool
  let schema: string

  beforeAll(async () => {
    observer = new Pool({ connectionString: dbUrl, max: 2 })
    schema = `p11_coord_port_${crypto.randomUUID().slice(0, 8)}`
    await observer.query(`CREATE SCHEMA ${schema}`)
    await observer.query(`CREATE TABLE ${schema}.t (id int PRIMARY KEY, v int NOT NULL)`)
  })

  afterAll(async () => {
    await observer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await observer.end()
  })

  function coordinatorOn(pool: Pool): SettlementCoordinatorV1 {
    return createSettlementCoordinatorV1({
      pool: { connect: () => pool.connect() },
      capacity: deriveSettlementCoordinationCapacityV1({ poolMax: 20 }),
      connectTimeoutMs: 10_000,
    })
  }

  function expectBaseline(coordinator: SettlementCoordinatorV1): void {
    const { quota, ledger } = coordinator.deps
    expect(quota.snapshot()).toEqual({ global: { short: { held: 0, waiting: 0 }, long: { held: 0, waiting: 0 } }, orgs: [] })
    expect(ledger.snapshot().holding).toEqual([])
    expect(ledger.snapshot().inFlight).toEqual({ short: 0, long: 0 })
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
  }

  async function reset(rows: Array<[number, number]>): Promise<void> {
    await observer.query(`TRUNCATE ${schema}.t`)
    for (const [id, v] of rows) await observer.query(`INSERT INTO ${schema}.t VALUES ($1, $2)`, [id, v])
  }

  async function valueOf(id: number): Promise<number | null> {
    const { rows } = await observer.query(`SELECT v FROM ${schema}.t WHERE id = $1`, [id])
    return rows.length === 0 ? null : Number(rows[0].v)
  }

  it('commits once: the write persists, the backend goes back idle, and callbacks run after release outside the context', async () => {
    await reset([])
    const pool = new Pool({ connectionString: dbUrl, max: 2 })
    const coordinator = coordinatorOn(pool)
    let pid = 0
    const seen: Array<Record<string, unknown>> = []
    // Resolved by the test after the port returned: a promise chained on it INSIDE the body inherits the
    // body's async context, so it must find no live coordination context by then.
    let resume!: () => void
    const resumed = new Promise<void>((resolve) => {
      resume = resolve
    })
    let probe: Promise<unknown> | null = null
    try {
      const result = await coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: crypto.randomUUID() },
        body: async (context) => {
          pid = await backendPid(context.client as PoolClient)
          await context.client.query(`INSERT INTO ${schema}.t VALUES (1, 1)`)
          probe = resumed.then(() => currentSettlementCoordinationContextV1())
          context.afterCommit(async () => {
            const state = await observer.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid])
            const borrowed = await pool.query('SELECT 1 AS one')
            seen.push({
              context: currentSettlementCoordinationContextV1(),
              held: coordinator.deps.quota.snapshot().global.short.held,
              state: state.rows[0]?.state ?? null,
              locks: (await advisoryLocksOf(observer, pid)).length,
              borrowed: borrowed.rows[0].one,
            })
          })
          return 'committed'
        },
      })
      expect(result).toBe('committed')
      expect(await valueOf(1)).toBe(1)
      expect(seen).toEqual([{ context: null, held: 0, state: 'idle', locks: 0, borrowed: 1 }])
      resume()
      expect(await probe).toBeNull()
      expectBaseline(coordinator)
    } finally {
      await pool.end()
    }
  })

  // ── S5 G2 (A12-P3, A12-M3 / A12-M4): the resources one coordinated transaction holds, at its peak and after ──

  it('resources (A12-P3): inside the body the unit holds exactly one org permit, one global permit and one connection; afterwards nothing', async () => {
    await reset([])
    // Room for a second connection: a double borrow shows up as a second pool client instead of a hang.
    const pool = new Pool({ connectionString: dbUrl, max: 3 })
    const coordinator = coordinatorOn(pool)
    const org = crypto.randomUUID()
    const lexical = planSettlementCoordinationV1(org, { needsClassZero: REQUEST.needsClassZero }).key.org.lexical
    const sample = () => ({
      quota: coordinator.deps.quota.snapshot(),
      ledger: coordinator.deps.ledger.snapshot(),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    })
    const idle = (total: number) => ({
      quota: { global: { short: { held: 0, waiting: 0 }, long: { held: 0, waiting: 0 } }, orgs: [] },
      ledger: { inFlight: { short: 0, long: 0 }, abandoned: { short: 0, long: 0 }, holding: [] },
      pool: { total, idle: total, waiting: 0 },
    })
    const samples: Array<ReturnType<typeof sample>> = []
    try {
      expect(sample()).toEqual(idle(0))
      const result = await coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org },
        transactionDepth: () => 0,
        body: async (context) => {
          samples.push(sample())
          await context.client.query(`INSERT INTO ${schema}.t VALUES (1, 1)`)
          samples.push(sample())
          return context.orgLexical
        },
      })
      expect(result).toBe(lexical)
      // The layout the request asked for (one short unit of one org), and nothing else, at every sample.
      const peak = {
        quota: { global: { short: { held: 1, waiting: 0 }, long: { held: 0, waiting: 0 } }, orgs: [{ org: lexical, quotaClass: 'short', held: 1, waiting: 0 }] },
        ledger: { inFlight: { short: 1, long: 0 }, abandoned: { short: 0, long: 0 }, holding: [{ quotaClass: 'short', lease: true, client: true }] },
        pool: { total: 1, idle: 0, waiting: 0 },
      }
      expect(samples).toEqual([peak, peak])
      // Back to zero: no permit, no unit, the one connection idle in the pool.
      expect(sample()).toEqual(idle(1))
      expect(coordinator.deps.ledger.selfCheck(coordinator.deps.quota.snapshot())).toEqual([])
      expect(await valueOf(1)).toBe(1)
    } finally {
      await pool.end()
    }
  })

  it('a business error rolls back: nothing persists, the backend is idle and holds nothing', async () => {
    await reset([])
    const pool = new Pool({ connectionString: dbUrl, max: 1 })
    const coordinator = coordinatorOn(pool)
    let pid = 0
    const business = Object.assign(new Error('test: business 409'), { status: 409 })
    try {
      await expect(
        coordinatedTransactionV1({
          coordinator,
          request: REQUEST,
          candidate: { org: crypto.randomUUID() },
          body: async (context) => {
            pid = await backendPid(context.client as PoolClient)
            await context.client.query(`INSERT INTO ${schema}.t VALUES (2, 2)`)
            throw business
          },
        }),
      ).rejects.toBe(business)
      expect(await valueOf(2)).toBe(null)
      const state = await observer.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid])
      expect(state.rows[0]?.state).toBe('idle')
      expect(await advisoryLocksOf(observer, pid)).toEqual([])
      expectBaseline(coordinator)
    } finally {
      await pool.end()
    }
  })

  it('a real serialization failure inside the handed-over runner restarts the unit; the second attempt commits', async () => {
    await reset([[1, 0]])
    const pool = new Pool({ connectionString: dbUrl, max: 2 })
    const coordinator = coordinatorOn(pool)
    const rival = await observer.connect()
    let attempts = 0
    try {
      const result = await coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: crypto.randomUUID() },
        body: async (context) =>
          runAttendanceResultOperationHandedOverV1(context.client, async (trx) => {
            attempts += 1
            await trx.query(`SELECT v FROM ${schema}.t WHERE id = 1`)
            // A concurrent update committed after this transaction's snapshot: the update below fails with 40001.
            if (attempts === 1) await rival.query(`UPDATE ${schema}.t SET v = 10 WHERE id = 1`)
            await trx.query(`UPDATE ${schema}.t SET v = v + 1 WHERE id = 1`)
            return attempts
          }),
      })
      expect(result).toBe(2)
      expect(await valueOf(1)).toBe(11)
      expectBaseline(coordinator)
    } finally {
      rival.release(DESTROY)
      await pool.end()
    }
  })

  it('a real serialization failure at COMMIT restarts without a ROLLBACK, and the second attempt commits', async () => {
    await reset([[1, 0], [2, 0]])
    const pool = new Pool({ connectionString: dbUrl, max: 2 })
    const coordinator = coordinatorOn(pool)
    const rival = await observer.connect()
    let attempts = 0
    try {
      const result = await coordinatedTransactionV1({
        coordinator,
        request: { ...REQUEST, needsClassZero: false },
        candidate: { org: `legacy-${crypto.randomUUID()}` },
        body: async (context) => {
          attempts += 1
          if (attempts === 1) {
            await rival.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
            await context.client.query(`SELECT v FROM ${schema}.t WHERE id = 2`)
            await rival.query(`SELECT v FROM ${schema}.t WHERE id = 1`)
            await context.client.query(`UPDATE ${schema}.t SET v = 1 WHERE id = 1`)
            await rival.query(`UPDATE ${schema}.t SET v = 1 WHERE id = 2`)
            await rival.query('COMMIT')
            return attempts
          }
          await context.client.query(`UPDATE ${schema}.t SET v = 2 WHERE id = 1`)
          return attempts
        },
      })
      expect(result).toBe(2)
      expect(await valueOf(1)).toBe(2)
      expectBaseline(coordinator)
    } finally {
      await rival.query('ROLLBACK').catch(() => undefined)
      rival.release(DESTROY)
      await pool.end()
    }
  })

  it('inside the coordinated transaction the class-00 helper sends nothing while the backend holds class-00 at transaction level', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 2 })
    const coordinator = coordinatorOn(pool)
    const org = crypto.randomUUID()
    try {
      await coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org },
        body: async (context) => {
          const client = context.client as PoolClient
          const pid = await backendPid(client)
          const sent: string[] = []
          const realQuery = client.query.bind(client) as (text: string, params?: unknown[]) => Promise<unknown>
          Object.defineProperty(client, 'query', {
            configurable: true,
            writable: true,
            value: (text: string, params?: unknown[]) => (sent.push(text), realQuery(text, params)),
          })
          try {
            await acquireAttendanceCalculationRolloutLock(client, parseCanonicalAttendanceRolloutOrgKeyV1(org), 'shared')
          } finally {
            Object.defineProperty(client, 'query', { configurable: true, writable: true, value: realQuery })
          }
          expect(sent).toEqual([])
          const held = await advisoryLocksOf(observer, pid)
          const classZeroKey = (await import('../../src/attendance/coordination/settlement-coordination-handover')).planSettlementCoordinationV1(org, {
            needsClassZero: true,
          }).classZeroKey as bigint
          expect(held.some((row) => isBigintLock(row, classZeroKey) && row.granted && row.mode === 'ShareLock')).toBe(true)
          return 'covered'
        },
      })
      expectBaseline(coordinator)
    } finally {
      await pool.end()
    }
  })

  it('a backend terminated inside the body: the attempt fails either before COMMIT (the error was heard) or at an uncertain COMMIT; either way the connection is destroyed and no callback runs', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 1 })
    const coordinator = coordinatorOn(pool)
    let pid = 0
    let ran = false
    try {
      const failure = await coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: crypto.randomUUID() },
        body: async (context) => {
          // No error listener of the test's own: the coordinator's listener is what keeps the
          // terminated backend from taking the process down (Codex S3-CX-01).
          const client = context.client as PoolClient
          pid = await backendPid(client)
          await observer.query('SELECT pg_terminate_backend($1)', [pid])
          await waitForBackendGone(observer, pid)
          context.afterCommit(() => {
            ran = true
          })
          return 'never'
        },
      }).then(
        () => null,
        (error) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      expect(ran).toBe(false)
      expectBaseline(coordinator)
      const next = await pool.connect()
      expect(await backendPid(next)).not.toBe(pid)
      next.release(DESTROY)
    } finally {
      await pool.end()
    }
  })
})
