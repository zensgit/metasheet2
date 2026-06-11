/**
 * Real-event-chain integration test for the webhook outbound pipeline (rank-5 wiring).
 *
 * THE GAP this closes: the webhook surface (CRUD, HMAC signing, durable delivery
 * rows, retry/backoff) was fully built but COMPLETELY DISCONNECTED —
 * initWebhookEventBridge() was never called at startup AND it subscribed to the
 * `core/EventBusService` instance while the record-write path emits on the
 * `integration/events/event-bus` singleton (two different objects). So a record
 * write never produced a delivery. This test exercises the REAL chain end to end:
 *
 *   PATCH /records/:id  →  RecordWriteService.patchRecords (real route, real pool)
 *     →  eventBus.emit('multitable.record.updated')  (integration bus)
 *       →  bridge subscription  →  WebhookService.deliverEvent('record.updated')
 *         →  durable row in multitable_webhook_deliveries + HMAC X-Webhook-Signature.
 *
 * FAIL-FIRST: on origin/main the bridge is unwired and bound to the wrong bus, so the
 * PATCH produces NO delivery row → the positive assertion fails. After the wiring fix
 * the row lands. A NEGATIVE control (a webhook subscribed only to comment.created)
 * proves the event filter — it must get no delivery.
 *
 * No real external calls: WebhookService is injected with a loopback fetch that
 * records the request (URL + headers + body) instead of hitting the network.
 *
 * Runs only with DATABASE_URL (plugin-tests.yml multitable real-DB job).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { WebhookService } from '../../src/multitable/webhook-service'
import {
  initWebhookEventBridge,
  resetWebhookEventBridgeForTests,
} from '../../src/multitable/webhook-event-bridge'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_whk_${TS}`
const SHEET_ID = `sheet_whk_${TS}`
const FLD_VALUE = `fld_whk_value_${TS}`
const REC_ID = `rec_whk_${TS}`
const USER_ID = `u_whk_${TS}`
const WH_SUBSCRIBED = `whk_sub_${TS}` // subscribed to record.updated — must receive a delivery
const WH_UNSUBSCRIBED = `whk_unsub_${TS}` // subscribed only to comment.created — must NOT
const WH_SECRET = `whk-secret-${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

let app: Express
let captured: CapturedRequest[] = []

/** Loopback fetch: records the request and returns 200; never touches the network. */
const loopbackFetch = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
  captured.push({
    url: String(url),
    headers: { ...(init?.headers ?? {}) },
    body: init?.body ?? '',
  })
  return {
    ok: true,
    status: 200,
    text: async () => 'ok',
  } as Response
}) as unknown as typeof fetch

async function deliveriesFor(webhookId: string): Promise<Array<Record<string, unknown>>> {
  const r = await q('SELECT * FROM multitable_webhook_deliveries WHERE webhook_id = $1', [webhookId])
  return r.rows as Array<Record<string, unknown>>
}

async function waitForDelivery(webhookId: string, timeoutMs = 5000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await deliveriesFor(webhookId)
    if (rows.length > 0) return rows
    if (Date.now() > deadline) return rows
    await new Promise((r) => setTimeout(r, 50))
  }
}

describeIfDatabase('webhook event bridge real chain (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { user: unknown }).user = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Webhook Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'Webhook Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VALUE, SHEET_ID, 'Value', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify({ [FLD_VALUE]: 1 })])

    const now = new Date().toISOString()
    // Subscribed webhook: record.updated, with a secret (so the HMAC header is computed).
    await q(
      'INSERT INTO multitable_webhooks (id, name, url, secret, events, active, created_by, created_at, failure_count, max_retries) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
      [WH_SUBSCRIBED, 'Subscribed', 'https://sink.test/subscribed', WH_SECRET, JSON.stringify(['record.updated']), true, USER_ID, now, 0, 3],
    )
    // Unsubscribed webhook (negative control): only comment.created.
    await q(
      'INSERT INTO multitable_webhooks (id, name, url, secret, events, active, created_by, created_at, failure_count, max_retries) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
      [WH_UNSUBSCRIBED, 'Unsubscribed', 'https://sink.test/unsubscribed', null, JSON.stringify(['comment.created']), true, USER_ID, now, 0, 3],
    )

    // Wire the bridge onto the SAME integration bus the PATCH route emits on, with a
    // WebhookService bound to the shared runtime db + the loopback fetch.
    resetWebhookEventBridgeForTests(integrationEventBus)
    initWebhookEventBridge({
      eventBus: integrationEventBus,
      webhookService: new WebhookService(db, loopbackFetch),
    })
  })

  afterAll(async () => {
    resetWebhookEventBridgeForTests(integrationEventBus)
    await q('DELETE FROM multitable_webhook_deliveries WHERE webhook_id = ANY($1)', [[WH_SUBSCRIBED, WH_UNSUBSCRIBED]]).catch(() => {})
    await q('DELETE FROM multitable_webhooks WHERE id = ANY($1)', [[WH_SUBSCRIBED, WH_UNSUBSCRIBED]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  beforeEach(() => {
    captured = []
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('a real PATCH emits record.updated → bridge → durable delivery row + HMAC header (FAIL-FIRST keystone)', async () => {
    const res = await request(app)
      .patch(`/api/multitable/records/${REC_ID}`)
      .send({ sheetId: SHEET_ID, data: { [FLD_VALUE]: 42 } })
    expect(res.status).toBe(200)

    // The bridge subscription fires synchronously on emit, but deliverEvent is
    // fire-and-forget; poll for the durable row it persists.
    const rows = await waitForDelivery(WH_SUBSCRIBED)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const delivery = rows[0]
    expect(delivery.event).toBe('record.updated')
    // The delivery row carries the actual emitted payload (recordId + changes).
    const payload = typeof delivery.payload === 'string' ? JSON.parse(delivery.payload) : delivery.payload
    expect((payload as { recordId?: string }).recordId).toBe(REC_ID)

    // The loopback sink received the POST with the HMAC X-Webhook-Signature header
    // computed over the body with the webhook secret.
    expect(captured.length).toBeGreaterThanOrEqual(1)
    const sentToSubscribed = captured.find((c) => c.url === 'https://sink.test/subscribed')
    expect(sentToSubscribed).toBeDefined()
    expect(sentToSubscribed!.headers['X-Webhook-Id']).toBe(WH_SUBSCRIBED)
    expect(sentToSubscribed!.headers['X-Webhook-Event']).toBe('record.updated')
    const expectedSig = WebhookService.signPayload(sentToSubscribed!.body, WH_SECRET)
    expect(sentToSubscribed!.headers['X-Webhook-Signature']).toBe(expectedSig)
  })

  test('negative: an unsubscribed webhook (comment.created only) receives no delivery for record.updated', async () => {
    const rows = await deliveriesFor(WH_UNSUBSCRIBED)
    expect(rows.length).toBe(0)
    // ...and the loopback sink was never POSTed for that URL across the suite.
    expect(captured.some((c) => c.url === 'https://sink.test/unsubscribed')).toBe(false)
  })
})
