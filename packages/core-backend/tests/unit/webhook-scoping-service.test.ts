/**
 * WebhookService handling of the delivery-rule decision before an attempt (U3b, U4).
 *
 * The rules module is stubbed to a fixed decision; the service runs over a recording DB stub.
 *  - U3b: a refusal is not an endpoint failure — nothing is sent, the webhook's failure_count is never
 *    written, and the delivery row is marked failed.
 *  - U4: the body that is sent is the one the rules returned for this attempt (re-masked), not the stored
 *    body.
 */
import { describe, expect, test, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types'
import type { WebhookDelivery } from '../../src/multitable/webhooks'

const decision = vi.hoisted(() => ({ next: null as unknown }))

vi.mock('../../src/multitable/webhook-delivery-authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/webhook-delivery-authority')>()
  return { ...actual, authorizeWebhookDelivery: vi.fn(async () => decision.next) }
})

import { WebhookService } from '../../src/multitable/webhook-service'

type Op = { kind: string; table: string; data?: unknown }

function recordingDb(webhookRow: Record<string, unknown>) {
  const ops: Op[] = []
  const chain = (kind: string, table: string) => {
    const op: Op = { kind, table }
    ops.push(op)
    const self: Record<string, unknown> = {}
    for (const m of ['selectAll', 'select', 'where', 'orderBy', 'limit']) self[m] = vi.fn(() => self)
    self.set = vi.fn((data: unknown) => {
      op.data = data
      return self
    })
    self.values = vi.fn((data: unknown) => {
      op.data = data
      return self
    })
    self.execute = vi.fn(async () => [])
    self.executeTakeFirst = vi.fn(async () => (kind === 'select' ? webhookRow : undefined))
    return self
  }
  const db = {
    selectFrom: vi.fn((t: string) => chain('select', t)),
    insertInto: vi.fn((t: string) => chain('insert', t)),
    updateTable: vi.fn((t: string) => chain('update', t)),
    deleteFrom: vi.fn((t: string) => chain('delete', t)),
  }
  return { db: db as unknown as Kysely<Database>, ops }
}

const WEBHOOK_ROW = {
  id: 'wh1',
  name: 'w',
  url: 'https://hooks.example.test/in',
  secret: null,
  events: JSON.stringify(['record.updated']),
  active: true,
  created_by: 'owner1',
  created_at: '2026-10-01T00:00:00.000Z',
  failure_count: 2,
  max_retries: 3,
  sheet_id: 'sheet1',
}

function pending(): WebhookDelivery {
  return {
    id: 'del1',
    webhookId: 'wh1',
    event: 'record.updated',
    payload: { sheetId: 'sheet1', recordId: 'rec1', changes: { fld_a: 1, fld_b: 2 } },
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
  }
}

describe('executeDelivery and the rule decision', () => {
  test('U3b a refusal sends nothing, never writes failure_count, and marks the row failed', async () => {
    decision.next = { deliver: false, reason: 'sheet_not_readable' }
    const { db, ops } = recordingDb(WEBHOOK_ROW)
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }))
    const delivery = pending()
    await new WebhookService(db, fetchFn as unknown as typeof fetch).executeDelivery(delivery)
    expect(fetchFn.mock.calls.length, 'U3b.sends').toBe(0)
    const webhookWrites = ops.filter((op) => op.kind === 'update' && op.table === 'multitable_webhooks')
    expect(webhookWrites, 'U3b.failureCount').toEqual([])
    const rowWrites = ops.filter((op) => op.kind === 'update' && op.table === 'multitable_webhook_deliveries')
    expect(rowWrites.map((op) => op.data), 'U3b.status').toEqual([{ status: 'failed' }])
    expect(delivery.attemptCount, 'U3b.attempts').toBe(0)
  })

  test('U4 the attempt sends the re-masked body returned for this attempt, not the stored body', async () => {
    decision.next = { deliver: true, payload: { sheetId: 'sheet1', recordId: 'rec1', changes: { fld_b: 2 } } }
    const { db } = recordingDb(WEBHOOK_ROW)
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }))
    await new WebhookService(db, fetchFn as unknown as typeof fetch).executeDelivery(pending())
    expect(fetchFn.mock.calls.length, 'U4.sends').toBe(1)
    const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, { body: string }])[1].body))
    expect(Object.keys(body.changes), 'U4.noField').not.toContain('fld_a')
    expect(body.changes, 'U4.kept').toEqual({ fld_b: 2 })
  })
})
