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
 * ISOLATION CONTRACT (audit B2, 2026-07-20)
 * -----------------------------------------
 * `retryFailedDeliveries()` claims PROCESS-WIDE: every due `pending` row in the whole
 * database, whatever webhook it belongs to. That is the correct production semantic (a
 * leader tick must drain the queue, not a slice of it) and is NOT changed here. The
 * consequence for a spec sharing one CI Postgres with dozens of other suites is that the
 * tick's RETURN VALUE is a global count, so `expect(retried).toBe(1)` was an assertion
 * about the entire database — it went red the moment any other suite left a claimable row
 * behind. The S5 stray-grace leg (webhook-service.ts: `next_retry_at IS NULL AND
 * created_at <= now() - FIRST_ATTEMPT_STRAY_GRACE_MS`) widened that blast radius to every
 * abandoned first-attempt row in the database.
 *
 * Therefore every assertion below is scoped to rows THIS FILE created (ids carry the
 * per-run `TS` suffix; the sink URLs carry it too, so `captured` can be filtered to our
 * own webhooks). `beforeAll` deliberately seeds a FOREIGN webhook + a claimable foreign
 * stray delivery, and each work-doing test re-seeds another, so the suite proves it is
 * green in the presence of unrelated claimable rows.
 *
 * What the production tick does to those foreign rows: it claims, leases and DELIVERS
 * them through this test's loopback fetch, marking them `success`. That is inherent to the
 * process-wide claim, so this suite makes NO assertion about a foreign row's fate — it must
 * never depend on it. (Whether the tick should be scoped at all is a production question,
 * out of scope for this test-isolation fix.)
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
const DEL_STRAY = `del_retry_stray_${TS}` // pending, next_retry_at NULL, created past the grace
const DEL_FRESH = `del_retry_fresh_${TS}` // pending, next_retry_at NULL, created just now (in flight)
const USER_ID = `u_whk_retry_${TS}`
// Per-run sink URLs: `captured` is a process-wide record of everything this test's fetch
// stub was asked to POST, INCLUDING foreign rows the process-wide claim swept in. Filtering
// by these unique URLs is what makes a "delivered exactly once" assertion mean OUR row.
const SINK_URL = `https://sink.test/retry/${TS}`
const POLICY_SINK_URL = `https://sink.test/policy/${TS}`

// Foreign fixture: a webhook + deliveries that do NOT belong to this suite's assertions.
// Their only job is to be claimable by the process-wide tick, so a scoping regression in
// this file fails loudly here instead of silently on CI when another suite happens to
// leave a stray behind.
const FOREIGN_WH_ID = `whk_b2_foreign_${TS}`
const FOREIGN_SINK_URL = `https://sink.test/b2-foreign/${TS}`
let foreignSeq = 0

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const insertDelivery = (
  id: string,
  webhookId: string,
  recordId: string,
  status: string,
  attemptCount: number,
  createdAt: string,
  nextRetryAt: string | null,
) =>
  q(
    'INSERT INTO multitable_webhook_deliveries (id, webhook_id, event, payload, status, attempt_count, created_at, next_retry_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
    [id, webhookId, 'record.updated', JSON.stringify({ recordId }), status, attemptCount, createdAt, nextRetryAt],
  )

/**
 * Seed one FOREIGN claimable row: `pending`, next_retry_at NULL, created well past the
 * first-attempt stray grace — i.e. exactly the shape the S5 stray leg claims, and exactly
 * what an abandoned delivery from any other suite looks like on the shared CI database.
 * Returns its id purely for cleanup bookkeeping; no test may assert on its fate.
 */
const seedForeignClaimableRow = async (): Promise<string> => {
  const id = `del_b2_foreign_${TS}_${foreignSeq++}`
  await insertDelivery(
    id,
    FOREIGN_WH_ID,
    'r-foreign',
    'pending',
    0,
    new Date(Date.now() - 10 * 60_000).toISOString(),
    null,
  )
  return id
}

let captured: string[] = []
const postsTo = (url: string) => captured.filter((u) => u === url)

const loopbackFetch = (async (url: unknown) => {
  captured.push(String(url))
  return { ok: true, status: 200, text: async () => 'ok' } as Response
}) as unknown as typeof fetch

