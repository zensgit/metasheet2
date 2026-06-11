/**
 * Real-DB integration test for the webhook retry tick (rank-5 wiring).
 *
 * The retry half of the outbound pipeline: retryFailedDeliveries() picks up `pending`
 * delivery rows whose next_retry_at has elapsed and re-attempts delivery. This proves
 * the SCHEDULED path — a WebhookRetryScheduler.tick() (the leader-elected periodic
 * entry the app schedules) drives that pickup through the real Postgres wire, not just
 * a direct service call against a mock db.
 *
 * Seed a webhook + a `pending` delivery row with next_retry_at in the PAST, then run
 * one scheduler tick with a WebhookService bound to the real db + a loopback fetch
 * (no external calls). Assert the tick reports the row retried, the loopback sink got
 * the POST, and the row transitions out of the due-pending state.
 *
 * Runs only with DATABASE_URL (plugin-tests.yml multitable real-DB job).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { WebhookService } from '../../src/multitable/webhook-service'
import { WebhookRetryScheduler } from '../../src/services/WebhookRetryScheduler'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const WH_ID = `whk_retry_${TS}`
const DEL_DUE = `del_retry_due_${TS}` // pending, next_retry_at in the past — must be picked up
const DEL_FUTURE = `del_retry_future_${TS}` // pending, next_retry_at in the future — must be skipped
const USER_ID = `u_whk_retry_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let captured: string[] = []

const loopbackFetch = (async (url: unknown) => {
  captured.push(String(url))
  return { ok: true, status: 200, text: async () => 'ok' } as Response
}) as unknown as typeof fetch

describeIfDatabase('webhook retry tick (real DB)', () => {
  beforeAll(async () => {
    const now = new Date().toISOString()
    await q(
      'INSERT INTO multitable_webhooks (id, name, url, secret, events, active, created_by, created_at, failure_count, max_retries) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
      [WH_ID, 'Retry', 'https://sink.test/retry', null, JSON.stringify(['record.updated']), true, USER_ID, now, 1, 3],
    )
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 600_000).toISOString()
    // Due pending delivery (attempt_count 1 < max_retries 3) → eligible for retry.
    await q(
      'INSERT INTO multitable_webhook_deliveries (id, webhook_id, event, payload, status, attempt_count, created_at, next_retry_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
      [DEL_DUE, WH_ID, 'record.updated', JSON.stringify({ recordId: 'r1' }), 'pending', 1, now, past],
    )
    // Not-yet-due pending delivery → must be skipped by the same pass.
    await q(
      'INSERT INTO multitable_webhook_deliveries (id, webhook_id, event, payload, status, attempt_count, created_at, next_retry_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
      [DEL_FUTURE, WH_ID, 'record.updated', JSON.stringify({ recordId: 'r2' }), 'pending', 1, now, future],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM multitable_webhook_deliveries WHERE webhook_id = $1', [WH_ID]).catch(() => {})
    await q('DELETE FROM multitable_webhooks WHERE id = $1', [WH_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('a pending delivery past next_retry_at is picked up by the scheduled tick path', async () => {
    captured = []
    // No leaderOptions → the scheduler is leader immediately (single-process). We call
    // tick() directly (the same entry the interval drives) so the test is deterministic
    // and does not depend on wall-clock interval timing.
    const scheduler = new WebhookRetryScheduler({
      service: new WebhookService(db, loopbackFetch),
    })
    expect(scheduler.leader).toBe(true)

    const retried = await scheduler.tick()
    expect(retried).toBe(1) // exactly the due row; the future row is skipped

    // The loopback sink received the re-attempt POST for the due delivery's webhook.
    expect(captured).toContain('https://sink.test/retry')

    // The due delivery transitioned out of the due-pending state (success on the
    // loopback 200), while the future delivery is untouched.
    const due = await q('SELECT status FROM multitable_webhook_deliveries WHERE id = $1', [DEL_DUE])
    expect(due.rows[0].status).toBe('success')
    const future = await q('SELECT status, next_retry_at FROM multitable_webhook_deliveries WHERE id = $1', [DEL_FUTURE])
    expect(future.rows[0].status).toBe('pending')

    scheduler.stop()
  })

  test('a second tick does no work once the due delivery is resolved', async () => {
    captured = []
    const scheduler = new WebhookRetryScheduler({
      service: new WebhookService(db, loopbackFetch),
    })
    const retried = await scheduler.tick()
    expect(retried).toBe(0)
    expect(captured).not.toContain('https://sink.test/retry')
    scheduler.stop()
  })

  test('MINOR-1: two concurrent retry passes claim the due row exactly once (no double-delivery)', async () => {
    // Re-arm the due row to pending+due, then run two retryFailedDeliveries() passes
    // concurrently (simulating two replicas ticking at once). FOR UPDATE SKIP LOCKED +
    // the next_retry_at lease must let exactly one pass claim+deliver it.
    captured = []
    await q(
      "UPDATE multitable_webhook_deliveries SET status = 'pending', attempt_count = 0, next_retry_at = now() - interval '1 minute' WHERE id = $1",
      [DEL_DUE],
    )
    const svcA = new WebhookService(db, loopbackFetch)
    const svcB = new WebhookService(db, loopbackFetch)
    const [a, b] = await Promise.all([svcA.retryFailedDeliveries(), svcB.retryFailedDeliveries()])
    expect(a + b).toBe(1) // exactly one pass did the work
    expect(captured.filter((u) => u === 'https://sink.test/retry')).toHaveLength(1) // delivered once
  })
})
