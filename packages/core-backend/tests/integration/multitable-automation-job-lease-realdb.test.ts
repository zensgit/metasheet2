/**
 * R-69 1b-ii — job lease on a REAL Postgres (design baseline v2.3 §10.2.5; two independent connections because
 * fake-PG cannot model row locks, `now()` liveness or ON CONFLICT re-evaluation behind a lock). Isolated short
 * synthetic leases (seconds) expire on the DATABASE clock; interleavings are controlled by barriers; the system
 * clock is never changed.
 *
 *   - schema: CHECK names, PK, rows only grow (release is an UPDATE, the row count never drops);
 *   - claim / busy / release / re-claim: fence strictly increases on the SAME row;
 *   - T4 fence: a stale fence's release, renewal and fenced outcome are 0 rows / rolled back — the successor's
 *     lease is untouched and the stale holder's (still valid) intent token does not save it (confirmed:false);
 *   - T2b dead holder: no heartbeat ⇒ after the TTL the successor claims fence+1; the dead holder's late release
 *     is 0 rows, its late Tx B is confirmed:false, and its next heartbeat tick fires lostSignal;
 *   - T10b linearization: a successor's single-statement claim BLOCKS behind the holder's open FOR UPDATE until
 *     the holder commits, then claims fence+1 — never "B took over while A committed a stale result"; and a
 *     holder that verifies an EXPIRED lease under the lock rolls back, after which B claims normally;
 *   - renewal moves BOTH expiries forward in one transaction (lease row first, then the intent row);
 *   - migration: down() refuses while rows exist (values-free code); the drop/recreate round trip is exercised
 *     inside a rolled-back transaction.
 *
 * Two-point wired (plugin-tests.yml multitable real-DB step + vitest.config.ts exclude) so it cannot skip-green;
 * the EXPECT_DB sentinel below fails (not skips) when the DB-expected lane has no DATABASE_URL.
 */
import { randomUUID } from 'node:crypto'

import { Client } from 'pg'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest'

import { db } from '../../src/db/db'
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  AUTOMATION_JOB_LEASES_DOWN_REFUSED_CODE,
  down as leasesDown,
  up as leasesUp,
} from '../../src/db/migrations/zzzz20261106111100_create_automation_job_leases'
import {
  JobLeaseLostError,
  assertJobLeaseCurrent,
  claimJobLease,
  finalizeJobWithFencedOutcome,
  jobLeaseScopeKey,
  lockJobLeaseForUpdate,
  releaseJobLease,
  renewJobAndIntentLeases,
  startJobLeaseHeartbeat,
  type JobLeaseHandle,
  type JobLeaseQueryFn,
  type JobLeaseTransaction,
} from '../../src/multitable/automation-job-lease'
import {
  claimOutboundIntent,
  deriveOutboundTargetKey,
  type OutboundIntentIdentity,
} from '../../src/multitable/automation-outbound-intent'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const RUN = randomUUID().slice(0, 8)
const TENANT = `tenant_${RUN}`
const q: JobLeaseQueryFn = (s, p) => poolManager.get().query(s, p)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** BEGIN … handler … COMMIT on ONE dedicated connection (ROLLBACK on throw) — the executor's transaction seam shape. */
function clientTransaction(client: Client): JobLeaseTransaction {
  return async (handler) => {
    await client.query('BEGIN')
    try {
      const result = await handler({ query: (s, p) => client.query(s, p) })
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  }
}
function scope(projectNo: string): string {
  return jobLeaseScopeKey({ kind: 'stock_prep_pull', tenantId: TENANT, projectNo })
}
function intentFor(root: string, projectNo: string): OutboundIntentIdentity {
  return {
    kind: 'execution',
    rootExecutionId: root,
    actionKey: `["0","run_integration_job","${RUN}"]`,
    targetKey: deriveOutboundTargetKey(['stock_prep_pull', TENANT, projectNo]),
  }
}
interface LeaseRow { holder: string | null; fence: string; live: boolean; expires: Date }
async function leaseRow(scopeKey: string, query: JobLeaseQueryFn = q): Promise<LeaseRow | undefined> {
  const { rows } = await query(
    `SELECT holder, fence::text AS fence, (lease_expires_at > now()) AS live, lease_expires_at AS expires
       FROM meta_automation_job_leases WHERE scope_key = $1`,
    [scopeKey],
  )
  return rows[0] as LeaseRow | undefined
}
async function rowCount(): Promise<number> {
  const { rows } = await q(`SELECT count(*)::int AS n FROM meta_automation_job_leases WHERE scope_key LIKE $1`, [`%${RUN}%`])
  return Number((rows[0] as { n: number }).n)
}
/** Wait until the DB clock says the lease expired (the DB decides liveness, never the JS clock). */
async function untilExpired(scopeKey: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const row = await leaseRow(scopeKey)
    if (row && row.live === false) return
    await sleep(50)
  }
  throw new Error('lease did not expire on the database clock')
}
async function intentStatus(id: OutboundIntentIdentity): Promise<{ status: string; token: string | null; expires: Date | null } | undefined> {
  const { rows } = await q(
    `SELECT status, attempt_token AS token, lease_expires_at AS expires FROM meta_automation_outbound_intent
      WHERE kind=$1 AND root_execution_id=$2 AND action_key=$3 AND target_key=$4`,
    [id.kind, id.rootExecutionId, id.actionKey, id.targetKey ?? ''],
  )
  return rows[0] as { status: string; token: string | null; expires: Date | null } | undefined
}
function tokenOf(claim: Awaited<ReturnType<typeof claimOutboundIntent>>): string {
  if (claim.attemptToken === null) throw new Error(`claim ${claim.decision} carries no token`)
  return claim.attemptToken
}
function settledYet<T>(promise: Promise<T>): { settled: () => boolean; value: () => T } {
  let state: { done: false } | { done: true; value: T } = { done: false }
  void promise.then((value) => { state = { done: true, value } })
  return { settled: () => state.done, value: () => { if (!state.done) throw new Error('not settled'); return state.value } }
}

