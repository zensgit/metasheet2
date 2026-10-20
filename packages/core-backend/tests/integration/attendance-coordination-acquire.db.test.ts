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
 *    only the units that need class-00; a single uncontended handover is counted, not logged;
 *  - A08 resource legs (Codex A14-P2-02), on a hand-driven coordination clock and a real pool: a long
 *    unit queued on its org's long quota or on the global long quota borrows nothing while it waits,
 *    another org gets through on the remaining global capacity, the short class keeps working while the
 *    long class is saturated, and a background unit's quota wait ends exactly at the 30 s boundary as
 *    capacity busy without borrowing. Each leg ends with pool, server, quota and ledger at baseline.
 *
 * Observations go through a separate pool; every borrowed connection is destroyed at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import { SETTLEMENT_COORDINATION_BACKGROUND_QUOTA_WAIT_MS } from '../../src/attendance/coordination/settlement-coordination-budget'
import { deriveSettlementCoordinationCapacityV1 } from '../../src/attendance/coordination/settlement-coordination-capacity'
import {
  AttendanceCoordinationConnectionUncertainError,
  commitSettlementCoordinationTransactionV1,
  planSettlementCoordinationV1,
} from '../../src/attendance/coordination/settlement-coordination-handover'
import { SETTLEMENT_COORDINATION_KEY1, buildSettlementCoordinationKeyV1 } from '../../src/attendance/coordination/settlement-coordination-key'
import { coordinatedTransactionV1 } from '../../src/attendance/coordination/settlement-coordination-port'
import { buildSettlementCoordinationS1Sql, buildSettlementCoordinationS2Sql } from '../../src/attendance/coordination/settlement-coordination-statements'
import {
  SETTLEMENT_COORDINATION_CAPACITY_BUSY,
  SettlementCoordinationAcquireError,
  createSettlementCoordinatorV1,
  shouldLogSettlementCoordinationAttemptV1,
  type SettlementCoordinationAttemptRecordV1,
  type SettlementCoordinationHandleV1,
  type SettlementCoordinationPoolV1,
  type SettlementCoordinationUnitRequestV1,
  type SettlementCoordinationUnitV1,
  type SettlementCoordinatorV1,
} from '../../src/attendance/coordination/settlement-coordinator'
import { advisoryLocksOf, backendPid, isBigintLock, isDedicatedLock, waitForBackendGone } from '../helpers/settlement-coordination-db'
import { ManualCoordinationClock } from '../helpers/settlement-coordination-manual-clock'

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

interface RecordedBorrow {
  /** Every statement the borrowed connection received, with its bind-value count (never the values). */
  readonly statements: Array<{ text: string; values: number }>
  /** One entry per return to the pool: whether pg was asked to destroy the connection. */
  readonly releases: boolean[]
}

/**
 * Records, per checkout from `pool`, what the connection is sent and how it goes back. The recording
 * `query` is an own property installed at the checkout and removed at the return, so a wrapper never
 * outlives a borrow or stacks on a reused connection (the handover suite's replace-not-stack rule).
 * pg-pool sets the client's `release` after it emits 'acquire', so returns are read from the pool's
 * own 'release' event.
 */
