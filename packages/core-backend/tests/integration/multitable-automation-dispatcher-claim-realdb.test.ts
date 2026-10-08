/**
 * P2 durable-delivery — slice S2-a: claim engine / fence-CAS (real DB).
 *
 * Exercises the claim-engine primitives against real Postgres with CONSTRUCTED races:
 *   - claim flips pending→in_progress, bumps fence + attempts, stamps a lease, joins the outbox event;
 *   - `FOR UPDATE SKIP LOCKED` lets a claimer SKIP a row another tx holds locked and take a different free
 *     row (removing SKIP LOCKED makes it block → the tx-scoped lock_timeout trips → red);
 *   - the ZOMBIE interleaving: a stale-fence resolve writes 0 rows while the reclaimer wins;
 *   - crash-safe poison at the ceiling (no surviving worker needed);
 *   - reschedule keeps the row in_progress with a backoff lease AND bumps the fence, so the token is dead
 *     (a late complete with the old fence is a no-op);
 *   - rolling deploy: an unknown consumer_key is left `pending` (never claimed/dead-lettered) and surfaced
 *     for alert (#4203 §246);
 *   - numeric params are validated safe-integers-in-bounds; failure detail is a values-free code.
 *
 * Consumer keys are randomUUID()-scoped for shared-DB isolation. Two-point wired (plugin-tests.yml +
 * vitest.config.ts exclude).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  claimDueConsumers,
  completeConsumer,
  findUnknownConsumerKeys,
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
      await a.query('BEGIN')
      // A holds a row lock on `locked` without committing.
      await a.query(
        `SELECT 1 FROM meta_automation_outbox_consumer WHERE outbox_id=$1 AND consumer_key=$2 FOR UPDATE`,
        [locked.outboxId, locked.consumerKey],
      )
      // B claims inside its own tx with a TX-SCOPED lock_timeout (SET LOCAL → auto-reset, no pool pollution).
      // SKIP LOCKED must let B skip the locked row and take the free one — NOT block on the lock.
      await b.query('BEGIN')
      await b.query("SET LOCAL lock_timeout = '2000ms'")
      const claimed = await claimDueConsumers(b, { consumerKeys: [locked.consumerKey, free.consumerKey], batchSize: 10 })
      await b.query('COMMIT')
      const keys = new Set(claimed.map((c) => c.consumerKey))
      expect(keys.has(free.consumerKey)).toBe(true) // took the free row
      expect(keys.has(locked.consumerKey)).toBe(false) // skipped the locked row, did not block on it
    } finally {
      // best-effort: release A's lock, and clear B's tx whether it committed or aborted (mutation path).
      await a.query('ROLLBACK').catch(() => {})
      await b.query('ROLLBACK').catch(() => {})
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
    expect(await completeConsumer(db(), outboxId, consumerKey, first.fence)).toBe(false)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'in_progress' })
    expect(await completeConsumer(db(), outboxId, consumerKey, second.fence)).toBe(true)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'done', lease_null: true })
  })

  test('complete happy-path → done, lease cleared; a repeat complete is a no-op', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(await completeConsumer(db(), outboxId, consumerKey, c.fence)).toBe(true)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'done', lease_null: true })
    expect(await completeConsumer(db(), outboxId, consumerKey, c.fence)).toBe(false)
  })

  test('reschedule: backoff lease (not instantly reclaimable) + BUMPS fence (old token dead); reclaimed after expiry', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c1] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(c1.fence).toBe('1')
    expect(await rescheduleConsumer(db(), outboxId, consumerKey, c1.fence, 60_000, 'adapter_error')).toBe(true)
    // fence bumped 1→2, still in_progress, attempts unchanged
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'in_progress', fence: '2', attempts: 1, lease_null: false })
    // the token c1.fence is now DEAD: a late worker holding it cannot complete (or poison/reschedule) the row
    expect(await completeConsumer(db(), outboxId, consumerKey, c1.fence)).toBe(false)
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'in_progress' }) // not done
    // within the backoff window the row is NOT reclaimable
    expect(await claimDueConsumers(db(), { consumerKeys: [consumerKey] })).toHaveLength(0)
    // after the backoff lease expires it IS reclaimed (fence + attempts advance)
    await expireLease(outboxId, consumerKey)
    const [c2] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(c2.fence).toBe('3') // 1 (claim) → 2 (reschedule bump) → 3 (reclaim)
    expect(c2.attempts).toBe(2)
  })

  test('CRASH-SAFE poison: a worker that always crashes after claim still dead-letters at the ceiling', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const MAX = 3
    for (let i = 1; i <= MAX; i++) {
      const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey], maxAttempts: MAX })
      expect(c.attempts).toBe(i)
      await expireLease(outboxId, consumerKey) // "crash" → no resolve → lease expires
    }
    const poisoned = await claimDueConsumers(db(), { consumerKeys: [consumerKey], maxAttempts: MAX })
    expect(poisoned).toHaveLength(0) // poisoned at claim, NOT dispatched
    expect(await readRow(outboxId, consumerKey)).toMatchObject({
      status: 'dead_letter',
      attempts: MAX,
      last_error: 'max_attempts_exhausted',
      lease_null: true,
    })
    await expireLease(outboxId, consumerKey).catch(() => {})
    expect(await claimDueConsumers(db(), { consumerKeys: [consumerKey], maxAttempts: MAX })).toHaveLength(0)
  })

  test('rolling deploy: an unknown consumer_key stays pending (never claimed/dead-lettered) and is surfaced for alert', async () => {
    const { outboxId, consumerKey } = await seedRow() // only "worker N" knows consumerKey
    const nMinus1Keys = [`ck_${RUN}_unrelated`] // "worker N-1" knows a different key
    // N-1 claims with ITS keys → must not touch the unknown-to-it row
    const byNminus1 = await claimDueConsumers(db(), { consumerKeys: nMinus1Keys, batchSize: 10 })
    expect(byNminus1.find((c) => c.outboxId === outboxId)).toBeFalsy()
    // even repeated N-1 claims never dead-letter it (it is never claimed → attempts stays 0, status pending)
    for (let i = 0; i < 10; i++) await claimDueConsumers(db(), { consumerKeys: nMinus1Keys, maxAttempts: 3 })
    expect(await readRow(outboxId, consumerKey)).toMatchObject({ status: 'pending', attempts: 0 })
    // the alert seam surfaces the key as unknown to N-1
    expect(await findUnknownConsumerKeys(db(), nMinus1Keys)).toContain(consumerKey)
    // "worker N" (knows the key) processes it normally
    const byN = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    expect(byN.find((c) => c.outboxId === outboxId)).toBeTruthy()
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

  test('input validation: keys required, numeric params must be safe integers in bounds, reason values-free', async () => {
    const { outboxId, consumerKey } = await seedRow()
    await expect(claimDueConsumers(db(), { consumerKeys: [] })).rejects.toThrow(/consumerKeys/)
    await expect(claimDueConsumers(db(), {} as never)).rejects.toThrow(/consumerKeys/)
    await expect(claimDueConsumers(db(), { consumerKeys: [consumerKey], leaseMs: -1 })).rejects.toThrow(/leaseMs/)
    await expect(claimDueConsumers(db(), { consumerKeys: [consumerKey], leaseMs: 1.5 })).rejects.toThrow(/leaseMs/) // fractional
    await expect(claimDueConsumers(db(), { consumerKeys: [consumerKey], leaseMs: 1e15 })).rejects.toThrow(/leaseMs/) // over cap
    await expect(claimDueConsumers(db(), { consumerKeys: [consumerKey], batchSize: 0 })).rejects.toThrow(/batchSize/)
    await expect(claimDueConsumers(db(), { consumerKeys: [consumerKey], maxAttempts: 0 })).rejects.toThrow(/maxAttempts/)
    const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    await expect(rescheduleConsumer(db(), outboxId, consumerKey, c.fence, 0, 'adapter_error')).rejects.toThrow(/retryDelayMs/)
    await expect(rescheduleConsumer(db(), outboxId, consumerKey, c.fence, 2.5, 'adapter_error')).rejects.toThrow(/retryDelayMs/)
    await expect(poisonConsumer(db(), outboxId, consumerKey, c.fence, 'https://api/internal?token=SECRET' as never)).rejects.toThrow(/values-free/)
  })

  test('last_error only ever holds a values-free code (never a raw message)', async () => {
    const { outboxId, consumerKey } = await seedRow()
    const [c] = await claimDueConsumers(db(), { consumerKeys: [consumerKey] })
    await rescheduleConsumer(db(), outboxId, consumerKey, c.fence, 30_000, 'adapter_timeout')
    expect((await readRow(outboxId, consumerKey)).last_error).toBe('adapter_timeout')
  })

  // [#4497 P1] Terminal writes are fence-CAS **and** still-holding-the-lease. Fence-CAS alone leaves the window
  // where our lease EXPIRED but no competitor has reclaimed yet: writing `done`/`dead_letter` there applies a
  // result produced without ownership and races the reclaimer entitled to the row (the same reason
  // directory-sync's completion write guards its terminal UPDATE and aborts on a miss).
  test('LEASE-GUARD: complete/poison are refused once the lease expired; the reclaim path still resolves', async () => {
    const a = await seedRow()
    const [ca] = await claimDueConsumers(db(), { consumerKeys: [a.consumerKey] })
    await expireLease(a.outboxId, a.consumerKey)
    expect(await completeConsumer(db(), a.outboxId, a.consumerKey, ca.fence)).toBe(false)
    expect(await readRow(a.outboxId, a.consumerKey)).toMatchObject({ status: 'in_progress' }) // not `done`
    const b = await seedRow()
    const [cb] = await claimDueConsumers(db(), { consumerKeys: [b.consumerKey] })
    await expireLease(b.outboxId, b.consumerKey)
    expect(await poisonConsumer(db(), b.outboxId, b.consumerKey, cb.fence, 'permanent_rejection')).toBe(false)
    expect(await readRow(b.outboxId, b.consumerKey)).toMatchObject({ status: 'in_progress' }) // event not dropped
    // POSITIVE CONTROL: with the lease actually HELD (a fresh reclaim) both terminals still work — the guard is
    // "refuse a write we no longer own", not "refuse everything".
    const [ra] = await claimDueConsumers(db(), { consumerKeys: [a.consumerKey] })
    expect(await completeConsumer(db(), a.outboxId, a.consumerKey, ra.fence)).toBe(true)
    expect(await readRow(a.outboxId, a.consumerKey)).toMatchObject({ status: 'done', lease_null: true })
    const [rb] = await claimDueConsumers(db(), { consumerKeys: [b.consumerKey] })
    expect(await poisonConsumer(db(), b.outboxId, b.consumerKey, rb.fence, 'permanent_rejection')).toBe(true)
    expect(await readRow(b.outboxId, b.consumerKey)).toMatchObject({ status: 'dead_letter', lease_null: true })
  })

  // [#4497 P1] `excludeRows` is what stops a caller re-claiming a row it is already handling in this pass. It
  // must EXCLUDE the pair (not the outbox id, not the key alone) and must SCAN PAST it, never head-of-line block.
  test('excludeRows: an already-handled pair is not re-claimed; the scan takes the next row instead', async () => {
    const held = await seedRow()
    const next = await seedRow()
    const keys = [held.consumerKey, next.consumerKey]
    const [c] = await claimDueConsumers(db(), { consumerKeys: keys, batchSize: 1 })
    expect(c.outboxId).toBe(held.outboxId) // seeded first → oldest updated_at → the head
    await expireLease(held.outboxId, held.consumerKey) // reclaimable again as far as the lease is concerned
    const excluded = await claimDueConsumers(db(), {
      consumerKeys: keys,
      batchSize: 10,
      excludeRows: [{ outboxId: held.outboxId, consumerKey: held.consumerKey }],
    })
    expect(excluded.map((x) => x.outboxId)).toEqual([next.outboxId]) // skipped past the excluded pair
    expect(await readRow(held.outboxId, held.consumerKey)).toMatchObject({ status: 'in_progress', attempts: 1 }) // untouched
    // without the exclusion the very same call DOES re-claim it (attempts 1→2) — the exclusion is load-bearing.
    const reclaimed = await claimDueConsumers(db(), { consumerKeys: keys, batchSize: 10 })
    expect(reclaimed.map((x) => x.outboxId)).toEqual([held.outboxId])
    expect(await readRow(held.outboxId, held.consumerKey)).toMatchObject({ attempts: 2 })
    // a malformed entry THROWS (silently dropping it would silently re-open the hole)
    await expect(
      claimDueConsumers(db(), { consumerKeys: keys, excludeRows: [{ outboxId: '', consumerKey: held.consumerKey }] }),
    ).rejects.toThrow(/excludeRows/)
  })

  test('resolveDisposition (pure): success→complete; retryable→reschedule; permanent→poison', () => {
    expect(resolveDisposition('success')).toBe('complete')
    expect(resolveDisposition('retryable_failure')).toBe('reschedule')
    expect(resolveDisposition('permanent_failure')).toBe('poison')
  })
})
