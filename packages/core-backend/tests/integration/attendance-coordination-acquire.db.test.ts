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
 *    that fails during a restart destroys the backend and the next attempt borrows another one;
 *  - an S1 that answers after the budget is spent hands nothing over: its session locks are unlocked
 *    on the same backend, which goes back to the pool idle;
 *  - a restart that calls a still-open transaction "ended" destroys the backend; a backend terminated
 *    behind a handed-over transaction is destroyed by `end(err)`; real class-00 contention holds up
 *    only the units that need class-00; a single uncontended handover is counted, not logged.
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
  planSettlementCoordinationV1,
} from '../../src/attendance/coordination/settlement-coordination-handover'
import { SETTLEMENT_COORDINATION_KEY1, buildSettlementCoordinationKeyV1 } from '../../src/attendance/coordination/settlement-coordination-key'
import {
  SettlementCoordinationAcquireError,
  createSettlementCoordinatorV1,
  shouldLogSettlementCoordinationAttemptV1,
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
        // At most the prober holds resources at any moment; the others wait empty-handed. This relies
        // on a local connect being far faster than the 400 ms takeover: a prober that stays silent
        // longer than that is taken over by design, which a slow pool would show as a second holder.
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
      await unit.restart(first, { reason: 'serialization', transaction: 'ended', commit: committed })
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

  it('an S1 that answers after the budget is spent hands nothing over: its session locks are unlocked on the same backend, which goes back idle', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 1 })
    const records: SettlementCoordinationAttemptRecordV1[] = []
    const sent: string[] = []
    const slowS1: SettlementCoordinationPoolV1 = {
      connect: async () => {
        const client = await pool.connect()
        const realQuery = client.query.bind(client) as (text: string, params?: unknown[]) => Promise<unknown>
        Object.defineProperty(client, 'query', {
          configurable: true,
          writable: true,
          value: async (text: string, params?: unknown[]) => {
            sent.push(text)
            const result = await realQuery(text, params)
            // S1 has taken its session locks; its answer arrives after the budget is spent.
            if (text.startsWith('SELECT idle')) await new Promise((resolve) => setTimeout(resolve, 1200))
            return result
          },
        })
        return client
      },
    }
    const coordinator = createSettlementCoordinatorV1({
      pool: slowS1,
      capacity: deriveSettlementCoordinationCapacityV1({ poolMax: 20 }),
      connectTimeoutMs: 10_000,
      onAttempt: (record) => records.push(record),
    })
    try {
      const unit = coordinator.openUnit({ ...REQUEST, budgetMs: 1000 })
      await expect(unit.acquire(crypto.randomUUID())).rejects.toMatchObject({ code: 'ATTENDANCE_SETTLEMENT_COORDINATION_BUSY' })
      unit.close()
      expectBaseline(coordinator)
      expect(records[0].events.map((event) => event.kind)).toEqual(['quota', 'connect', 's1', 'unlocked', 'released'])
      expect(sent.some((text) => text.startsWith('BEGIN'))).toBe(false)
      expect(pool.totalCount).toBe(1)
      expect(pool.idleCount).toBe(1)
      const reused = await pool.connect()
      try {
        const pid = await backendPid(reused)
        expect(await advisoryLocksOf(observer, pid)).toEqual([])
        const state = await observer.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid])
        expect(state.rows[0]?.state).toBe('idle')
      } finally {
        reused.release(DESTROY)
      }
    } finally {
      await pool.end()
    }
  })

  it('a restart that calls a still-open transaction "ended" is refused and destroys the backend, so no open transaction reaches the pool', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 1 })
    const coordinator = coordinatorOn(pool)
    try {
      const unit = coordinator.openUnit(REQUEST)
      const org = crypto.randomUUID()
      const first = await unit.acquire(org)
      const pid = await backendPid(first.client as PoolClient)
      const claimed = { kind: 'retryable' as const, error: Object.assign(new Error('test: claimed 40001'), { code: '40001' }) }
      await expect(unit.restart(first, { reason: 'serialization', transaction: 'ended', commit: claimed })).rejects.toMatchObject({
        code: 'ATTENDANCE_COORDINATION_RESTART_REFUSED',
      })
      expect(await waitForBackendGone(observer, pid)).toBe(true)
      expect(await advisoryLocksOf(observer, pid)).toEqual([])
      const second = await unit.acquire(org)
      expect(await backendPid(second.client as PoolClient)).not.toBe(pid)
      expect(await commitSettlementCoordinationTransactionV1(second.client, second.credential)).toEqual({ kind: 'committed' })
      second.end()
      unit.close()
      expectBaseline(coordinator)
    } finally {
      await pool.end()
    }
  })

  it('a backend terminated behind a handed-over transaction: end(err) destroys it, nothing leaks, and the next attempt gets another backend', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 2 })
    const coordinator = coordinatorOn(pool)
    try {
      const unit = coordinator.openUnit(REQUEST)
      const org = crypto.randomUUID()
      const first = await unit.acquire(org)
      const client = first.client as PoolClient
      const pid = await backendPid(client)
      client.on('error', () => undefined)
      await observer.query('SELECT pg_terminate_backend($1)', [pid])
      expect(await waitForBackendGone(observer, pid)).toBe(true)
      await expect(client.query('SELECT 1')).rejects.toBeDefined()
      first.end(new Error('test: backend terminated'))
      const second = await unit.acquire(org)
      expect(await backendPid(second.client as PoolClient)).not.toBe(pid)
      expect(await commitSettlementCoordinationTransactionV1(second.client, second.credential)).toEqual({ kind: 'committed' })
      second.end()
      unit.close()
      expectBaseline(coordinator)
      expect(pool.totalCount).toBe(1)
      expect(pool.idleCount).toBe(1)
    } finally {
      await pool.end()
    }
  })

  it('real class-00 contention: the prober backs off on class-00, a dedicated-only unit of the org goes through, and everyone gets through once class-00 is free', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 6 })
    const records: SettlementCoordinationAttemptRecordV1[] = []
    const coordinator = coordinatorOn(pool, records)
    const holder = await observer.connect()
    const org = crypto.randomUUID()
    const classZeroKey = planSettlementCoordinationV1(org, { needsClassZero: true }).classZeroKey as bigint
    const label = (entryLabel: string) => ({ ...REQUEST.handover, entryLabel })
    try {
      await holder.query(`SELECT pg_advisory_lock(${classZeroKey.toString()}::bigint)`)
      const both = coordinator.openUnit({ ...REQUEST, handover: label('test.both'), budgetMs: 4000 })
      const acquiringBoth = both.acquire(org)
      for (let i = 0; i < 100 && coordinator.deps.prober.snapshot().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(coordinator.deps.prober.snapshot()).toEqual([{ org, family: 'class-00', epoch: 1, waiting: 0 }])
      const dedicatedOnly = coordinator.openUnit({ ...REQUEST, needsClassZero: false, handover: label('test.dedicated-only') })
      const handle = await dedicatedOnly.acquire(org)
      expect(await commitSettlementCoordinationTransactionV1(handle.client, handle.credential)).toEqual({ kind: 'committed' })
      handle.end()
      dedicatedOnly.close()
      const alsoBoth = coordinator.openUnit({ ...REQUEST, handover: label('test.also-both'), budgetMs: 4000 })
      const acquiringAlso = alsoBoth.acquire(org)
      for (let i = 0; i < 100 && coordinator.deps.prober.snapshot()[0]?.waiting !== 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(coordinator.deps.prober.snapshot()).toEqual([{ org, family: 'class-00', epoch: 1, waiting: 1 }])
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        expect(coordinator.deps.ledger.snapshot().holding.length).toBeLessThanOrEqual(1)
        expect(coordinator.deps.quota.snapshot().global.short.held).toBeLessThanOrEqual(1)
      }
      await holder.query(`SELECT pg_advisory_unlock(${classZeroKey.toString()}::bigint)`)
      const handles = await Promise.all([acquiringBoth, acquiringAlso])
      for (const acquired of handles) {
        expect(await commitSettlementCoordinationTransactionV1(acquired.client, acquired.credential)).toEqual({ kind: 'committed' })
        acquired.end()
      }
      both.close()
      alsoBoth.close()
      expectBaseline(coordinator)
      expect(coordinator.deps.prober.snapshot()).toEqual([])
      const tries = (entryLabel: string) =>
        records
          .filter((record) => record.entryLabel === entryLabel)
          .flatMap((record) => record.events.filter((event) => event.kind === 's1').map((event) => `${String(event.detail?.kind)}:${String(event.detail?.family ?? '')}`))
      expect(tries('test.both')[0]).toBe('contended:class-00')
      expect(tries('test.both').at(-1)).toBe('acquired:')
      expect(tries('test.dedicated-only')).toEqual(['acquired:'])
      expect(tries('test.also-both')).toEqual(['acquired:'])
    } finally {
      holder.release(DESTROY)
      await pool.end()
    }
  })

  it('a single uncontended handover is counted, not logged (§3.2 step 10)', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 4 })
    const records: SettlementCoordinationAttemptRecordV1[] = []
    const coordinator = coordinatorOn(pool, records)
    try {
      const unit = coordinator.openUnit(REQUEST)
      const handle = await unit.acquire(crypto.randomUUID())
      expect(await commitSettlementCoordinationTransactionV1(handle.client, handle.credential)).toEqual({ kind: 'committed' })
      handle.end()
      unit.close()
      expect(records).toHaveLength(1)
      // The real clock spends the round trips from the budget, but none of them is a wait worth a line.
      expect(unit.budget.spentMs).toBeGreaterThan(0)
      expect(shouldLogSettlementCoordinationAttemptV1(records[0])).toBe(false)
      expectBaseline(coordinator)
    } finally {
      await pool.end()
    }
  })
})
