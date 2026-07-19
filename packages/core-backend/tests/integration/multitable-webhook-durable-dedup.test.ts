/**
 * P2 durable-delivery closure item 3 (owner 2026-07-17) — idempotent DURABLE webhook delivery per
 * (webhook_id, event_id).
 *
 * Before this: the durable `webhook-event-bridge` consumer called `WebhookService.deliverEvent` with no event
 * identity, so an at-least-once redelivery (crash between the fire-and-forget send and the consumer-row
 * done-CAS, or a `busy` retry) created a SECOND delivery row and re-sent the webhook. Now `deliverEvent`
 * accepts the outbox `eventId` and the per-webhook row is an idempotent CLAIM on the partial-unique
 * `(webhook_id, event_id)` index.
 *
 * Drives the REAL `WebhookService.deliverEvent` against Postgres with a loopback fetch (send count = spy).
 * Each test uses a DISTINCT event type so its webhook set is isolated (no cross-test send bleed). Runs only
 * with DATABASE_URL (plugin-tests.yml multitable real-DB job). Asserts its own webhook ids only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { WebhookService } from '../../src/multitable/webhook-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER_ID = `u_whk_dd_${TS}`
const WH_UPD = `whk_dd_upd_${TS}` // record.updated  — G1, G4 (single subscriber → isolated send count)
const WH_CRE1 = `whk_dd_cre1_${TS}` // record.created — G2 (two subscribers → per-webhook dedup)
const WH_CRE2 = `whk_dd_cre2_${TS}` // record.created — G2
const WH_DEL = `whk_dd_del_${TS}` // record.deleted  — G3 (legacy)

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let sends: string[] = []
const loopbackFetch = (async (url: unknown) => {
  sends.push(String(url))
  return { ok: true, status: 200, text: async () => 'ok' } as Response
}) as unknown as typeof fetch

const svc = () => new WebhookService(db, loopbackFetch)

/** deliverEvent fires the HTTP attempt fire-and-forget; wait until the loopback has recorded `atLeast` sends,
 * then settle a little longer so a spurious extra send would land and be caught. Returns the observed count. */
async function settleSends(atLeast: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (sends.length < atLeast && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  await new Promise((r) => setTimeout(r, 150))
  return sends.length
}

const rowsFor = async (webhookId: string): Promise<Array<{ id: string; event_id: string | null }>> =>
  (
    await q('SELECT id, event_id FROM multitable_webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at', [webhookId])
  ).rows as Array<{ id: string; event_id: string | null }>

async function seedWebhook(id: string, event: string): Promise<void> {
  await q(
    'INSERT INTO multitable_webhooks (id, name, url, secret, events, active, created_by, created_at, failure_count, max_retries) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
    [id, `DD ${id}`, `https://sink.test/${id}`, null, JSON.stringify([event]), true, USER_ID, new Date().toISOString(), 0, 3],
  )
}

describeIfDatabase('durable webhook delivery — idempotent per (webhook, event_id)', () => {
  beforeAll(async () => {
    await seedWebhook(WH_UPD, 'record.updated')
    await seedWebhook(WH_CRE1, 'record.created')
    await seedWebhook(WH_CRE2, 'record.created')
    await seedWebhook(WH_DEL, 'record.deleted')
  })

  afterAll(async () => {
    const ids = [WH_UPD, WH_CRE1, WH_CRE2, WH_DEL]
    await q('DELETE FROM multitable_webhook_deliveries WHERE webhook_id = ANY($1)', [ids]).catch(() => {})
    await q('DELETE FROM multitable_webhooks WHERE id = ANY($1)', [ids]).catch(() => {})
  })

  test('G1 durable redelivery with the SAME eventId → still 1 row + 1 send (claim dedups)', async () => {
    sends = []
    const E = `evt_dd_g1_${TS}`
    await svc().deliverEvent('record.updated', { recordId: 'r1' }, E)
    expect(await settleSends(1)).toBe(1)
    // the redelivery (crash/busy retry re-enters here with the same identity)
    await svc().deliverEvent('record.updated', { recordId: 'r1' }, E)
    expect(await settleSends(1)).toBe(1) // NO second send
    expect((await rowsFor(WH_UPD)).filter((r) => r.event_id === E)).toHaveLength(1)
  })

  test('G2 dedup is PER-WEBHOOK: two webhooks on the same event → each gets its own row + send; redeliver dedups both', async () => {
    sends = []
    const E = `evt_dd_g2_${TS}`
    await svc().deliverEvent('record.created', { recordId: 'r2' }, E)
    expect(await settleSends(2)).toBe(2)
    expect((await rowsFor(WH_CRE1)).filter((r) => r.event_id === E)).toHaveLength(1)
    expect((await rowsFor(WH_CRE2)).filter((r) => r.event_id === E)).toHaveLength(1)
    await svc().deliverEvent('record.created', { recordId: 'r2' }, E)
    expect(await settleSends(2)).toBe(2) // neither re-sends
  })

  test('G3 LEGACY path (no eventId) → NULL event_id rows; repeated calls create rows exactly as today', async () => {
    sends = []
    await svc().deliverEvent('record.deleted', { recordId: 'r3' }) // no eventId
    await svc().deliverEvent('record.deleted', { recordId: 'r3' }) // again — legacy has no dedup
    expect(await settleSends(2)).toBeGreaterThanOrEqual(2)
    const nullRows = (await rowsFor(WH_DEL)).filter((r) => r.event_id === null)
    expect(nullRows.length).toBeGreaterThanOrEqual(2) // two legacy rows coexist (partial index does not constrain NULL)
  })

  test('G4 CONCURRENCY: two genuinely concurrent durable delivers, same (webhook, event) → exactly 1 row + 1 send', async () => {
    sends = []
    const E = `evt_dd_g4_${TS}`
    await Promise.all([
      svc().deliverEvent('record.updated', { recordId: 'r4' }, E),
      svc().deliverEvent('record.updated', { recordId: 'r4' }, E),
    ])
    expect(await settleSends(1)).toBe(1)
    expect((await rowsFor(WH_UPD)).filter((r) => r.event_id === E)).toHaveLength(1)
  })
})
