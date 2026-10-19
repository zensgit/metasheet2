/**
 * GET /api/multitable/webhooks/:id/deliveries returns status fields only.
 *
 * Route-level: the real WebhookService runs over an in-memory DB stub (one webhook owned by the
 * caller and bound to a sheet, its own delivery rows), so each stored row passes through the service
 * mapping and the route's list mapping exactly as in production. The owner's current access to the bound
 * sheet is stood in as granted (it reads the database in its own transaction, covered by the real-DB
 * suites).
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const OWNER_ID = 'user_list_1'
const WEBHOOK_ID = 'wh_list_1'
const SHEET_ID = 'sheet_list_1'

const LIST_FIELDS = [
  'id',
  'webhookId',
  'event',
  'status',
  'httpStatus',
  'attemptCount',
  'createdAt',
  'deliveredAt',
  'nextRetryAt',
]

const pinned = usePinnedServer()

function webhookRow() {
  return {
    id: WEBHOOK_ID,
    name: 'List fixture',
    url: 'https://hooks.example.test/in',
    secret: null,
    events: JSON.stringify(['record.created']),
    active: true,
    created_by: OWNER_ID,
    created_at: '2026-10-01T00:00:00.000Z',
    failure_count: 0,
    max_retries: 3,
    sheet_id: SHEET_ID,
  }
}

function deliveryRows() {
  return [
    {
      id: 'del_list_1',
      webhook_id: WEBHOOK_ID,
      event: 'record.created',
      payload: { sheetId: SHEET_ID, recordId: 'rec_list_1', data: { fld_title: 'One' } },
      status: 'success',
      http_status: 200,
      response_body: 'accepted',
      attempt_count: 1,
      created_at: '2026-10-02T00:00:00.000Z',
      delivered_at: '2026-10-02T00:00:01.000Z',
      next_retry_at: null,
    },
    {
      id: 'del_list_2',
      webhook_id: WEBHOOK_ID,
      event: 'record.created',
      payload: { sheetId: SHEET_ID, recordId: 'rec_list_2', data: { fld_title: 'Two' } },
      status: 'pending',
      http_status: 502,
      response_body: 'upstream unavailable',
      attempt_count: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      delivered_at: null,
      next_retry_at: '2026-10-01T00:05:00.000Z',
    },
  ]
}

function createDbStub(rows: unknown[]) {
  const executeQueue: unknown[] = [rows]
  const takeFirstQueue: unknown[] = [webhookRow()]
  const chain = () => {
    const self: Record<string, unknown> = {}
    for (const m of ['selectAll', 'select', 'where', 'orderBy', 'limit', 'set', 'values']) {
      self[m] = vi.fn(() => self)
    }
    self.execute = vi.fn(async () => executeQueue.shift() ?? [])
    self.executeTakeFirst = vi.fn(async () => takeFirstQueue.shift())
    return self
  }
  return {
    selectFrom: vi.fn(() => chain()),
    insertInto: vi.fn(() => chain()),
    updateTable: vi.fn(() => chain()),
    deleteFrom: vi.fn(() => chain()),
  }
}

async function buildApp(rows: unknown[]) {
  vi.resetModules()
  const authenticate = (req: any, _res: any, next: () => void) => {
    req.user = { id: OWNER_ID, roles: [], perms: [] }
    next()
  }
  vi.doMock('../../src/middleware/auth', () => ({ authenticate, authMiddleware: authenticate, default: authenticate }))
  vi.doMock('../../src/db/db', () => ({ db: createDbStub(rows) }))
  vi.doMock('../../src/db/pg', () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }))
  vi.doMock('../../src/multitable/webhook-delivery-authority', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/multitable/webhook-delivery-authority')>()
    return { ...actual, authorizeWebhookOwnerCurrentAccess: async () => ({ ok: true as const }) }
  })
  const { apiTokensRouter } = await import('../../src/routes/api-tokens')
  const app = express()
  app.use(express.json())
  app.use(apiTokensRouter())
  pinned.setApp(app)
}

// Warm the transform cache once, so the fresh import in buildApp stays fast.
beforeAll(async () => {
  await buildApp([])
}, 180_000)

afterEach(() => {
  vi.doUnmock('../../src/middleware/auth')
  vi.doUnmock('../../src/db/db')
  vi.doUnmock('../../src/db/pg')
  vi.doUnmock('../../src/multitable/webhook-delivery-authority')
  vi.resetModules()
})

describe('GET /api/multitable/webhooks/:id/deliveries', () => {
  it('delivery list returns status fields only', async () => {
    const rows = deliveryRows()
    // Precondition: every stored row has a non-null request body and response body.
    for (const row of rows) {
      expect(row.payload).not.toBeNull()
      expect(row.response_body).not.toBeNull()
    }
    await buildApp(rows)

    const res = await request(pinned.url()).get(`/api/multitable/webhooks/${WEBHOOK_ID}/deliveries`)
    expect(res.status).toBe(200)
    const deliveries = res.body?.data?.deliveries as Array<Record<string, unknown>>
    expect(Array.isArray(deliveries)).toBe(true)
    expect(deliveries).toHaveLength(rows.length)

    for (const item of deliveries) {
      expect(item).toHaveProperty('status')
      expect(item).toHaveProperty('attemptCount')
      expect(item).toHaveProperty('createdAt')
      expect(Object.keys(item)).not.toContain('payload')
      expect(Object.keys(item)).not.toContain('responseBody')
      expect(Object.keys(item)).not.toContain('response_body')
      for (const key of Object.keys(item)) expect(LIST_FIELDS).toContain(key)
    }

    const byId = Object.fromEntries(deliveries.map((d) => [d.id, d]))
    expect(byId.del_list_1).toEqual({
      id: 'del_list_1',
      webhookId: WEBHOOK_ID,
      event: 'record.created',
      status: 'success',
      httpStatus: 200,
      attemptCount: 1,
      createdAt: '2026-10-02T00:00:00.000Z',
      deliveredAt: '2026-10-02T00:00:01.000Z',
    })
    expect(byId.del_list_2).toEqual({
      id: 'del_list_2',
      webhookId: WEBHOOK_ID,
      event: 'record.created',
      status: 'pending',
      httpStatus: 502,
      attemptCount: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      nextRetryAt: '2026-10-01T00:05:00.000Z',
    })
  })
})
