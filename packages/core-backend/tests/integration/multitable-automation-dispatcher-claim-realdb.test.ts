/**
 * P2 durable-delivery — slice S2-a: claim engine / fence-CAS (real DB).
 *
 * Exercises the four claim-engine primitives against real Postgres, with CONSTRUCTED races (not sequential
 * arguments — a race guard is only proven by the interleaving it must survive):
 *   - claim flips pending→in_progress, bumps fence + attempts, stamps a lease, joins the outbox event;
 *   - `FOR UPDATE SKIP LOCKED` gives two concurrent claimers disjoint rows (exactly one wins a single due row);
 *   - the ZOMBIE interleaving: a worker claims (fence N), its lease expires, a reclaimer takes it (fence N+1),
 *     and the zombie's stale-fence resolve writes 0 rows while the reclaimer's wins;
 *   - complete/release/poison land the documented terminal/reclaimable states and clear the lease;
 *   - attempts increment AT CLAIM, so a crash-after-claim still marches the row to the poison ceiling.
 *
 * Consumer keys are randomUUID()-scoped so this file never claims rows seeded by a parallel describeIfDatabase
 * sharing the one CI Postgres. Runs only with DATABASE_URL (two-point wired: plugin-tests.yml real-DB run +
 * vitest.config.ts exclude, so it cannot skip-green).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  claimDueConsumers,
  completeConsumer,
  poisonConsumer,
  releaseConsumer,
  resolveDisposition,
} from '../../src/multitable/automation-durable-dispatcher'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const outboxIds: string[] = []
let seq = 0

// Seed a valid outbox event + one consumer row, with a RUN-scoped unique consumer_key (isolation).
async function seedRow(opts: { status?: string; lease?: string | null } = {}) {
  const id = `ob_s2_${RUN}_${seq}`
  const consumerKey = `ck_${RUN}_${seq}`
  seq += 1
  outboxIds.push(id)
  await db().query(
    `INSERT INTO meta_automation_outbox (id, event_type, payload, automation_depth, manifest_version, event_id)
     VALUES ($1,'approval.approved',$2::jsonb,0,1,$3)`,
    [id, JSON.stringify({ ob: id }), `evt_${id}`],
  )
  await db().query(
    `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
     VALUES ($1,$2,$3,$4::timestamptz)`,
    [id, consumerKey, opts.status ?? 'pending', opts.lease ?? null],
  )
  return { outboxId: id, consumerKey }
}

async function readRow(outboxId: string, consumerKey: string) {
  const { rows } = await db().query(
    `SELECT status, fence::text AS fence, attempts, (lease_expires_at IS NULL) AS lease_null
       FROM meta_automation_outbox_consumer WHERE outbox_id=$1 AND consumer_key=$2`,
    [outboxId, consumerKey],
  )
  return rows[0] as { status: string; fence: string; attempts: number; lease_null: boolean }
}

async function expireLease(outboxId: string, consumerKey: string) {
  await db().query(
    `UPDATE meta_automation_outbox_consumer SET lease_expires_at = now() - interval '1 minute'
      WHERE outbox_id=$1 AND consumer_key=$2`,
    [outboxId, consumerKey],
  )
}

describeIfDatabase('P2 durable-delivery S2-a — claim engine / fence-CAS (real DB)', () => {
  afterAll(async () => {
    if (outboxIds.length) {
      await db().query('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [outboxIds]).catch(() => {})
    }
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('claim flips pending→in_progress, bumps fence+attempts, stamps lease, joins the event', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [mine] = await claimDueConsumers(db(), { consumerKeys: [consumerKey], batchSize: 10 })
    expect(mine).toBeTruthy()
    expect(mine.fence).toBe('1') // 0 -> 1
    expect(typeof mine.fence).toBe('string') // bigint as string, never a JS number
    expect(mine.attempts).toBe(1) // 0 -> 1 AT CLAIM
    expect(mine.eventType).toBe('approval.approved')
    expect(mine.eventId).toBe(`evt_${outboxId}`)
    expect(mine.payload).toMatchObject({ ob: outboxId })
    expect(await readRow(outboxId, consumerKey)).toMatchObject({
      status: 'in_progress',
      fence: '1',
      attempts: 1,
      lease_null: false, // in_progress MUST carry a lease (the biconditional)
    })
  })

  test('SKIP LOCKED: two concurrent claimers over one due row → exactly one wins (no double-claim)', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const raw = db().getInternalPool()
    const a = await raw.connect()
    const b = await raw.connect()
    try {
      const [ra, rb] = await Promise.all([
        claimDueConsumers(a, { consumerKeys: [consumerKey], batchSize: 10 }),
        claimDueConsumers(b, { consumerKeys: [consumerKey], batchSize: 10 }),
      ])
      const wins = [ra, rb].map((rs) => rs.filter((c) => c.outboxId === outboxId).length)
      expect(wins[0] + wins[1]).toBe(1) // exactly one connection claimed the single due row
    } finally {
      a.release()
      b.release()
    }
    // claimed exactly once → attempts incremented exactly once (not double)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'in_progress', attempts: 1 })
  })

  test('ZOMBIE fence-CAS: a stale-fence complete writes 0 rows; the reclaimer (new fence) wins', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [first] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] }) // fence 1
    expect(first.fence).toBe('1')
    await expireLease(outboxId, consumerKey) // worker stalled past its lease
    const [second] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] }) // reclaim → fence 2
    expect(second.fence).toBe('2')
    // the zombie (still holding fence 1) tries to finish: fence-CAS mismatch → no-op
    expect(await completeConsumer(db(), outboxId, consumerKey, first.fence)).toBe(false)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'in_progress' }) // NOT done — reclaimer owns it
    // the reclaimer (fence 2) finishes → done
    expect(await completeConsumer(db(), outboxId, consumerKey, second.fence)).toBe(true)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'done', lease_null: true })
  })

  test('complete happy-path → done, lease cleared; a repeat complete is a no-op', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(await completeConsumer(db(), outboxId, consumerKey, c.fence)).toBe(true)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'done', lease_null: true })
    // idempotent: the row is no longer in_progress, so the CAS matches 0 rows
    expect(await completeConsumer(db(), outboxId, consumerKey, c.fence)).toBe(false)
  })

  test('release → pending (immediately reclaimable), lease cleared, attempts accumulate on reclaim', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c1] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(c1.attempts).toBe(1)
    expect(await releaseConsumer(db(), outboxId, consumerKey, c1.fence, 'transient boom')).toBe(true)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'pending', lease_null: true, attempts: 1 })
    const [c2] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] }) // reclaimable right away
    expect(c2.fence).toBe('2') // fence bumped each claim
    expect(c2.attempts).toBe(2) // marches toward the ceiling (release did NOT reset it)
  })

  test('poison → dead_letter, lease cleared, terminal (never reclaimed by a later claim)', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(await poisonConsumer(db(), outboxId, consumerKey, c.fence, 'exhausted')).toBe(true)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'dead_letter', lease_null: true })
    const again = await claimDueConsumers(db(), { consumerKeys: [consumerKey], batchSize: 10 })
    expect(again.find((x) => x.outboxId === outboxId)).toBeFalsy() // dead_letter is terminal, not reclaimable
  })

  test('attempts increment AT CLAIM across reclaims (crash-after-claim still marches to the ceiling)', async () => {
    const { outboxId, consumerKey } = await seedRow()
    for (let i = 1; i <= 3; i++) {
      const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
      expect(c.attempts).toBe(i) // bumped even though the "worker" never resolves (simulated crash)
      expect(c.fence).toBe(String(i))
      await expireLease(outboxId, consumerKey) // crash → lease expires → next round reclaims
    }
  })

  test('claim respects the consumer_keys filter (does not touch other keys)', async () => {
    const a = await seedRow()
    const b = await seedRow()
    const claimed = await claimDueConsumers(db(), { consumerKeys: [a.consumerKey], batchSize: 50 })
    const keys = new Set(claimed.map((c) => c.consumerKey))
    expect(keys.has(a.consumerKey)).toBe(true)
    expect(keys.has(b.consumerKey)).toBe(false)
  })

  test('resolveDisposition (pure): success→complete; failure<ceiling→release; failure≥ceiling→poison', () => {
    expect(resolveDisposition('success', 1)).toBe('complete')
    expect(resolveDisposition('failure', 1, 8)).toBe('release')
    expect(resolveDisposition('failure', 7, 8)).toBe('release')
    expect(resolveDisposition('failure', 8, 8)).toBe('poison')
    expect(resolveDisposition('failure', 9, 8)).toBe('poison')
    expect(resolveDisposition('success', 99, 8)).toBe('complete') // success completes even past the ceiling
  })
})
