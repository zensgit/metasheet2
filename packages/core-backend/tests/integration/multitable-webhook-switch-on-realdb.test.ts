/**
 * Subscription webhook ops switch ON (real DB): M21 and F1.
 *
 * The switch is read once when the webhook service module loads, so it is set here before any import.
 * While it is on: an event writes no delivery row and sends nothing; a direct attempt sends nothing and
 * leaves the row as it is; the retry tick returns before claiming, so a due row keeps its status,
 * attempt count and next_retry_at byte-for-byte. The same fixtures with the switch off deliver (M21+ in
 * the scoping suite, F0 in the floor suite). Runs only with DATABASE_URL.
 */
import { afterAll, describe, expect, test, vi } from 'vitest'

const original = vi.hoisted(() => {
  const value = process.env.MULTITABLE_OUTBOUND_WEBHOOKS_DISABLED
  process.env.MULTITABLE_OUTBOUND_WEBHOOKS_DISABLED = '1'
  return { value }
})

import { db } from '../../src/db/db'
import { WebhookService } from '../../src/multitable/webhook-service'
import {
  ENTRY_PATHS,
  TICK_SHAPES,
  cleanupFixtureRows,
  createBase,
  createField,
  createOwner,
  createRecord,
  createSheet,
  createSink,
  deliveryRow,
  deliveryRows,
  eventIdFor,
  id,
  insertDuePending,
  insertWebhook,
  pendingEventIdFor,
  q,
  settle,
} from './multitable-webhook-scoping-fixtures'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// A DB-expected run (EXPECT_DB=1) must never skip-green.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? test : test.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})
let seq = 0

async function switchCase(label: string) {
  const n = `${label}_${seq++}`
  const ownerId = id(`owner_${n}`)
  const baseId = id(`base_${n}`)
  const sheetId = id(`sheet_${n}`)
  const fieldId = id(`fld_${n}`)
  const recordId = id(`rec_${n}`)
  const webhookId = id(`wh_${n}`)
  const url = `https://sink.test/switch/${n}/${Date.now()}`
  await createOwner(ownerId)
  await createBase(baseId)
  await createSheet(sheetId, baseId)
  await createField(fieldId, sheetId, 'string')
  await createRecord(recordId, sheetId, { [fieldId]: 'a' })
  await insertWebhook(webhookId, ownerId, sheetId, url)
  return { n, sheetId, fieldId, recordId, webhookId, url }
}

describeIfDatabase('subscription webhook ops switch on (real DB)', () => {
  afterAll(async () => {
    if (original.value === undefined) delete process.env.MULTITABLE_OUTBOUND_WEBHOOKS_DISABLED
    else process.env.MULTITABLE_OUTBOUND_WEBHOOKS_DISABLED = original.value
    await cleanupFixtureRows()
  })

  for (const path of ENTRY_PATHS) {
    test(`M21.entry [${path}] an event with values writes no row and sends nothing`, async () => {
      const c = await switchCase('m21e')
      const sink = createSink()
      const result = await new WebhookService(db, sink.fetchFn).deliverEvent(
        'record.updated',
        { sheetId: c.sheetId, recordId: c.recordId, changes: { [c.fieldId]: 'b' } },
        eventIdFor(path, c.n),
      )
      expect((await deliveryRows(c.webhookId)).length, 'M21.entry.rows').toBe(0)
      await settle()
      expect(sink.to(c.url).length, 'M21.entry.sends').toBe(0)
      expect(result, 'M21.entry.result').toEqual([])
    })

    test(`F1.entry [${path}] an id-only event writes no row and sends nothing`, async () => {
      const c = await switchCase('f1e')
      const sink = createSink()
      await new WebhookService(db, sink.fetchFn).deliverEvent(
        'record.updated',
        { sheetId: c.sheetId, recordId: c.recordId },
        eventIdFor(path, c.n),
      )
      expect((await deliveryRows(c.webhookId)).length, 'F1.entry.rows').toBe(0)
      await settle()
      expect(sink.to(c.url).length, 'F1.entry.sends').toBe(0)
    })
  }

  for (const shape of TICK_SHAPES) {
    for (const tid of ['M21.tick', 'F1.tick'] as const) {
      test(`${tid} [${shape}] the tick does not claim a due row: status, attempts and next_retry_at unchanged`, async () => {
        const c = await switchCase(tid === 'M21.tick' ? 'm21t' : 'f1t')
        const deliveryId = id(`del_${c.n}`)
        await insertDuePending(deliveryId, c.webhookId, 'record.updated', { sheetId: c.sheetId, recordId: c.recordId }, pendingEventIdFor(shape, c.n))
        const before = (await q('SELECT status, attempt_count, next_retry_at::text AS nra FROM multitable_webhook_deliveries WHERE id = $1', [deliveryId])).rows[0]
        const sink = createSink()
        const claimed = await new WebhookService(db, sink.fetchFn).retryFailedDeliveries()
        await settle(100)
        const after = (await q('SELECT status, attempt_count, next_retry_at::text AS nra FROM multitable_webhook_deliveries WHERE id = $1', [deliveryId])).rows[0]
        expect(after.nra, `${tid}.nextRetryUnchanged`).toBe(before.nra)
        expect(sink.to(c.url).length, `${tid}.sends`).toBe(0)
        expect(after.status, `${tid}.status`).toBe(before.status)
        expect(after.attempt_count, `${tid}.attempts`).toBe(before.attempt_count)
        expect(claimed, `${tid}.claimed`).toBe(0)
      })
    }
  }

  test('F1.execute a direct attempt sends nothing and leaves status and attempt count unchanged', async () => {
    const c = await switchCase('f1x')
    const deliveryId = id(`del_${c.n}`)
    await insertDuePending(deliveryId, c.webhookId, 'record.updated', { sheetId: c.sheetId, recordId: c.recordId }, null)
    const sink = createSink()
    const delivery = {
      id: deliveryId,
      webhookId: c.webhookId,
      event: 'record.updated' as const,
      payload: { sheetId: c.sheetId, recordId: c.recordId },
      status: 'pending' as const,
      attemptCount: 0,
      createdAt: new Date().toISOString(),
    }
    await new WebhookService(db, sink.fetchFn).executeDelivery(delivery)
    await settle(100)
    expect(sink.to(c.url).length, 'F1.execute.sends').toBe(0)
    const row = await deliveryRow(deliveryId)
    expect(row?.status, 'F1.execute.status').toBe('pending')
    expect(Number(row?.attempt_count), 'F1.execute.attempts').toBe(0)
    expect(delivery.attemptCount, 'F1.execute.objectAttempts').toBe(0)
  })
})