describeIfDatabase('webhook retry tick (real DB)', () => {
  beforeAll(async () => {
    const now = new Date().toISOString()
    await q(
      'INSERT INTO multitable_webhooks (id, name, url, secret, events, active, created_by, created_at, failure_count, max_retries) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
      [WH_ID, 'Retry', SINK_URL, null, JSON.stringify(['record.updated']), true, USER_ID, now, 1, 3],
    )
    // Foreign webhook — a different owner for the deliberately-planted claimable rows.
    await q(
      'INSERT INTO multitable_webhooks (id, name, url, secret, events, active, created_by, created_at, failure_count, max_retries) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
      [
        FOREIGN_WH_ID,
        'B2 foreign',
        FOREIGN_SINK_URL,
        null,
        JSON.stringify(['record.updated']),
        true,
        `u_b2_foreign_${TS}`,
        now,
        0,
        3,
      ],
    )
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 600_000).toISOString()
    // Due pending delivery (attempt_count 1 < max_retries 3) → eligible for retry.
    await insertDelivery(DEL_DUE, WH_ID, 'r1', 'pending', 1, now, past)
    // Not-yet-due pending delivery → must be skipped by the same pass.
    await insertDelivery(DEL_FUTURE, WH_ID, 'r2', 'pending', 1, now, future)
    // Foreign claimable row present from the very first tick.
    await seedForeignClaimableRow()
  })

  afterAll(async () => {
    await q('DELETE FROM multitable_webhook_deliveries WHERE webhook_id = ANY($1)', [
      [WH_ID, FOREIGN_WH_ID],
    ]).catch(() => {})
    await q('DELETE FROM multitable_webhooks WHERE id = ANY($1)', [[WH_ID, FOREIGN_WH_ID]]).catch(() => {})
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

    await scheduler.tick()

    // Scoped "exactly the due row" assertion: the loopback sink received exactly ONE POST
    // for THIS suite's webhook — the due delivery. The future row is skipped, so a second
    // POST to SINK_URL would mean the tick took a not-yet-due row. The tick's own return
    // value is deliberately NOT asserted: it counts every row claimed database-wide
    // (including the foreign stray seeded above), so it is not this suite's to own.
    expect(postsTo(SINK_URL)).toHaveLength(1)

    // The due delivery transitioned out of the due-pending state (success on the
    // loopback 200), while the future delivery is untouched.
    const due = await q('SELECT status FROM multitable_webhook_deliveries WHERE id = $1', [DEL_DUE])
    expect(due.rows[0].status).toBe('success')
    const future = await q('SELECT status, next_retry_at FROM multitable_webhook_deliveries WHERE id = $1', [DEL_FUTURE])
    expect(future.rows[0].status).toBe('pending')
    // Not claimed ⇒ not leased: its next_retry_at is still the future timestamp we seeded,
    // not the claim lease the tick stamps on rows it takes.
    expect(new Date(future.rows[0].next_retry_at).getTime()).toBeGreaterThan(Date.now() + 60_000)

    scheduler.stop()
  })

  test('FIRST-ATTEMPT stray recovery: pending + next_retry_at NULL past the grace is claimed; a fresh in-flight first attempt is NOT', async () => {
    // deliverEvent fire-and-forgets the first HTTP attempt; a crash before the outcome handler stamps
    // status/next_retry_at leaves pending + next_retry_at NULL — formerly a stuck absorbing state the
    // scheduled-retry leg could never select (sink audit 2026-07-17).
    captured = []
    await seedForeignClaimableRow() // unrelated claimable row present for this pass too
    const oldCreated = new Date(Date.now() - 10 * 60_000).toISOString() // well past the 5-min stray grace
    await insertDelivery(DEL_STRAY, WH_ID, 'r-stray', 'pending', 0, oldCreated, null)
    await insertDelivery(DEL_FRESH, WH_ID, 'r-fresh', 'pending', 0, new Date().toISOString(), null)
    const scheduler = new WebhookRetryScheduler({
      service: new WebhookService(db, loopbackFetch),
    })
    await scheduler.tick()
    // Scoped: exactly ONE POST to this suite's sink — the stray. A second would mean the
    // fresh row's live first attempt was double-fired.
    expect(postsTo(SINK_URL)).toHaveLength(1)
    const stray = await q('SELECT status FROM multitable_webhook_deliveries WHERE id = $1', [DEL_STRAY])
    expect(stray.rows[0].status).toBe('success') // recovered and delivered (loopback 200)
    const fresh = await q('SELECT status, next_retry_at FROM multitable_webhook_deliveries WHERE id = $1', [DEL_FRESH])
    expect(fresh.rows[0].status).toBe('pending')
    expect(fresh.rows[0].next_retry_at).toBeNull() // untouched — no double-fire of a live first attempt
    scheduler.stop()
  })

  test('a second tick does no work ON THIS SUITE\'S ROWS once the due delivery is resolved', async () => {
    captured = []
    await seedForeignClaimableRow() // the tick WILL have work to do — just not ours
    const scheduler = new WebhookRetryScheduler({
      service: new WebhookService(db, loopbackFetch),
    })
    await scheduler.tick()
    // Scoped idle assertion: no POST to this suite's sink. (`retried` is not asserted to
    // be 0 — it counts the foreign row the process-wide claim legitimately swept up.)
    expect(postsTo(SINK_URL)).toHaveLength(0)
    // …and none of this suite's rows moved.
    const rows = await q(
      'SELECT id, status, next_retry_at FROM multitable_webhook_deliveries WHERE id = ANY($1) ORDER BY id',
      [[DEL_DUE, DEL_FUTURE, DEL_STRAY, DEL_FRESH]],
    )
    const byId = Object.fromEntries(rows.rows.map((r: { id: string }) => [r.id, r]))
    expect(byId[DEL_DUE].status).toBe('success')
    expect(byId[DEL_STRAY].status).toBe('success')
    expect(byId[DEL_FUTURE].status).toBe('pending')
    expect(byId[DEL_FRESH].status).toBe('pending')
    expect(byId[DEL_FRESH].next_retry_at).toBeNull() // still inside the grace → still untouched
    scheduler.stop()
  })

  test('stored retry policy drives the backoff: a custom base delay reschedules next_retry_at accordingly', async () => {
    // Seed a webhook with a large custom base delay + a due pending delivery that
    // will FAIL on retry (loopback 500). After the tick, the row is rescheduled
    // and its next_retry_at must reflect the stored base delay (computeBackoffMs
    // with attemptCount=2 → base * 2), not the 1s module default.
    const POLICY_WH = `whk_policy_${TS}`
    const POLICY_DEL = `del_policy_${TS}`
    const BASE_MS = 50_000 // attempt 1→failure already done, this retry is attempt 2 → 100s ahead
    const now = new Date().toISOString()
    await seedForeignClaimableRow() // unrelated claimable row present for this pass too
    await q(
      'INSERT INTO multitable_webhooks (id, name, url, secret, events, active, created_by, created_at, failure_count, max_retries, retry_base_delay_ms) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)',
      [POLICY_WH, 'Policy', POLICY_SINK_URL, null, JSON.stringify(['record.updated']), true, USER_ID, now, 0, 5, BASE_MS],
    )
    await insertDelivery(POLICY_DEL, POLICY_WH, 'rp', 'pending', 1, now, new Date(Date.now() - 60_000).toISOString())

    const policyCaptured: string[] = []
    const failFetch = (async (url: unknown) => {
      policyCaptured.push(String(url))
      return { ok: false, status: 500, text: async () => 'boom' } as Response
    }) as unknown as typeof fetch
    const svc = new WebhookService(db, failFetch)
    const before = Date.now()
    await svc.retryFailedDeliveries()
    // Scoped: exactly one attempt against the policy webhook's own sink.
    expect(policyCaptured.filter((u) => u === POLICY_SINK_URL)).toHaveLength(1)

    const row = await q('SELECT status, attempt_count, next_retry_at FROM multitable_webhook_deliveries WHERE id = $1', [POLICY_DEL])
    expect(row.rows[0].status).toBe('pending') // failed but still under max_retries → rescheduled
    expect(Number(row.rows[0].attempt_count)).toBe(2)
    // attempt_count is now 2 → computeBackoffMs(2, 50000) = 100000ms ahead.
    const nextRetry = new Date(row.rows[0].next_retry_at).getTime()
    const aheadMs = nextRetry - before
    expect(aheadMs).toBeGreaterThan(90_000) // well above the 2s the default policy would give
    expect(aheadMs).toBeLessThan(130_000)

    await q('DELETE FROM multitable_webhook_deliveries WHERE webhook_id = $1', [POLICY_WH]).catch(() => {})
    await q('DELETE FROM multitable_webhooks WHERE id = $1', [POLICY_WH]).catch(() => {})
  })

  test('MINOR-1: two concurrent retry passes claim the due row exactly once (no double-delivery)', async () => {
    // Re-arm the due row to pending+due, then run two retryFailedDeliveries() passes
    // concurrently (simulating two replicas ticking at once). FOR UPDATE SKIP LOCKED +
    // the next_retry_at lease must let exactly one pass claim+deliver it.
    captured = []
    await seedForeignClaimableRow() // both passes have unrelated work available too
    await q(
      "UPDATE multitable_webhook_deliveries SET status = 'pending', attempt_count = 0, next_retry_at = now() - interval '1 minute' WHERE id = $1",
      [DEL_DUE],
    )
    const svcA = new WebhookService(db, loopbackFetch)
    const svcB = new WebhookService(db, loopbackFetch)
    await Promise.all([svcA.retryFailedDeliveries(), svcB.retryFailedDeliveries()])
    // Scoped "exactly once" — the sum of the two passes' return values counts foreign rows
    // too, so the per-URL POST count is the assertion that means our row.
    expect(postsTo(SINK_URL)).toHaveLength(1) // delivered once
    const due = await q('SELECT status FROM multitable_webhook_deliveries WHERE id = $1', [DEL_DUE])
    expect(due.rows[0].status).toBe('success')
  })
})
