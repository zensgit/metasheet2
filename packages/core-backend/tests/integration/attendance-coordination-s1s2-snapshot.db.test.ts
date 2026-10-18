/**
 * Attendance settlement coordination — S1 / S2 against a real PostgreSQL (P1-1 acceptance A03,
 * plus the A09 fairness sub-leg that S1 already makes testable).
 *
 *  - S1 takes the dedicated key (and class-00 for canonical orgs that need it) at session level,
 *    only on an idle connection, over the simple protocol; contention on either family leaves
 *    nothing behind; a queued exclusive request makes a new shared try fail at once.
 *  - The handover's snapshot is formed only by S2: a SERIALIZABLE transaction that starts after a
 *    blocker committed and released sees the blocker's write; a negative control shows that a
 *    snapshot formed before the release would not. The transaction-level lock is held before the
 *    session-level lock is released.
 *  - S1 depends on the simple protocol: over the extended protocol the idle proof must not hold.
 *
 * Every observation is made from a separate connection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import {
  commitSettlementCoordinationTransactionV1,
  planSettlementCoordinationV1,
  releaseSettlementCoordinationSessionLocksV1,
  runSettlementCoordinationHandoverV1,
  runSettlementCoordinationS1V1,
  type SettlementCoordinationPlanV1,
} from '../../src/attendance/coordination/settlement-coordination-handover'
import { buildSettlementCoordinationS1Sql } from '../../src/attendance/coordination/settlement-coordination-statements'
import { SETTLEMENT_COORDINATION_KEY1 } from '../../src/attendance/coordination/settlement-coordination-key'
import {
  advisoryLocksOf,
  backendPid,
  isBigintLock,
  isDedicatedLock,
  waitForBackendGone,
  waitForQueuedAdvisory,
} from '../helpers/settlement-coordination-db'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have a database URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

const RUN = crypto.randomUUID().slice(0, 8)
const SCHEMA = `p11_coord_snap_${RUN}`
const K1 = SETTLEMENT_COORDINATION_KEY1

function canonicalOrg(): string {
  return crypto.randomUUID()
}

describeIfDatabase('attendance settlement coordination — S1 / S2 handover (real database)', () => {
  let pool: Pool
  let observer: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl, max: 6 })
    observer = new Pool({ connectionString: dbUrl, max: 2 })
    await observer.query(`CREATE SCHEMA ${SCHEMA}`)
    await observer.query(`CREATE TABLE ${SCHEMA}.facts (id serial PRIMARY KEY, note text NOT NULL)`)
  })

  afterAll(async () => {
    await observer.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
    await observer.end()
  })

  async function expectNoAdvisory(pid: number): Promise<void> {
    expect(await advisoryLocksOf(observer, pid)).toEqual([])
  }

  async function withClient<T>(fn: (client: PoolClient, pid: number) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      return await fn(client, await backendPid(client))
    } finally {
      client.release()
    }
  }

  it('S1 takes both families at session level on an idle connection', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: true })
    expect(plan.classZeroKey).not.toBeNull()
    await withClient(async (client, pid) => {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const held = await advisoryLocksOf(observer, pid)
      expect(held).toHaveLength(2)
      expect(held.some((row) => isDedicatedLock(row, plan.key.key2) && row.mode === 'ShareLock' && row.granted)).toBe(true)
      expect(held.some((row) => isBigintLock(row, plan.classZeroKey as bigint) && row.mode === 'ShareLock' && row.granted)).toBe(true)
      expect(await releaseSettlementCoordinationSessionLocksV1(client, plan)).toEqual({ kind: 'released' })
      await expectNoAdvisory(pid)
    })
  })

  it('legacy orgs and entries without class-00 take only the dedicated family', async () => {
    const plans: SettlementCoordinationPlanV1[] = [
      planSettlementCoordinationV1(`legacy-${RUN}-a`, { needsClassZero: true }),
      planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: false }),
    ]
    for (const plan of plans) {
      expect(plan.classZeroKey).toBeNull()
      await withClient(async (client, pid) => {
        expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
        const held = await advisoryLocksOf(observer, pid)
        expect(held).toHaveLength(1)
        expect(isDedicatedLock(held[0], plan.key.key2)).toBe(true)
        expect(await releaseSettlementCoordinationSessionLocksV1(client, plan)).toEqual({ kind: 'released' })
        await expectNoAdvisory(pid)
      })
    }
  })

  it('S1 refuses a connection that is inside an open transaction and takes nothing', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: true })
    const client = await pool.connect()
    const pid = await backendPid(client)
    await client.query('BEGIN')
    await client.query('SELECT 1')
    const outcome = await runSettlementCoordinationS1V1(client, plan)
    expect(outcome).toEqual({ kind: 'uncertain', reason: 's1-not-idle' })
    await expectNoAdvisory(pid)
    client.release(new Error('test: destroy after uncertain S1'))
    expect(await waitForBackendGone(observer, pid)).toBe(true)
  })

  it('S1 inside an aborted transaction errors with 25P02 and is uncertain', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: true })
    const client = await pool.connect()
    const pid = await backendPid(client)
    await client.query('BEGIN')
    await expect(client.query('SELECT 1 / 0')).rejects.toBeTruthy()
    const outcome = await runSettlementCoordinationS1V1(client, plan)
    expect(outcome.kind).toBe('uncertain')
    expect(outcome.kind === 'uncertain' && outcome.reason).toBe('s1-statement-failed')
    expect(outcome.kind === 'uncertain' && (outcome.error as { code?: string }).code).toBe('25P02')
    client.release(new Error('test: destroy after uncertain S1'))
    expect(await waitForBackendGone(observer, pid)).toBe(true)
  })

  it('an exclusive holder of the dedicated key makes S1 contended and leaves no lock', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: true })
    const holder = await pool.connect()
    try {
      await holder.query(`SELECT pg_advisory_lock(${K1}, ${plan.key.key2})`)
      await withClient(async (client, pid) => {
        expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'contended', family: 'dedicated' })
        await expectNoAdvisory(pid)
      })
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${K1}, ${plan.key.key2})`)
      holder.release()
    }
  })

  it('an exclusive holder of class-00 makes S1 undo the dedicated key in the same statement', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: true })
    const c00 = (plan.classZeroKey as bigint).toString()
    const holder = await pool.connect()
    try {
      await holder.query(`SELECT pg_advisory_lock(${c00}::bigint)`)
      await withClient(async (client, pid) => {
        expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'contended', family: 'class-00' })
        await expectNoAdvisory(pid)
      })
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${c00}::bigint)`)
      holder.release()
    }
  })

  it('a queued exclusive request makes a new shared try fail immediately (A09 fairness sub-leg)', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: false })
    const sharedHolder = await pool.connect()
    const exclusiveWaiter = await pool.connect()
    const waiterPid = await backendPid(exclusiveWaiter)
    await sharedHolder.query(`SELECT pg_advisory_lock_shared(${K1}, ${plan.key.key2})`)
    const waiting = exclusiveWaiter.query(`SELECT pg_advisory_lock(${K1}, ${plan.key.key2})`)
    try {
      expect(await waitForQueuedAdvisory(observer, waiterPid)).toBe(true)
      await withClient(async (client, pid) => {
        expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'contended', family: 'dedicated' })
        await expectNoAdvisory(pid)
      })
    } finally {
      await sharedHolder.query(`SELECT pg_advisory_unlock_shared(${K1}, ${plan.key.key2})`)
      await waiting
      await exclusiveWaiter.query(`SELECT pg_advisory_unlock(${K1}, ${plan.key.key2})`)
      sharedHolder.release()
      exclusiveWaiter.release()
    }
  })

  it('SERIALIZABLE handover sees a write committed by a blocker that released before S1 succeeded', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: true })
    const note = `serializable-${RUN}`
    const blocker = await pool.connect()
    try {
      await blocker.query(`SELECT pg_advisory_lock(${K1}, ${plan.key.key2})`)
      await blocker.query('BEGIN')
      await blocker.query(`INSERT INTO ${SCHEMA}.facts (note) VALUES ($1)`, [note])
      await withClient(async (client) => {
        // Contention first: the blocker holds the key while its write is uncommitted.
        expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'contended', family: 'dedicated' })
        await blocker.query('COMMIT')
        await blocker.query(`SELECT pg_advisory_unlock(${K1}, ${plan.key.key2})`)
        expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
        const handover = await runSettlementCoordinationHandoverV1(client, plan, {
          isolation: 'SERIALIZABLE',
          timeouts: { kind: 'none' },
          entryLabel: 'test.snapshot',
        })
        expect(handover.kind).toBe('handed-over')
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.facts WHERE note = $1`, [note])
        expect(rows[0].n).toBe(1)
        if (handover.kind !== 'handed-over') throw new Error('handover failed')
        expect(await commitSettlementCoordinationTransactionV1(client, handover.credential)).toEqual({ kind: 'committed' })
      })
    } finally {
      blocker.release()
    }
  })

  it('negative control: a SERIALIZABLE snapshot formed before the release stays stale even after the lock is taken', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: false })
    const note = `stale-${RUN}`
    const blocker = await pool.connect()
    const client = await pool.connect()
    try {
      await blocker.query(`SELECT pg_advisory_lock(${K1}, ${plan.key.key2})`)
      await blocker.query('BEGIN')
      await blocker.query(`INSERT INTO ${SCHEMA}.facts (note) VALUES ($1)`, [note])
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const before = await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.facts WHERE note = $1`, [note])
      expect(before.rows[0].n).toBe(0)
      await blocker.query('COMMIT')
      await blocker.query(`SELECT pg_advisory_unlock(${K1}, ${plan.key.key2})`)
      await client.query(`SELECT pg_advisory_xact_lock_shared(${K1}, ${plan.key.key2})`)
      const after = await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.facts WHERE note = $1`, [note])
      expect(after.rows[0].n).toBe(0)
      await client.query('ROLLBACK')
    } finally {
      blocker.release()
      client.release()
    }
  })

  it('READ COMMITTED handover sees the committed write too (positive control)', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: true })
    const note = `read-committed-${RUN}`
    await observer.query(`INSERT INTO ${SCHEMA}.facts (note) VALUES ($1)`, [note])
    await withClient(async (client) => {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const handover = await runSettlementCoordinationHandoverV1(client, plan, {
        isolation: 'READ COMMITTED',
        timeouts: { kind: 'none' },
        entryLabel: 'test.snapshot-rc',
      })
      if (handover.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(handover)}`)
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.facts WHERE note = $1`, [note])
      expect(rows[0].n).toBe(1)
      expect(await commitSettlementCoordinationTransactionV1(client, handover.credential)).toEqual({ kind: 'committed' })
    })
  })

  it('the transaction-level lock is held before the session-level lock is released', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: true })
    const other = await pool.connect()
    try {
      await withClient(async (client, pid) => {
        expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
        const handover = await runSettlementCoordinationHandoverV1(client, plan, {
          isolation: 'SERIALIZABLE',
          timeouts: { kind: 'w4-runner' },
          entryLabel: 'test.handover',
        })
        if (handover.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(handover)}`)
        // Still held — now at transaction level — so an exclusive try elsewhere fails.
        const blocked = await other.query(`SELECT pg_try_advisory_lock(${K1}, ${plan.key.key2}) AS ok`)
        expect(blocked.rows[0].ok).toBe(false)
        const held = await advisoryLocksOf(observer, pid)
        expect(held.some((row) => isDedicatedLock(row, plan.key.key2) && row.granted)).toBe(true)
        expect(held.some((row) => isBigintLock(row, plan.classZeroKey as bigint) && row.granted)).toBe(true)
        // The session-level hold is gone: a second session unlock finds nothing to release.
        const again = await client.query(`SELECT pg_advisory_unlock_shared(${K1}, ${plan.key.key2}) AS ok`)
        expect(again.rows[0].ok).toBe(false)
        // The settings S2 applied are transaction-local.
        const settings = await client.query(
          "SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt, current_setting('application_name') AS an",
        )
        expect(settings.rows[0]).toEqual({ st: '3min', lt: '5s', an: 'ms2-coord:test.handover' })
        expect(await commitSettlementCoordinationTransactionV1(client, handover.credential)).toEqual({ kind: 'committed' })
        await expectNoAdvisory(pid)
        const free = await other.query(`SELECT pg_try_advisory_lock(${K1}, ${plan.key.key2}) AS ok`)
        expect(free.rows[0].ok).toBe(true)
        await other.query(`SELECT pg_advisory_unlock(${K1}, ${plan.key.key2})`)
      })
    } finally {
      other.release()
    }
  })

  it('the idle proof depends on the simple protocol: over the extended protocol it does not hold', async () => {
    const plan = planSettlementCoordinationV1(canonicalOrg(), { needsClassZero: false })
    const sql = buildSettlementCoordinationS1Sql({ key2: plan.key.key2, classZeroKey: null })
    const results: Array<boolean | null> = []
    await withClient(async (client, pid) => {
      for (let i = 0; i < 20; i += 1) {
        // A named statement forces Parse / Bind / Execute even without values.
        const { rows } = await client.query({ name: `p11-s1-extended-${RUN}-${i}`, text: sql })
        results.push(rows[0].idle as boolean | null)
        if (rows[0].k_ok === true) await client.query(`SELECT pg_advisory_unlock_shared(${K1}, ${plan.key.key2})`)
      }
      await expectNoAdvisory(pid)
    })
    expect(results).toEqual(Array(20).fill(false))
  })
})