describeIfDatabase('R-69 1b-ii job lease (real DB, two connections)', () => {
  let a: Client
  let b: Client
  let qa: JobLeaseQueryFn
  let qb: JobLeaseQueryFn

  beforeAll(async () => {
    // Idempotent on a migrated CI database; creates the table on a throwaway local database.
    await leasesUp(db as never)
    a = new Client({ connectionString: process.env.DATABASE_URL })
    b = new Client({ connectionString: process.env.DATABASE_URL })
    await a.connect()
    await b.connect()
    qa = (s, p) => a.query(s, p)
    qb = (s, p) => b.query(s, p)
  })
  afterAll(async () => {
    await q(`DELETE FROM meta_automation_outbound_intent WHERE action_key LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    await q(`DELETE FROM meta_automation_job_leases WHERE scope_key LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    await a?.end().catch(() => undefined)
    await b?.end().catch(() => undefined)
  })

  test('sentinel: two independent backends', async () => {
    const [pa, pb] = await Promise.all([qa('SELECT pg_backend_pid() AS pid'), qb('SELECT pg_backend_pid() AS pid')])
    expect((pa.rows[0] as { pid: number }).pid).not.toBe((pb.rows[0] as { pid: number }).pid)
  })

  test('schema: named CHECKs (blank scope_key, negative fence) and the scope_key PRIMARY KEY', async () => {
    await expect(q(`INSERT INTO meta_automation_job_leases (scope_key, lease_expires_at) VALUES ($1, now())`, ['   '])).rejects.toThrow(/automation_job_leases_scope_key_nonblank/)
    await expect(q(`INSERT INTO meta_automation_job_leases (scope_key, fence, lease_expires_at) VALUES ($1, -1, now())`, [scope('neg')])).rejects.toThrow(/automation_job_leases_fence_nonneg/)
    await q(`INSERT INTO meta_automation_job_leases (scope_key, lease_expires_at) VALUES ($1, now())`, [scope('pk')])
    await expect(q(`INSERT INTO meta_automation_job_leases (scope_key, lease_expires_at) VALUES ($1, now())`, [scope('pk')])).rejects.toThrow(/meta_automation_job_leases_pkey/)
  })

  test('claim → busy → release → re-claim: ONE row, fence strictly increasing, rows only grow', async () => {
    const key = scope('P-claim')
    const first = await claimJobLease(qa, key, 'holder_a', 60_000)
    expect(first).toMatchObject({ scopeKey: key, holder: 'holder_a', fence: '1' })
    expect(await assertJobLeaseCurrent(qb, first!)).toBe(true)
    // live lease ⇒ the successor's single UPSERT matches no row
    expect(await claimJobLease(qb, key, 'holder_b', 60_000)).toBeNull()
    const before = await rowCount()
    expect(await releaseJobLease(qa, first!)).toBe(true)
    expect(await assertJobLeaseCurrent(qb, first!)).toBe(false)
    expect(await leaseRow(key)).toMatchObject({ holder: null, fence: '1', live: false })
    const second = await claimJobLease(qb, key, 'holder_b', 60_000)
    expect(second).toMatchObject({ holder: 'holder_b', fence: '2' })
    expect(await rowCount()).toBe(before) // release never deletes; re-claim never inserts a second row
    // a second release with the OLD fence is 0 rows (idempotent for the stale holder, invisible to the new one)
    expect(await releaseJobLease(qa, first!)).toBe(false)
    expect(await leaseRow(key)).toMatchObject({ holder: 'holder_b', fence: '2', live: true })
    expect(await releaseJobLease(qb, second!)).toBe(true)
  })

  test('T4 fence: stale release / renewal / fenced outcome are all void; the successor’s lease is untouched; a still-valid intent token does not rescue the stale holder', async () => {
    const key = scope('P-fence')
    const idA = intentFor(`root_a_${RUN}`, 'P-fence')
    const claimA = await claimOutboundIntent(qa, idA, { leaseMs: 60_000 })
    expect(claimA.decision).toBe('proceed')
    const leaseA = (await claimJobLease(qa, key, 'holder_a', 1_000))!
    expect(leaseA.fence).toBe('1')
    await untilExpired(key)
    const leaseB = (await claimJobLease(qb, key, 'holder_b', 60_000))!
    expect(leaseB.fence).toBe('2')
    const bRowBefore = await leaseRow(key)

    // A's intent token is STILL valid (nobody flipped its row) — the job fence alone must refuse A.
    expect(await intentStatus(idA)).toMatchObject({ status: 'pending', token: tokenOf(claimA) })
    expect(await releaseJobLease(qa, leaseA)).toBe(false)
    await expect(renewJobAndIntentLeases(clientTransaction(a), leaseA, { id: idA, attemptToken: tokenOf(claimA), leaseMs: 60_000 }))
      .rejects.toMatchObject({ name: 'JobLeaseLostError', stage: 'verify' })
    const txB = await finalizeJobWithFencedOutcome(clientTransaction(a), leaseA, { id: idA, attemptToken: tokenOf(claimA) }, 'sent', 'job_succeeded')
    expect(txB).toEqual({ confirmed: false, reason: 'lease_lost', stage: 'verify' })
    // nothing of A's Tx B landed: the intent row is still A's pending row, B's lease row is byte-for-byte the same
    expect(await intentStatus(idA)).toMatchObject({ status: 'pending', token: tokenOf(claimA) })
    expect(await leaseRow(key)).toEqual(bRowBefore)
    expect(await rowCount()).toBeGreaterThanOrEqual(1)
    expect(Number(leaseB.fence)).toBeGreaterThan(Number(leaseA.fence))
    expect(await releaseJobLease(qb, leaseB)).toBe(true)
  })

  test('T2b dead holder: no heartbeat ⇒ the successor claims fence+1 after the TTL; the dead holder’s late release is 0 rows, its late Tx B is confirmed:false, and its next heartbeat tick fires lostSignal', async () => {
    const key = scope('P-dead')
    const idA = intentFor(`root_dead_a_${RUN}`, 'P-dead')
    const claimA = await claimOutboundIntent(qa, idA, { leaseMs: 60_000 })
    const leaseA = (await claimJobLease(qa, key, 'holder_a', 1_000))!
    // A "dies": no renewal. Before the TTL B is busy; after it B takes over.
    expect(await claimJobLease(qb, key, 'holder_b', 60_000)).toBeNull()
    await untilExpired(key)
    const leaseB = (await claimJobLease(qb, key, 'holder_b', 60_000))!
    expect(leaseB.fence).toBe(String(Number(leaseA.fence) + 1))
    const rows = await rowCount()

    // A comes back late.
    expect(await releaseJobLease(qa, leaseA)).toBe(false)
    expect(await finalizeJobWithFencedOutcome(clientTransaction(a), leaseA, { id: idA, attemptToken: tokenOf(claimA) }, 'sent', 'job_succeeded'))
      .toMatchObject({ confirmed: false, reason: 'lease_lost' })
    // A's heartbeat tick: 0 rows under the lock ⇒ lostSignal (the holder must stop admitting calls).
    const hb = startJobLeaseHeartbeat({
      renew: () => renewJobAndIntentLeases(clientTransaction(a), leaseA, { id: idA, attemptToken: tokenOf(claimA), leaseMs: 60_000 }, 1_000),
      ttlMs: 3_000,
      intervalMs: 1_000,
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('lostSignal did not fire')), 5_000)
        hb.lostSignal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      expect(hb.lost).toBe(true)
      expect((hb.lostSignal.reason as JobLeaseLostError).stage).toBe('renew_error')
    } finally {
      await hb.stop()
    }
    // B's lease was never touched by any of A's late writes; the row count did not change (release ≠ DELETE).
    expect(await leaseRow(key)).toMatchObject({ holder: 'holder_b', fence: leaseB.fence, live: true })
    expect(await rowCount()).toBe(rows)
    expect(await assertJobLeaseCurrent(qa, leaseA)).toBe(false)
    expect(await assertJobLeaseCurrent(qb, leaseB)).toBe(true)
    expect(await releaseJobLease(qb, leaseB)).toBe(true)
  })

  test('T10b: the successor’s claim BLOCKS behind the holder’s open FOR UPDATE until the holder commits its fenced outcome; then it claims fence+1 (no stale commit after a takeover)', async () => {
    const key = scope('P-lin')
    const idA = intentFor(`root_lin_a_${RUN}`, 'P-lin')
    const claimA = await claimOutboundIntent(qa, idA, { leaseMs: 60_000 })
    const leaseA = (await claimJobLease(qa, key, 'holder_a', 1_500))!

    // A's Tx B: lock + verify while still live, then STOP at the barrier (no commit yet).
    await a.query('BEGIN')
    await lockJobLeaseForUpdate(qa, leaseA)
    // The synthetic lease expires on the DB clock while A still holds the row lock.
    await sleep(1_700)
    // B tries to take over: its single UPSERT must wait for A's transaction.
    const claimB = settledYet(claimJobLease(qb, key, 'holder_b', 60_000))
    await sleep(400)
    expect(claimB.settled()).toBe(false)

    // A finishes Tx B under the lock: fenced outcome, fence-CAS release, COMMIT.
    const { recordOutboundOutcomeFenced } = await import('../../src/multitable/automation-outbound-intent')
    await recordOutboundOutcomeFenced(qa, idA, 'sent', 'job_succeeded', tokenOf(claimA))
    expect(await releaseJobLease(qa, leaseA)).toBe(true)
    await a.query('COMMIT')

    for (let i = 0; i < 100 && !claimB.settled(); i++) await sleep(20)
    expect(claimB.settled()).toBe(true)
    const leaseB = claimB.value()
    expect(leaseB).toMatchObject({ holder: 'holder_b', fence: String(Number(leaseA.fence) + 1) })
    // A's result landed (it was the holder until its commit); B's lease is live.
    expect(await intentStatus(idA)).toMatchObject({ status: 'sent', token: tokenOf(claimA) })
    expect(await leaseRow(key)).toMatchObject({ holder: 'holder_b', live: true })
    expect(await releaseJobLease(qb, leaseB!)).toBe(true)
  })

  test('T10b (other branch): a holder that verifies an EXPIRED lease under the lock rolls back everything; the successor then claims normally', async () => {
    const key = scope('P-lin2')
    const idA = intentFor(`root_lin2_a_${RUN}`, 'P-lin2')
    const claimA = await claimOutboundIntent(qa, idA, { leaseMs: 60_000 })
    const leaseA = (await claimJobLease(qa, key, 'holder_a', 1_000))!
    await untilExpired(key)
    const txB = await finalizeJobWithFencedOutcome(clientTransaction(a), leaseA, { id: idA, attemptToken: tokenOf(claimA) }, 'sent', 'job_succeeded')
    expect(txB).toEqual({ confirmed: false, reason: 'lease_lost', stage: 'verify' })
    expect(await intentStatus(idA)).toMatchObject({ status: 'pending', token: tokenOf(claimA) })
    const leaseB = (await claimJobLease(qb, key, 'holder_b', 60_000))!
    expect(leaseB.fence).toBe(String(Number(leaseA.fence) + 1))
    expect(await releaseJobLease(qb, leaseB)).toBe(true)
  })

  test('renewal: one transaction moves BOTH expiries forward — the lease row (locked first) and the intent row (token-fenced)', async () => {
    const key = scope('P-renew')
    const idA = intentFor(`root_renew_a_${RUN}`, 'P-renew')
    const claimA = await claimOutboundIntent(qa, idA, { leaseMs: 1_000 })
    const leaseA = (await claimJobLease(qa, key, 'holder_a', 1_000))!
    const leaseBefore = (await leaseRow(key))!.expires.getTime()
    const intentBefore = (await intentStatus(idA))!.expires!.getTime()
    await sleep(200)
    await renewJobAndIntentLeases(clientTransaction(a), leaseA, { id: idA, attemptToken: tokenOf(claimA), leaseMs: 60_000 }, 60_000)
    expect((await leaseRow(key))!.expires.getTime()).toBeGreaterThan(leaseBefore)
    expect((await intentStatus(idA))!.expires!.getTime()).toBeGreaterThan(intentBefore)
    // and a renewal with a stale token renews NOTHING: the whole transaction rolls back, both expiries unchanged
    const leaseMid = (await leaseRow(key))!.expires.getTime()
    const intentMid = (await intentStatus(idA))!.expires!.getTime()
    await expect(renewJobAndIntentLeases(clientTransaction(a), leaseA, { id: idA, attemptToken: `stale_${RUN}`, leaseMs: 60_000 }, 60_000))
      .rejects.toMatchObject({ name: 'JobLeaseLostError', stage: 'renew_intent' })
    expect((await leaseRow(key))!.expires.getTime()).toBe(leaseMid)
    expect((await intentStatus(idA))!.expires!.getTime()).toBe(intentMid)
    expect(await releaseJobLease(qa, leaseA)).toBe(true)
  })

  test('migration: down() refuses while rows exist (values-free code) and leaves the table in place; the drop/recreate round trip works on an empty table (rolled back)', async () => {
    expect(await rowCount()).toBeGreaterThan(0)
    await expect(leasesDown(db as never)).rejects.toMatchObject({ code: AUTOMATION_JOB_LEASES_DOWN_REFUSED_CODE })
    const stillThere = await q(`SELECT to_regclass('meta_automation_job_leases') IS NOT NULL AS present`)
    expect((stillThere.rows[0] as { present: boolean }).present).toBe(true)
    class Rollback extends Error {}
    await expect(db.transaction().execute(async (trx) => {
      await sql`DELETE FROM meta_automation_job_leases`.execute(trx)
      await leasesDown(trx as never)
      const gone = await sql<{ present: boolean }>`SELECT to_regclass('meta_automation_job_leases') IS NOT NULL AS present`.execute(trx)
      expect(gone.rows[0]?.present).toBe(false)
      await leasesUp(trx as never)
      const back = await sql<{ present: boolean }>`SELECT to_regclass('meta_automation_job_leases') IS NOT NULL AS present`.execute(trx)
      expect(back.rows[0]?.present).toBe(true)
      throw new Rollback('roll back the round trip')
    })).rejects.toBeInstanceOf(Rollback)
    expect(await rowCount()).toBeGreaterThan(0)
  })
})
