/**
 * Attendance settlement coordination — the coordinator against a real PostgreSQL and a real
 * `pg.Pool` (P1-1 acceptance A07 / A08 / A09, S2 legs).
 *
 *  - an acquisition hands over an open SERIALIZABLE transaction holding both families at
 *    transaction level, and ending it leaves no lock, no quota and an idle pool connection;
 *  - under real contention (an exclusive holder of the dedicated key) only one unit of the org
 *    tries; the others hold neither quota nor connections, and all of them get through once the
 *    holder lets go;
 *  - a connect that loses its race on a saturated pool keeps its quota until the pool hands it a
 *    client, which the coordinator releases at once — pool and quota both return to baseline;
 *  - a real serialization failure at COMMIT restarts without a ROLLBACK and re-acquires; a ROLLBACK
 *    that fails during a restart destroys the backend and the next attempt borrows another one.
 *
 * Observations go through a separate pool; every borrowed connection is destroyed at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import { deriveSettlementCoordinationCapacityV1 } from '../../src/attendance/coordination/settlement-coordination-capacity'
import {
  AttendanceCoordinationConnectionUncertainError,
  commitSettlementCoordinationTransactionV1,
} from '../../src/attendance/coordination/settlement-coordination-handover'
import { SETTLEMENT_COORDINATION_KEY1, buildSettlementCoordinationKeyV1 } from '../../src/attendance/coordination/settlement-coordination-key'
import {
  SettlementCoordinationAcquireError,
  createSettlementCoordinatorV1,
  type SettlementCoordinationAttemptRecordV1,
  type SettlementCoordinationPoolV1,
  type SettlementCoordinationUnitRequestV1,
  type SettlementCoordinatorV1,
} from '../../src/attendance/coordination/settlement-coordinator'
import { advisoryLocksOf, backendPid, isBigintLock, isDedicatedLock, waitForBackendGone } from '../helpers/settlement-coordination-db'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have a database URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

const K1 = SETTLEMENT_COORDINATION_KEY1
const DESTROY = new Error('test: never hand a test connection to the next test')
const REQUEST: SettlementCoordinationUnitRequestV1 = {
  needsClassZero: true,
  quotaClass: 'short',
  handover: { isolation: 'SERIALIZABLE', timeouts: { kind: 'none' }, entryLabel: 'test.acquire' },
}

function asCoordinationPool(pool: Pool): SettlementCoordinationPoolV1 {
  return { connect: () => pool.connect() }
}

describeIfDatabase('attendance settlement coordination — coordinator on a real pool (real database)', () => {
  let observer: Pool

  beforeAll(() => {
    observer = new Pool({ connectionString: dbUrl, max: 2 })
  })

  afterAll(async () => {
    await observer.end()
  })

  function coordinatorOn(pool: Pool, records: SettlementCoordinationAttemptRecordV1[] = [], connectTimeoutMs = 10_000): SettlementCoordinatorV1 {
    return createSettlementCoordinatorV1({
      pool: asCoordinationPool(pool),
      capacity: deriveSettlementCoordinationCapacityV1({ poolMax: 20 }),
      connectTimeoutMs,
      onAttempt: (record) => records.push(record),
    })
  }

  function expectBaseline(coordinator: SettlementCoordinatorV1): void {
    const { quota, ledger } = coordinator.deps
    expect(quota.snapshot()).toEqual({ global: { short: { held: 0, waiting: 0 }, long: { held: 0, waiting: 0 } }, orgs: [] })
    expect(ledger.snapshot().holding).toEqual([])
    expect(ledger.snapshot().abandoned).toEqual({ short: 0, long: 0 })
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
  }

  it('hands over an open SERIALIZABLE transaction holding both families, and ending it leaves nothing behind', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 4 })
    const coordinator = coordinatorOn(pool)
    try {
      const unit = coordinator.openUnit(REQUEST)
      const handle = await unit.acquire(crypto.randomUUID())
      const pid = await backendPid(handle.client as PoolClient)
      const isolation = await handle.client.query("SELECT current_setting('transaction_isolation') AS level, now() <> statement_timestamp() AS open")
      expect(isolation.rows[0]).toEqual({ level: 'serializable', open: true })
      const held = await advisoryLocksOf(observer, pid)
      expect(held.some((row) => isDedicatedLock(row, handle.plan.key.key2) && row.granted)).toBe(true)
      expect(held.some((row) => isBigintLock(row, handle.plan.classZeroKey as bigint) && row.granted)).toBe(true)
      expect(await commitSettlementCoordinationTransactionV1(handle.client, handle.credential)).toEqual({ kind: 'committed' })
      handle.end()
      unit.close()
      expect(await advisoryLocksOf(observer, pid)).toEqual([])
      expectBaseline(coordinator)
      expect(pool.idleCount).toBe(pool.totalCount)
    } finally {
      await pool.end()
    }
  })

  it('under real contention only the prober tries; units arriving later hold nothing until the holder lets go', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 6 })
    const records: SettlementCoordinationAttemptRecordV1[] = []
    const coordinator = coordinatorOn(pool, records)
    const holder = await observer.connect()
    const org = crypto.randomUUID()
    const key2 = buildSettlementCoordinationKeyV1(org).key2
    const label = (i: number) => ({ ...REQUEST.handover, entryLabel: `test.u${i}` })
    try {
      await holder.query(`SELECT pg_advisory_lock(${K1}, ${key2})`)
      const first = coordinator.openUnit({ ...REQUEST, handover: label(1), budgetMs: 4000 })
      const acquiringFirst = first.acquire(org)
      for (let i = 0; i < 50 && coordinator.deps.prober.snapshot().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(coordinator.deps.prober.snapshot()).toEqual([{ org, family: 'dedicated', epoch: 1, waiting: 0 }])
      const later = [2, 3, 4].map((i) => coordinator.openUnit({ ...REQUEST, handover: label(i), budgetMs: 4000 }))
      const acquiringLater = later.map((unit) => unit.acquire(org))
      for (let i = 0; i < 6; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        // At most the prober holds resources at any moment; the others wait empty-handed.
        expect(coordinator.deps.ledger.snapshot().holding.length).toBeLessThanOrEqual(1)
        expect(coordinator.deps.quota.snapshot().global.short.held).toBeLessThanOrEqual(1)
      }
      expect(coordinator.deps.prober.snapshot()).toEqual([{ org, family: 'dedicated', epoch: 1, waiting: 3 }])
      await holder.query(`SELECT pg_advisory_unlock(${K1}, ${key2})`)
      const handles = await Promise.all([acquiringFirst, ...acquiringLater])
      for (const handle of handles) {
        expect(await commitSettlementCoordinationTransactionV1(handle.client, handle.credential)).toEqual({ kind: 'committed' })
        handle.end()
      }
      for (const unit of [first, ...later]) unit.close()
      expectBaseline(coordinator)
      const tries = (entryLabel: string) =>
        records.filter((record) => record.entryLabel === entryLabel).flatMap((record) => record.events.filter((event) => event.kind === 's1').map((event) => event.detail?.kind))
      expect(tries('test.u1')[0]).toBe('contended')
      expect(tries('test.u1').at(-1)).toBe('acquired')
      for (const i of [2, 3, 4]) expect(tries(`test.u${i}`)).toEqual(['acquired'])
    } finally {
      holder.release(DESTROY)
      await pool.end()
    }
  })

  it('a connect that loses its race on a full pool keeps its quota until the pool hands it a client, then both return', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 1 })
    const coordinator = coordinatorOn(pool, [], 10_000)
    const blocker = await pool.connect()
    try {
      const unit = coordinator.openUnit({ ...REQUEST, budgetMs: 300 })
      await expect(unit.acquire(crypto.randomUUID())).rejects.toMatchObject({ code: 'ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE' })
      expect(coordinator.deps.quota.snapshot().global.short.held).toBe(1)
      expect(coordinator.deps.ledger.snapshot().abandoned.short).toBe(1)
      expect(pool.waitingCount).toBe(1)
      blocker.release()
      for (let i = 0; i < 50 && coordinator.deps.ledger.snapshot().abandoned.short > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
      unit.close()
      expectBaseline(coordinator)
      expect(pool.waitingCount).toBe(0)
      expect(pool.idleCount).toBe(1)
      expect(pool.totalCount).toBe(1)
    } finally {
      await pool.end()
    }
  })

  it('a real serialization failure at COMMIT restarts without a ROLLBACK and the unit gets through on its next attempt', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 4 })
    const coordinator = coordinatorOn(pool)
    const schema = `p11_coord_acq_${crypto.randomUUID().slice(0, 8)}`
    await observer.query(`CREATE SCHEMA ${schema}`)
    await observer.query(`CREATE TABLE ${schema}.t (id int PRIMARY KEY, v int NOT NULL)`)
    await observer.query(`INSERT INTO ${schema}.t VALUES (1, 0), (2, 0)`)
    const rival = await observer.connect()
    try {
      const unit = coordinator.openUnit({ ...REQUEST, needsClassZero: false })
      const org = `legacy-${crypto.randomUUID()}`
      const first = await unit.acquire(org)
      await rival.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await first.client.query(`SELECT v FROM ${schema}.t WHERE id = 2`)
      await rival.query(`SELECT v FROM ${schema}.t WHERE id = 1`)
      await first.client.query(`UPDATE ${schema}.t SET v = 1 WHERE id = 1`)
      await rival.query(`UPDATE ${schema}.t SET v = 1 WHERE id = 2`)
      await rival.query('COMMIT')
      const committed = await commitSettlementCoordinationTransactionV1(first.client, first.credential)
      expect(committed.kind).toBe('retryable')
      const sql: string[] = []
      const realQuery = first.client.query.bind(first.client) as (text: string) => Promise<unknown>
      Object.defineProperty(first.client, 'query', { configurable: true, writable: true, value: (text: string) => (sql.push(text), realQuery(text)) })
      await unit.restart(first, { reason: 'serialization', transaction: 'ended', error: (committed as { error: unknown }).error })
      expect(sql).toEqual([])
      const second = await unit.acquire(org)
      await second.client.query(`UPDATE ${schema}.t SET v = 2 WHERE id = 1`)
      expect(await commitSettlementCoordinationTransactionV1(second.client, second.credential)).toEqual({ kind: 'committed' })
      second.end()
      unit.close()
      expectBaseline(coordinator)
      expect((await observer.query(`SELECT v FROM ${schema}.t WHERE id = 1`)).rows[0].v).toBe(2)
    } finally {
      await rival.query('ROLLBACK').catch(() => undefined)
      rival.release(DESTROY)
      await observer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await pool.end()
    }
  })

  it('a ROLLBACK that fails during a restart destroys the backend, and the next attempt borrows another one', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 4 })
    const coordinator = coordinatorOn(pool)
    try {
      const unit = coordinator.openUnit(REQUEST)
      const org = crypto.randomUUID()
      const first = await unit.acquire(org)
      const oldPid = await backendPid(first.client as PoolClient)
      const realQuery = first.client.query.bind(first.client) as (text: string, params?: unknown[]) => Promise<unknown>
      Object.defineProperty(first.client, 'query', {
        configurable: true,
        writable: true,
        value: (text: string, params?: unknown[]) =>
          text === 'ROLLBACK' ? Promise.reject(Object.assign(new Error('test: rollback lost'), { code: '08006' })) : realQuery(text, params),
      })
      const serialization = Object.assign(new Error('could not serialize access'), { code: '40001' })
      await unit.restart(first, { reason: 'serialization', transaction: 'live', error: serialization })
      expect(await waitForBackendGone(observer, oldPid)).toBe(true)
      expect(await advisoryLocksOf(observer, oldPid)).toEqual([])
      const second = await unit.acquire(org)
      expect(await backendPid(second.client as PoolClient)).not.toBe(oldPid)
      second.end(DESTROY)
      unit.close()
      expectBaseline(coordinator)
    } finally {
      await pool.end()
    }
  })

  it('an uncertain acquisition never hands the backend back to the pool', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 1 })
    const coordinator = coordinatorOn(pool)
    try {
      const outer = await pool.connect()
      const pid = await backendPid(outer)
      // Leave the connection inside an open transaction: S1's idle proof fails on it.
      await outer.query('BEGIN')
      await outer.query('SELECT 1')
      outer.release()
      const unit = coordinator.openUnit(REQUEST)
      await expect(unit.acquire(crypto.randomUUID())).rejects.toBeInstanceOf(AttendanceCoordinationConnectionUncertainError)
      unit.close()
      expect(await waitForBackendGone(observer, pid)).toBe(true)
      expectBaseline(coordinator)
      const next = await pool.connect()
      expect(await backendPid(next)).not.toBe(pid)
      next.release(DESTROY)
    } finally {
      await pool.end()
    }
  })

  it('budget exhaustion while queued behind the prober fails with the dedicated family code and holds nothing', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 4 })
    const coordinator = coordinatorOn(pool)
    const holder = await observer.connect()
    const org = crypto.randomUUID()
    const key2 = buildSettlementCoordinationKeyV1(org).key2
    try {
      await holder.query(`SELECT pg_advisory_lock(${K1}, ${key2})`)
      const units = [coordinator.openUnit({ ...REQUEST, budgetMs: 400 }), coordinator.openUnit({ ...REQUEST, budgetMs: 400 })]
      const results = await Promise.allSettled(units.map((unit) => unit.acquire(org)))
      for (const result of results) {
        expect(result.status).toBe('rejected')
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(SettlementCoordinationAcquireError)
        expect(((result as PromiseRejectedResult).reason as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_SETTLEMENT_COORDINATION_BUSY')
      }
      for (const unit of units) unit.close()
      expectBaseline(coordinator)
      expect(coordinator.deps.prober.snapshot()).toEqual([])
    } finally {
      // The holder's backend is destroyed, which drops its exclusive hold.
      holder.release(DESTROY)
      await pool.end()
    }
  })
})