function recordBorrows(pool: Pool): { borrows: RecordedBorrow[]; stop(): void } {
  const borrows: RecordedBorrow[] = []
  const current = new Map<object, RecordedBorrow>()
  const onAcquire = (client: PoolClient): void => {
    const borrow: RecordedBorrow = { statements: [], releases: [] }
    borrows.push(borrow)
    current.set(client, borrow)
    const prototypeQuery = (Object.getPrototypeOf(client) as { query: (...args: unknown[]) => unknown }).query
    Object.defineProperty(client, 'query', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        const first = args[0]
        const text = typeof first === 'string' ? first : String((first as { text?: unknown } | null)?.text ?? first)
        const configValues = typeof first === 'object' && first !== null ? (first as { values?: unknown }).values : undefined
        const values = Array.isArray(configValues) ? configValues.length : Array.isArray(args[1]) ? args[1].length : 0
        borrow.statements.push({ text, values })
        return prototypeQuery.apply(client, args)
      },
    })
  }
  const onRelease = (error: unknown, client: PoolClient): void => {
    const borrow = current.get(client)
    if (!borrow) return
    current.delete(client)
    borrow.releases.push(Boolean(error))
    delete (client as { query?: unknown }).query
  }
  pool.on('acquire', onAcquire)
  pool.on('release', onRelease)
  return {
    borrows,
    stop: () => {
      pool.removeListener('acquire', onAcquire)
      pool.removeListener('release', onRelease)
    },
  }
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

  // ── S5 G2 (A12-P1, A12-M1 / A12-M2): what an uncontended and a contended coordinated transaction send ──

  it('hot path (A12-P1): an uncontended coordinated transaction sends exactly S1, BEGIN, S2, the body and COMMIT over one borrow, returns it once, with one attempt and no restart', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 2 })
    const records: SettlementCoordinationAttemptRecordV1[] = []
    const coordinator = coordinatorOn(pool, records)
    const recorder = recordBorrows(pool)
    const org = crypto.randomUUID()
    const plan = planSettlementCoordinationV1(org, { needsClassZero: REQUEST.needsClassZero })
    const keys = { key2: plan.key.key2, classZeroKey: plan.classZeroKey }
    const attempts: number[] = []
    try {
      // A canonical org with an entry that needs class-00: both families, the full S1 / S2.
      expect(plan.classZeroKey).not.toBeNull()
      const result = await coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org },
        transactionDepth: () => 0,
        body: async (context) => {
          attempts.push(context.attempt)
          await context.client.query('SELECT 1 AS body')
          return 'committed'
        },
      })
      expect(result).toBe('committed')
      // S1 and S2 go over the simple protocol: no bind values on either (appendix E; SNAP pins why).
      expect(recorder.borrows).toEqual([
        {
          statements: [
            { text: buildSettlementCoordinationS1Sql(keys), values: 0 },
            { text: 'BEGIN ISOLATION LEVEL SERIALIZABLE', values: 0 },
            {
              text: buildSettlementCoordinationS2Sql({ ...keys, timeouts: REQUEST.handover.timeouts, entryLabel: REQUEST.handover.entryLabel }),
              values: 0,
            },
            { text: 'SELECT 1 AS body', values: 0 },
            { text: 'COMMIT', values: 0 },
          ],
          releases: [false],
        },
      ])
      expect(attempts).toEqual([1])
      expect(
        records.map((record) => ({
          attempt: record.attempt,
          outcome: record.outcome,
          code: record.code,
          tries: record.events.filter((event) => event.kind === 's1').map((event) => event.detail?.kind),
        })),
      ).toEqual([{ attempt: 1, outcome: 'handed-over', code: null, tries: ['acquired'] }])
      expect(coordinator.deps.stats).toEqual({ attemptObserverFailures: 0, scopeChangedFallbacks: 0 })
      expectBaseline(coordinator)
      expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({ total: 1, idle: 1 })
    } finally {
      recorder.stop()
      await pool.end()
    }
  })

  it('hot path (A12-M2): a try that loses to a holder is retried without repeating the candidate read', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 3 })
    const records: SettlementCoordinationAttemptRecordV1[] = []
    const coordinator = coordinatorOn(pool, records)
    const holder = await observer.connect()
    const org = crypto.randomUUID()
    const key2 = buildSettlementCoordinationKeyV1(org).key2
    let candidateReads = 0
    try {
      await holder.query(`SELECT pg_advisory_lock(${K1}, ${key2})`)
      const running = coordinatedTransactionV1({
        coordinator,
        request: { ...REQUEST, handover: { ...REQUEST.handover, entryLabel: 'test.candidate-once' }, budgetMs: 4000 },
        candidate: {
          read: async (client) => {
            candidateReads += 1
            await client.query('SELECT 1 AS candidate')
            return org
          },
        },
        transactionDepth: () => 0,
        body: async (context) => {
          await context.client.query('SELECT 1 AS body')
          return context.attempt
        },
      })
      // The first try has lost to the holder once the unit is the org's prober.
      for (let i = 0; i < 200 && coordinator.deps.prober.snapshot().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(coordinator.deps.prober.snapshot()).toEqual([{ org, family: 'dedicated', epoch: 1, waiting: 0 }])
      // Long enough for at least one more backoff try (25 ms first step) while the holder still holds.
      await new Promise((resolve) => setTimeout(resolve, 120))
      await holder.query(`SELECT pg_advisory_unlock(${K1}, ${key2})`)
      expect(await running).toBe(1)
      expect(candidateReads).toBe(1)
      const tries = records.flatMap((record) => record.events.filter((event) => event.kind === 's1').map((event) => String(event.detail?.kind)))
      expect(records).toHaveLength(1)
      expect(tries.length).toBeGreaterThanOrEqual(2)
      expect(tries[0]).toBe('contended')
      expect(tries.at(-1)).toBe('acquired')
      expectBaseline(coordinator)
      expect(coordinator.deps.prober.snapshot()).toEqual([])
    } finally {
      holder.release(DESTROY)
      await pool.end()
    }
  })

  // ── A14-P2-02 (A08): long / org / global quotas and the background boundary on a real pool ──
  //
  // The coordinator runs on a hand-driven clock and a real pool: a quota wait ends only when the test
  // moves time (so the 30 s boundary is reached without waiting 30 s), while every connection, S1 / S2
  // and COMMIT goes to the server. "Borrows nothing" is read from the pool itself (cumulative 'acquire'
  // events, connections checked out, the pool's own queue) and from the server (the backends this pool
  // opened, found by their pids), and those facts are asserted before any counter
  // object. Quota snapshots are only used to know when a waiter has queued, and then pinned as a whole.
  // The units do not need class-00, so the only lock a unit takes is its own org's dedicated key: the
  // orgs never contend with each other, and nothing but quota can hold a unit up.

  const A08_LONG: SettlementCoordinationUnitRequestV1 = {
    needsClassZero: false,
    quotaClass: 'long',
    handover: { isolation: 'SERIALIZABLE', timeouts: { kind: 'none' }, entryLabel: 'test.a08.long' },
  }

  function a08Request(entryLabel: string, extra: Partial<SettlementCoordinationUnitRequestV1> = {}): SettlementCoordinationUnitRequestV1 {
    return { ...A08_LONG, ...extra, handover: { ...A08_LONG.handover, entryLabel } }
  }

  function a08Track<T>(promise: Promise<T>): { done: boolean; value?: T; error?: unknown } {
    const box: { done: boolean; value?: T; error?: unknown } = { done: false }
    promise.then(
      (value) => {
        box.done = true
        box.value = value
      },
      (error) => {
        box.done = true
        box.error = error
      },
    )
    return box
  }

  /** Real-time poll; falls through on timeout so the assertion that follows names what is wrong. */
  async function a08WaitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  /** Real time for a waiter to misbehave (borrow, try, give up) if it were going to. */
  function a08Pause(ms = 100): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function a08Setup(max: number) {
    const application = `p11_a08_${crypto.randomUUID().slice(0, 8)}`
    const pool = new Pool({ connectionString: dbUrl, max, application_name: application })
    // The server-side backends of this pool, by pid. Not by application_name: S2 retags the session
    // (`set_config('application_name', 'ms2-coord:<label>', true)`) for the life of the transaction, so a
    // name filter loses a backend exactly while it holds a coordinated transaction.
    const pids = new Set<number>()
    pool.on('connect', (client) => {
      pids.add((client as unknown as { processID: number }).processID)
    })
    const clock = new ManualCoordinationClock()
    const capacity = deriveSettlementCoordinationCapacityV1({ poolMax: 20 })
    const records: SettlementCoordinationAttemptRecordV1[] = []
    const coordinator = createSettlementCoordinatorV1({
      pool: asCoordinationPool(pool),
      capacity,
      connectTimeoutMs: 10_000,
      clock,
      onAttempt: (record) => records.push(record),
    })
    const recorder = recordBorrows(pool)
    const units: SettlementCoordinationUnitV1[] = []
    const live = new Set<SettlementCoordinationHandleV1>()

    const open = (request: SettlementCoordinationUnitRequestV1): SettlementCoordinationUnitV1 => {
      const unit = coordinator.openUnit(request)
      units.push(unit)
      return unit
    }
    const start = (unit: SettlementCoordinationUnitV1, org: string) =>
      a08Track(
        unit.acquire(org).then((handle) => {
          live.add(handle)
          return handle
        }),
      )
    /** An acquisition that must go through without anyone moving the clock. */
    const acquireNow = async (unit: SettlementCoordinationUnitV1, org: string): Promise<SettlementCoordinationHandleV1> => {
      const box = start(unit, org)
      await a08WaitUntil(() => box.done)
      expect({ done: box.done, error: box.error }).toEqual({ done: true, error: undefined })
      return box.value as SettlementCoordinationHandleV1
    }
    const commitAndEnd = async (handle: SettlementCoordinationHandleV1): Promise<void> => {
      expect(await commitSettlementCoordinationTransactionV1(handle.client, handle.credential)).toEqual({ kind: 'committed' })
      live.delete(handle)
      handle.end()
    }
    /** The server's view: the state of every backend this pool opened, sorted. */
    const backends = async (): Promise<string[]> => {
      const { rows } = await observer.query('SELECT state FROM pg_stat_activity WHERE pid = ANY($1::int[]) ORDER BY state', [[...pids]])
      return rows.map((row) => String(row.state))
    }
    /** What the pool and the server show: cumulative checkouts, checked out now, the pool's queue, backend states. */
    const poolFacts = async () => ({
      borrows: recorder.borrows.length,
      checkedOut: pool.totalCount - pool.idleCount,
      poolWaiting: pool.waitingCount,
      backends: await backends(),
    })
    const quotaSnapshot = () => coordinator.deps.quota.snapshot()
    const orgWaiting = (org: string, quotaClass: 'short' | 'long'): number =>
      quotaSnapshot().orgs.find((entry) => entry.org === org && entry.quotaClass === quotaClass)?.waiting ?? 0
    const recordsOf = (entryLabel: string) => records.filter((record) => record.entryLabel === entryLabel)

    /** Leg 4: pool, server and accounting are back where they started. */
    const expectA08Baseline = async (): Promise<void> => {
      expect({ checkedOut: pool.totalCount - pool.idleCount, poolWaiting: pool.waitingCount }).toEqual({ checkedOut: 0, poolWaiting: 0 })
      // Every checkout went back exactly once, and none of them had to be destroyed.
      expect(recorder.borrows.map((borrow) => borrow.releases)).toEqual(recorder.borrows.map(() => [false]))
      expect(await backends()).toEqual(Array.from({ length: pool.totalCount }, () => 'idle'))
      const locks = await observer.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE pid = ANY($1::int[]) AND locktype = 'advisory'",
        [[...pids]],
      )
      expect(locks.rows[0].n).toBe(0)
      expectBaseline(coordinator)
      expect(coordinator.deps.ledger.snapshot()).toEqual({ inFlight: { short: 0, long: 0 }, abandoned: { short: 0, long: 0 }, holding: [] })
      expect(coordinator.deps.prober.snapshot()).toEqual([])
      expect(clock.pendingTimers).toBe(0)
    }

    /** Whatever a failing leg left: handles destroyed, units closed (which ends their waits), pool ended. */
    const cleanup = async (): Promise<void> => {
      for (const handle of live) {
        try {
          handle.end(DESTROY)
        } catch {
          // already ended
        }
      }
      live.clear()
      for (const unit of units) {
        try {
          unit.close()
        } catch {
          // closing a unit that held an attempt destroys it and throws; nothing more to do here
        }
      }
      recorder.stop()
      await pool.end()
    }

    return {
      pool,
      clock,
      capacity,
      coordinator,
      recorder,
      open,
      start,
      acquireNow,
      commitAndEnd,
      poolFacts,
      quotaSnapshot,
      orgWaiting,
      recordsOf,
      expectA08Baseline,
      cleanup,
    }
  }

  const IDLE_ZERO = { held: 0, waiting: 0 }
  const NO_WAITS = { 'class-00': 0, dedicated: 0, quota: 0, connect: 0, cleaning: 0 }

  it('A08 long class, org quota saturated: a second long unit of the org waits without borrowing a connection, while another org gets through on the remaining global capacity', async () => {
    const s = a08Setup(4)
    const orgA = crypto.randomUUID()
    const orgB = crypto.randomUUID()
    try {
      // The contract under test: one long unit per org, two globally (pool 20).
      expect({ longTxnSlots: s.capacity.longTxnSlots, orgLongTxnSlots: s.capacity.orgLongTxnSlots }).toEqual({ longTxnSlots: 2, orgLongTxnSlots: 1 })

      const holderA = s.open(a08Request('test.a08.holder-a'))
      const heldA = await s.acquireNow(holderA, orgA)
      expect(await s.poolFacts()).toEqual({ borrows: 1, checkedOut: 1, poolWaiting: 0, backends: ['idle in transaction'] })

      // A second long unit of the same org queues on the org's long quota and borrows nothing.
      const waiterA = s.open(a08Request('test.a08.waiter-a'))
      const waiting = s.start(waiterA, orgA)
      await a08WaitUntil(() => waiting.done || s.orgWaiting(orgA, 'long') === 1)
      await a08Pause()
      expect(await s.poolFacts()).toEqual({ borrows: 1, checkedOut: 1, poolWaiting: 0, backends: ['idle in transaction'] })
      expect(waiting.done).toBe(false)
      expect(s.coordinator.deps.prober.snapshot()).toEqual([])
      expect(s.quotaSnapshot()).toEqual({
        global: { short: IDLE_ZERO, long: { held: 1, waiting: 0 } },
        orgs: [{ org: orgA, quotaClass: 'long', held: 1, waiting: 1 }],
      })

      // Another org goes through on the global capacity that is left, and that saturates it.
      const holderB = s.open(a08Request('test.a08.holder-b'))
      const heldB = await s.acquireNow(holderB, orgB)
      expect(await s.poolFacts()).toEqual({ borrows: 2, checkedOut: 2, poolWaiting: 0, backends: ['idle in transaction', 'idle in transaction'] })
      expect(waiting.done).toBe(false)
      expect(s.quotaSnapshot()).toEqual({
        global: { short: IDLE_ZERO, long: { held: 2, waiting: 0 } },
        orgs: [
          { org: orgA, quotaClass: 'long', held: 1, waiting: 1 },
          { org: orgB, quotaClass: 'long', held: 1, waiting: 0 },
        ],
      })

      // Global capacity comes back, but the waiter is held by its org's quota, not by the global one.
      await s.commitAndEnd(heldB)
      await a08Pause()
      expect(await s.poolFacts()).toEqual({ borrows: 2, checkedOut: 1, poolWaiting: 0, backends: ['idle', 'idle in transaction'] })
      expect(waiting.done).toBe(false)
      expect(s.quotaSnapshot()).toEqual({
        global: { short: IDLE_ZERO, long: { held: 1, waiting: 0 } },
        orgs: [{ org: orgA, quotaClass: 'long', held: 1, waiting: 1 }],
      })

      // The org's holder ends: the waiter takes the permit, borrows once and is handed a transaction.
      await s.commitAndEnd(heldA)
      await a08WaitUntil(() => waiting.done)
      expect({ done: waiting.done, error: waiting.error }).toEqual({ done: true, error: undefined })
      expect(await s.poolFacts()).toEqual({ borrows: 3, checkedOut: 1, poolWaiting: 0, backends: ['idle', 'idle in transaction'] })
      expect(s.quotaSnapshot()).toEqual({
        global: { short: IDLE_ZERO, long: { held: 1, waiting: 0 } },
        orgs: [{ org: orgA, quotaClass: 'long', held: 1, waiting: 0 }],
      })
      await s.commitAndEnd(waiting.value as SettlementCoordinationHandleV1)
      const [waiterRecord] = s.recordsOf('test.a08.waiter-a')
      expect(waiterRecord.events.map((event) => event.kind)).toEqual(['quota', 'connect', 's1', 'handover'])
      expect(waiterRecord.events[0].detail).toEqual({ waitedMs: 0, queued: true })
      expect(s.recordsOf('test.a08.waiter-a')).toHaveLength(1)

      for (const unit of [holderA, waiterA, holderB]) unit.close()
      await s.expectA08Baseline()
    } finally {
      await s.cleanup()
    }
  })

  it('A08 long class, global quota saturated: a long unit of a third org waits without borrowing a connection, while a short unit of that same org runs a real transaction on its own quota', async () => {
    const s = a08Setup(5)
    const orgX = crypto.randomUUID()
    const orgY = crypto.randomUUID()
    const orgZ = crypto.randomUUID()
    try {
      const holderX = s.open(a08Request('test.a08.holder-x'))
      const holderY = s.open(a08Request('test.a08.holder-y'))
      const heldX = await s.acquireNow(holderX, orgX)
      const heldY = await s.acquireNow(holderY, orgY)
      expect(await s.poolFacts()).toEqual({ borrows: 2, checkedOut: 2, poolWaiting: 0, backends: ['idle in transaction', 'idle in transaction'] })

      // A third org's long unit gets its org permit and queues on the saturated global long quota.
      const longZ = s.open(a08Request('test.a08.long-z'))
      const waiting = s.start(longZ, orgZ)
      await a08WaitUntil(() => waiting.done || s.quotaSnapshot().global.long.waiting === 1)
      await a08Pause()
      expect(await s.poolFacts()).toEqual({ borrows: 2, checkedOut: 2, poolWaiting: 0, backends: ['idle in transaction', 'idle in transaction'] })
      expect(waiting.done).toBe(false)
      expect(s.coordinator.deps.prober.snapshot()).toEqual([])
      // While it waits for the global quota it holds only its org quota (quota module, §3.2 step 1).
      expect(s.quotaSnapshot()).toEqual({
        global: { short: IDLE_ZERO, long: { held: 2, waiting: 1 } },
        orgs: [
          { org: orgX, quotaClass: 'long', held: 1, waiting: 0 },
          { org: orgY, quotaClass: 'long', held: 1, waiting: 0 },
          { org: orgZ, quotaClass: 'long', held: 1, waiting: 0 },
        ],
      })

      // Short and long are separate quotas (TXN / ORG_TXN vs LONG / 1 per org): a short unit of the
      // very org whose long unit is queued borrows, runs and commits a real transaction meanwhile.
      const shortZ = s.open(a08Request('test.a08.short-z', { quotaClass: 'short' }))
      const heldShort = await s.acquireNow(shortZ, orgZ)
      const level = await heldShort.client.query("SELECT current_setting('transaction_isolation') AS level")
      expect(level.rows[0]).toEqual({ level: 'serializable' })
      expect(await s.poolFacts()).toEqual({
        borrows: 3,
        checkedOut: 3,
        poolWaiting: 0,
        backends: ['idle in transaction', 'idle in transaction', 'idle in transaction'],
      })
      expect(waiting.done).toBe(false)
      expect(s.quotaSnapshot()).toEqual({
        global: { short: { held: 1, waiting: 0 }, long: { held: 2, waiting: 1 } },
        orgs: [
          { org: orgX, quotaClass: 'long', held: 1, waiting: 0 },
          { org: orgY, quotaClass: 'long', held: 1, waiting: 0 },
          { org: orgZ, quotaClass: 'long', held: 1, waiting: 0 },
          { org: orgZ, quotaClass: 'short', held: 1, waiting: 0 },
        ],
      })
      await s.commitAndEnd(heldShort)
      await a08Pause()
      expect(await s.poolFacts()).toEqual({ borrows: 3, checkedOut: 2, poolWaiting: 0, backends: ['idle', 'idle in transaction', 'idle in transaction'] })
      expect(waiting.done).toBe(false)

      // A global long permit comes back: the queued unit borrows once and is handed a transaction.
      await s.commitAndEnd(heldY)
      await a08WaitUntil(() => waiting.done)
      expect({ done: waiting.done, error: waiting.error }).toEqual({ done: true, error: undefined })
      expect(await s.poolFacts()).toEqual({ borrows: 4, checkedOut: 2, poolWaiting: 0, backends: ['idle', 'idle in transaction', 'idle in transaction'] })
      expect(s.quotaSnapshot()).toEqual({
        global: { short: IDLE_ZERO, long: { held: 2, waiting: 0 } },
        orgs: [
          { org: orgX, quotaClass: 'long', held: 1, waiting: 0 },
          { org: orgZ, quotaClass: 'long', held: 1, waiting: 0 },
        ],
      })
      await s.commitAndEnd(waiting.value as SettlementCoordinationHandleV1)
      await s.commitAndEnd(heldX)
      expect(s.recordsOf('test.a08.long-z').map((record) => record.events.map((event) => event.kind))).toEqual([['quota', 'connect', 's1', 'handover']])
      expect(s.recordsOf('test.a08.short-z').map((record) => record.events.map((event) => event.kind))).toEqual([['quota', 'connect', 's1', 'handover']])

      for (const unit of [holderX, holderY, longZ, shortZ]) unit.close()
      await s.expectA08Baseline()
    } finally {
      await s.cleanup()
    }
  })

  it('A08 background unit: a quota wait lasts exactly the 30 s boundary on the coordination clock, borrows no connection, then fails as capacity busy and leaves no quota, connection or in-flight unit behind', async () => {
    const s = a08Setup(4)
    const orgX = crypto.randomUUID()
    const orgY = crypto.randomUUID()
    const orgZ = crypto.randomUUID()
    try {
      expect(SETTLEMENT_COORDINATION_BACKGROUND_QUOTA_WAIT_MS).toBe(30_000)
      const holderX = s.open(a08Request('test.a08.bg-holder-x'))
      const holderY = s.open(a08Request('test.a08.bg-holder-y'))
      const heldX = await s.acquireNow(holderX, orgX)
      const heldY = await s.acquireNow(holderY, orgY)

      // One background unit queues on its org's long quota, the other on the global long quota
      // (holding its own org permit while it waits).
      const onOrg = s.open(a08Request('test.a08.bg-on-org', { background: true }))
      const onGlobal = s.open(a08Request('test.a08.bg-on-global', { background: true }))
      const waitingOnOrg = s.start(onOrg, orgX)
      const waitingOnGlobal = s.start(onGlobal, orgZ)
      await a08WaitUntil(
        () => (waitingOnOrg.done || s.orgWaiting(orgX, 'long') === 1) && (waitingOnGlobal.done || s.quotaSnapshot().global.long.waiting === 1),
      )
      await a08Pause()
      const queuedFacts = { borrows: 2, checkedOut: 2, poolWaiting: 0, backends: ['idle in transaction', 'idle in transaction'] }
      const queuedQuota = {
        global: { short: IDLE_ZERO, long: { held: 2, waiting: 1 } },
        orgs: [
          { org: orgX, quotaClass: 'long', held: 1, waiting: 1 },
          { org: orgY, quotaClass: 'long', held: 1, waiting: 0 },
          { org: orgZ, quotaClass: 'long', held: 1, waiting: 0 },
        ],
      }
      expect(await s.poolFacts()).toEqual(queuedFacts)
      expect({ onOrg: waitingOnOrg.done, onGlobal: waitingOnGlobal.done }).toEqual({ onOrg: false, onGlobal: false })
      expect(s.quotaSnapshot()).toEqual(queuedQuota)

      // One millisecond before the boundary (far beyond the 5 s request budget) both still wait, empty-handed.
      await s.clock.advance(29_999)
      await a08Pause()
      expect(await s.poolFacts()).toEqual(queuedFacts)
      expect({ onOrg: waitingOnOrg.done, onGlobal: waitingOnGlobal.done }).toEqual({ onOrg: false, onGlobal: false })
      expect(s.quotaSnapshot()).toEqual(queuedQuota)

      // At the boundary both fail with the defined capacity-busy code; the quota wait spent no budget.
      await s.clock.advance(1)
      await a08WaitUntil(() => waitingOnOrg.done && waitingOnGlobal.done)
      expect(s.clock.now()).toBe(30_000)
      for (const [unit, waiting] of [
        [onOrg, waitingOnOrg],
        [onGlobal, waitingOnGlobal],
      ] as const) {
        expect(waiting.done).toBe(true)
        expect(waiting.error).toBeInstanceOf(SettlementCoordinationAcquireError)
        const error = waiting.error as SettlementCoordinationAcquireError
        expect({ code: error.code, waits: error.waits }).toEqual({ code: 'ATTENDANCE_COORDINATION_CAPACITY_BUSY', waits: NO_WAITS })
        expect(error.code).toBe(SETTLEMENT_COORDINATION_CAPACITY_BUSY)
        expect({ spentMs: unit.budget.spentMs, remaining: unit.budget.remaining(), waits: unit.budget.waits() }).toEqual({ spentMs: 0, remaining: 5000, waits: NO_WAITS })
      }
      for (const entryLabel of ['test.a08.bg-on-org', 'test.a08.bg-on-global']) {
        expect(
          s.recordsOf(entryLabel).map((record) => ({
            outcome: record.outcome,
            code: record.code,
            events: record.events.map((event) => ({ kind: event.kind, detail: event.detail })),
          })),
        ).toEqual([
          {
            outcome: 'failed',
            code: 'ATTENDANCE_COORDINATION_CAPACITY_BUSY',
            events: [{ kind: 'quota', detail: { waitedMs: 30_000, queued: true, ended: 'deadline' } }],
          },
        ])
      }
      // Nothing was borrowed, and the org permit of the unit that waited on the global quota came back.
      expect(await s.poolFacts()).toEqual(queuedFacts)
      expect(s.quotaSnapshot()).toEqual({
        global: { short: IDLE_ZERO, long: { held: 2, waiting: 0 } },
        orgs: [
          { org: orgX, quotaClass: 'long', held: 1, waiting: 0 },
          { org: orgY, quotaClass: 'long', held: 1, waiting: 0 },
        ],
      })
      expect(s.coordinator.deps.ledger.snapshot()).toEqual({
        inFlight: { short: 0, long: 4 },
        abandoned: { short: 0, long: 0 },
        holding: [
          { quotaClass: 'long', lease: true, client: true },
          { quotaClass: 'long', lease: true, client: true },
        ],
      })
      onOrg.close()
      onGlobal.close()
      expect(s.coordinator.deps.ledger.snapshot().inFlight).toEqual({ short: 0, long: 2 })

      await s.commitAndEnd(heldX)
      await s.commitAndEnd(heldY)
      holderX.close()
      holderY.close()
      await s.expectA08Baseline()
    } finally {
      await s.cleanup()
    }
  })
})
