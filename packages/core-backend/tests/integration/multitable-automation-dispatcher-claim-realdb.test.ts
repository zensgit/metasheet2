/**
 * P2 durable-delivery — slice S2-a: claim engine / fence-CAS (real DB).
 *
 * Exercises the claim-engine primitives against real Postgres with CONSTRUCTED races (a race guard is only
 * proven by the interleaving it must survive):
 *   - claim flips pending→in_progress, bumps fence + attempts, stamps a lease, joins the outbox event;
 *   - `FOR UPDATE SKIP LOCKED` lets a claimer SKIP a row another transaction holds locked and take a
 *     different free row (the discriminating test — removing SKIP LOCKED makes it block → lock_timeout → red);
 *   - the ZOMBIE interleaving: claim (fence N) → lease expires → reclaim (fence N+1) → the stale-fence
 *     resolve writes 0 rows while the reclaimer wins;
 *   - **crash-safe poison**: a worker that always crashes after claiming never resolves, yet the row still
 *     dead-letters — the claim itself poisons a row at the attempt ceiling (driven only by persisted attempts);
 *   - **backoff, not immediate retry**: reschedule keeps the row in_progress and pushes the lease out, so it
 *     is re-claimed only after the lease expires (never instantly);
 *   - failure detail is values-free: only a typed reason code reaches `last_error`.
 *
 * Consumer keys are randomUUID()-scoped so this file never claims rows seeded by a parallel describeIfDatabase
 * sharing the one CI Postgres. Two-point wired (plugin-tests.yml + vitest.config.ts exclude).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  claimDueConsumers,
  completeConsumer,
  poisonConsumer,
  rescheduleConsumer,
  resolveDisposition,
} from '../../src/multitable/automation-durable-dispatcher'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const outboxIds: string[] = []
let seq = 0

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
    `SELECT status, fence::text AS fence, attempts, last_error, (lease_expires_at IS NULL) AS lease_null
       FROM meta_automation_outbox_consumer WHERE outbox_id=$1 AND consumer_key=$2`,
    [outboxId, consumerKey],
  )
  return rows[0] as { status: string; fence: string; attempts: number; last_error: string | null; lease_null: boolean }
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
    expect(mine.fence).toBe('1')
    expect(typeof mine.fence).toBe('string')
    expect(mine.attempts).toBe(1)
    expect(mine.eventType).toBe('approval.approved')
    expect(mine.eventId).toBe(`evt_${outboxId}`)
    expect(mine.payload).toMatchObject({ ob: outboxId })
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'in_progress', fence: '1', attempts: 1, lease_null: false })
  })

  test('SKIP LOCKED: a claimer skips a row another tx holds locked and takes a different FREE row', async () => {
    const locked = await seedRow()
    const free = await seedRow()
    const raw = db().getInternalPool()
    const a = await raw.connect()
    const b = await raw.connect()
    try {
      // B must not block indefinitely if the guard is ever removed — a lock wait then trips this timeout.
      await b.query("SET lock_timeout = '2000ms'")
      await a.query('BEGIN')
      // A holds a row lock on `locked` without committing.
      await a.query(
        `SELECT 1 FROM meta_automation_outbox_consumer WHERE outbox_id=$1 AND consumer_key=$2 FOR UPDATE`,
        [locked.outboxId, locked.consumerKey],
      )
      // B claims across both keys: SKIP LOCKED must let it skip `locked` and take `free` — NOT block on the lock.
      const claimed = await claimDueConsumers(b, { consumerKeys: [locked.consumerKey, free.consumerKey], batchSize: 10 })
      const keys = new Set(claimed.map((c) => c.consumerKey))
      expect(keys.has(free.consumerKey)).toBe(true) // took the free row
      expect(keys.has(locked.consumerKey)).toBe(false) // skipped the locked row, did not block on it
      await a.query('ROLLBACK')
    } finally {
      a.release()
      b.release()
    }
  })

  test('ZOMBIE fence-CAS: a stale-fence complete writes 0 rows; the reclaimer (new fence) wins', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [first] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(first.fence).toBe('1')
    await expireLease(outboxId, consumerKey)
    const [second] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(second.fence).toBe('2')
    expect(await completeConsumer(db(), outboxId, consumerKey, first.fence)).toBe(false) // zombie: 0 rows
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'in_progress' })
    expect(await completeConsumer(db(), outboxId, consumerKey, second.fence)).toBe(true) // reclaimer wins
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'done', lease_null: true })
  })

  test('complete happy-path → done, lease cleared; a repeat complete is a no-op', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(await completeConsumer(db(), outboxId, consumerKey, c.fence)).toBe(true)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'done', lease_null: true })
    expect(await completeConsumer(db(), outboxId, consumerKey, c.fence)).toBe(false)
  })

  test('reschedule keeps in_progress with a BACKOFF lease — NOT immediately reclaimable; reclaimed after expiry', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c1] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(await rescheduleConsumer(db(), outboxId, consumerKey, c1.fence, 60_000, 'adapter_error')).toBe(true)
    // stays in_progress (NOT flipped to a pending that would be instantly reclaimable), attempts unchanged
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'in_progress', attempts: 1, lease_null: false })
    // within the backoff window the row is NOT reclaimable
    expect(await claimDueConsumers(db(), { consumerKeys: [consumerKey] })).toHaveLength(0)
    // once the backoff lease expires, it IS reclaimed (fence + attempts advance)
    await expireLease(outboxId, consumerKey)
    const [c2] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(c2.fence).toBe('2')
    expect(c2.attempts).toBe(2)
  })

  test('CRASH-SAFE poison: a worker that always crashes after claim still dead-letters at the ceiling', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const MAX = 3
    for (let i = 1; i <= MAX; i++) {
      const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey], maxAttempts: MAX })
      expect(c.attempts).toBe(i) // dispatched
      await expireLease(outboxId, consumerKey) // "crash" → no resolve → lease expires
    }
    // the next claim finds attempts === ceiling and poisons it WITHOUT dispatching (no worker needed)
    const poisoned = await claimDueConsumers(db(), { consumerKeys: [consumerKey], maxAttempts: MAX })
    expect(poisoned).toHaveLength(0)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({
      status: 'dead_letter',
      attempts: MAX, // capped
      last_error: 'max_attempts_exhausted',
      lease_null: true,
    })
    // terminal: never reclaimed again
    await expireLease(outboxId, consumerKey).catch(() => {})
    expect(await claimDueConsumers(db(), { consumerKeys: [consumerKey], maxAttempts: MAX })).toHaveLength(0)
  })

  test('poison (deterministic permanent failure) → dead_letter, lease cleared, terminal', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(await poisonConsumer(db(), outboxId, consumerKey, c.fence, 'permanent_rejection')).toBe(true)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'dead_letter', last_error: 'permanent_rejection', lease_null: true })
    expect(await claimDueConsumers(db(), { consumerKeys: [consumerKey], batchSize: 10 })).toHaveLength(0)
  })

  test('attempts increment AT CLAIM across reclaims (crash-after-claim marches toward the ceiling)', async () => {
    const { outboxId, consumerKey } = await seedRow()
    for (let i = 1; i <= 3; i++) {
      const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey], maxAttempts: 100 })
      expect(c.attempts).toBe(i)
      expect(c.fence).toBe(String(i))
      await expireLease(outboxId, consumerKey)
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

  test('input validation: non-positive leaseMs/retryDelayMs and an off-vocabulary reason all throw', async () => {
    const { outboxId, consumerKey } = await seedRow()
    await expect(claimDueConsumers(db(), { consumerKeys: [consumerKey], leaseMs: -1 })).rejects.toThrow(/leaseMs/)
    await expect(claimDueConsumers(db(), { consumerKeys: [consumerKey], leaseMs: 0 })).rejects.toThrow(/leaseMs/)
    const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    await expect(rescheduleConsumer(db(), outboxId, consumerKey, c.fence, 0, 'adapter_error')).rejects.toThrow(/retryDelayMs/)
    // values-free guard: a raw (secret-shaped) string is rejected before it can reach the DB
    await expect(
      poisonConsumer(db(), outboxId, consumerKey, c.fence, 'https://api/internal?token=SECRET' as never),
    ).rejects.toThrow(/values-free/)
  })

  test('last_error only ever holds a values-free code (never a raw message)', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    await rescheduleConsumer(db(), outboxId, consumerKey, c.fence, 30_000, 'adapter_timeout')
    expect((await readRow(outboxId, consumerKey)).last_error).toBe('adapter_timeout')
  })

  test('resolveDisposition (pure): success→complete; retryable→reschedule; permanent→poison', () => {
    expect(resolveDisposition('success')).toBe('complete')
    expect(resolveDisposition('retryable_failure')).toBe('reschedule')
    expect(resolveDisposition('permanent_failure')).toBe('poison')
  })
})
