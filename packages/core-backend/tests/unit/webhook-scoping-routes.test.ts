/**
 * Subscription webhook management routes (U8, U9, U10).
 *
 * U8 — creating a webhook binds it to a sheet: sheetId required; the caller needs automation management
 *      AND read on that sheet; the sheet must be live and not a hidden system sheet.
 * U9 — PATCH re-checks access only when a value changes (enable, different url, different event set, first
 *      binding); re-sending stored values does not; turning off and deleting are always allowed; the bound
 *      sheet cannot be changed.
 * U10 — the delivery history requires the owner's current access (decided by the rules module, stubbed
 *       here), an unbound webhook lists nothing, and items never carry the stored request/response bodies.
 *
 * The route module runs for real over an in-memory webhook store; the sheet capability resolver, sheet
 * liveness and the history access decision are fixtures.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const OWNER = 'owner_routes_1'
const SHEET = 'sheet_routes_1'
const OTHER_SHEET = 'sheet_routes_2'

type State = {
  caps: { canManageAutomation: boolean; canRead: boolean }
  liveness: 'live' | 'deleted' | 'absent'
  sheetRow: { system_kind: string | null; description: string | null }
  webhook: Record<string, unknown> | null
  deliveries: Array<Record<string, unknown>>
  inserted: Array<Record<string, unknown>>
  history: { ok: true } | { ok: false; reason: string }
}
const st = vi.hoisted(() => ({ s: null as unknown as State }))

vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: any, _res: any, next: () => void) => {
    req.user = { id: 'owner_routes_1', roles: [], perms: [] }
    next()
  }
  return { authenticate, authMiddleware: authenticate, default: authenticate }
})

vi.mock('../../src/multitable/sheet-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/sheet-capabilities')>()
  return {
    ...actual,
    resolveSheetCapabilitiesForUser: async () => ({ capabilities: { ...st.s.caps } }),
  }
})

vi.mock('../../src/multitable/sheet-liveness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/sheet-liveness')>()
  return {
    ...actual,
    loadSheetLiveness: async (_q: unknown, sheetId: string) => (sheetId ? st.s.liveness : 'absent'),
  }
})

vi.mock('../../src/db/pg', () => ({
  query: async (text: string) => (text.includes('FROM meta_sheets') ? { rows: [st.s.sheetRow] } : { rows: [] }),
}))

vi.mock('../../src/multitable/webhook-delivery-authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/webhook-delivery-authority')>()
  return { ...actual, authorizeWebhookOwnerCurrentAccess: async () => st.s.history }
})

vi.mock('../../src/db/db', () => {
  const chain = (kind: string, table: string) => {
    let setData: Record<string, unknown> | null = null
    const self: Record<string, unknown> = {}
    for (const m of ['selectAll', 'select', 'where', 'orderBy', 'limit']) self[m] = () => self
    self.values = (data: Record<string, unknown>) => {
      if (table === 'multitable_webhooks') st.s.inserted.push(data)
      return self
    }
    self.set = (data: Record<string, unknown>) => {
      setData = data
      return self
    }
    self.execute = async () => {
      if (kind === 'update' && table === 'multitable_webhooks' && st.s.webhook && setData) {
        st.s.webhook = { ...st.s.webhook, ...setData }
      }
      if (kind === 'delete' && table === 'multitable_webhooks') st.s.webhook = null
      if (kind === 'select' && table === 'multitable_webhook_deliveries') return st.s.deliveries
      return []
    }
    self.executeTakeFirst = async () => (table === 'multitable_webhooks' ? st.s.webhook ?? undefined : undefined)
    self.executeTakeFirstOrThrow = async () => {
      if (!st.s.webhook) throw new Error('no rows')
      return st.s.webhook
    }
    return self
  }
  return {
    db: {
      selectFrom: (t: string) => chain('select', t),
      insertInto: (t: string) => chain('insert', t),
      updateTable: (t: string) => chain('update', t),
      deleteFrom: (t: string) => chain('delete', t),
    },
  }
})

import { apiTokensRouter } from '../../src/routes/api-tokens'

const pinned = usePinnedServer()

function webhookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wh_routes_1',
    name: 'Hook',
    url: 'https://hooks.example.test/in',
    secret: null,
    events: JSON.stringify(['record.created', 'record.updated']),
    active: true,
    created_by: OWNER,
    created_at: '2026-10-01T00:00:00.000Z',
    failure_count: 0,
    max_retries: 3,
    sheet_id: SHEET,
    ...overrides,
  }
}

const allow = { canManageAutomation: true, canRead: true }
const deny = { canManageAutomation: false, canRead: false }

beforeAll(() => {
  const app = express()
  app.use(express.json())
  app.use(apiTokensRouter())
  pinned.setApp(app)
})

beforeEach(() => {
  st.s = {
    caps: { ...allow },
    liveness: 'live',
    sheetRow: { system_kind: null, description: null },
    webhook: webhookRow(),
    deliveries: [],
    inserted: [],
    history: { ok: true },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const create = (body: Record<string, unknown>) =>
  request(pinned.url())
    .post('/api/multitable/webhooks')
    .send({ name: 'New', url: 'https://hooks.example.test/new', events: ['record.created'], ...body })
const patch = (body: Record<string, unknown>) => request(pinned.url()).patch('/api/multitable/webhooks/wh_routes_1').send(body)

describe('U8 create binds to a sheet the caller can manage and read', () => {
  test('U8.missingSheet no sheetId → 400', async () => {
    const res = await create({})
    expect(res.status, 'U8.missingSheet.status').toBe(400)
    expect(st.s.inserted.length, 'U8.missingSheet.noRow').toBe(0)
  })
  test('U8.noManage read but no automation management → 403', async () => {
    st.s.caps = { canManageAutomation: false, canRead: true }
    const res = await create({ sheetId: SHEET })
    expect(res.status, 'U8.noManage.status').toBe(403)
  })
  test('U8.noRead automation management but no read → 403', async () => {
    st.s.caps = { canManageAutomation: true, canRead: false }
    const res = await create({ sheetId: SHEET })
    expect(res.status, 'U8.noRead.status').toBe(403)
  })
  test('U8.hidden a hidden system sheet → 403', async () => {
    st.s.sheetRow = { system_kind: 'people_directory', description: null }
    const res = await create({ sheetId: SHEET })
    expect(res.status, 'U8.hidden.status').toBe(403)
  })
  test('U8.notLive a deleted sheet → 404 (capability checked first)', async () => {
    st.s.liveness = 'deleted'
    const res = await create({ sheetId: SHEET })
    expect(res.status, 'U8.notLive.status').toBe(404)
  })
  test('U8+ all satisfied → 201 and the row is bound', async () => {
    const res = await create({ sheetId: SHEET })
    expect(res.status, 'U8+.status').toBe(201)
    expect(st.s.inserted[0]?.sheet_id, 'U8+.bound').toBe(SHEET)
    expect(res.body.data.sheetId, 'U8+.response').toBe(SHEET)
  })
})

describe('U9 PATCH re-checks only on a changed value', () => {
  test('U9.activate off → on re-checks (no access → 403)', async () => {
    st.s.webhook = webhookRow({ active: false })
    st.s.caps = { ...deny }
    expect((await patch({ active: true })).status, 'U9.activate.status').toBe(403)
  })
  test('U9.urlChange a different url re-checks (no access → 403)', async () => {
    st.s.caps = { ...deny }
    expect((await patch({ url: 'https://hooks.example.test/other' })).status, 'U9.urlChange.status').toBe(403)
  })
  test('U9.eventsChange a different event set re-checks (no access → 403)', async () => {
    st.s.caps = { ...deny }
    expect((await patch({ events: ['record.deleted'] })).status, 'U9.eventsChange.status').toBe(403)
  })
  test('U9.firstBind binding an unbound webhook re-checks (no access → 403)', async () => {
    st.s.webhook = webhookRow({ sheet_id: null })
    st.s.caps = { ...deny }
    expect((await patch({ sheetId: SHEET })).status, 'U9.firstBind.status').toBe(403)
  })
  test('U9.sameResend url and events re-sent unchanged with a new name: no re-check (200 without access)', async () => {
    st.s.caps = { ...deny }
    const res = await patch({ name: 'Renamed', url: 'https://hooks.example.test/in', events: ['record.updated', 'record.created'] })
    expect(res.status, 'U9.sameResend.status').toBe(200)
    expect(res.body.data.name, 'U9.sameResend.name').toBe('Renamed')
  })
  test('U9.sameSheetResend the same bound sheet re-sent: no-op (200 without access)', async () => {
    st.s.caps = { ...deny }
    const res = await patch({ sheetId: SHEET })
    expect(res.status, 'U9.sameSheetResend.status').toBe(200)
    expect(res.body.data.sheetId, 'U9.sameSheetResend.bound').toBe(SHEET)
  })
  test('U9.deactivateOnly turning off is always allowed (200 without access)', async () => {
    st.s.caps = { ...deny }
    const res = await patch({ active: false })
    expect(res.status, 'U9.deactivateOnly.status').toBe(200)
    expect(res.body.data.active, 'U9.deactivateOnly.active').toBe(false)
  })
  test('U9.delete deleting is always allowed (204 without access)', async () => {
    st.s.caps = { ...deny }
    const res = await request(pinned.url()).delete('/api/multitable/webhooks/wh_routes_1')
    expect(res.status, 'U9.delete.status').toBe(204)
  })
  test('U9.changeSheet a different sheet for a bound webhook → 400 (binding is fixed)', async () => {
    const res = await patch({ sheetId: OTHER_SHEET })
    expect(res.status, 'U9.changeSheet.status').toBe(400)
    expect(st.s.webhook?.sheet_id, 'U9.changeSheet.unchanged').toBe(SHEET)
  })
  test('U9.otherOwner another user cannot change or delete the webhook → 403', async () => {
    st.s.webhook = webhookRow({ created_by: 'someone_else' })
    expect((await patch({ name: 'x' })).status, 'U9.otherOwner.patch').toBe(403)
    expect((await request(pinned.url()).delete('/api/multitable/webhooks/wh_routes_1')).status, 'U9.otherOwner.delete').toBe(403)
    expect(st.s.webhook?.name, 'U9.otherOwner.unchanged').toBe('Hook')
  })

  test('U9.unboundActivate enabling an unbound webhook asks for a binding first → 400', async () => {
    st.s.webhook = webhookRow({ sheet_id: null, active: false })
    const res = await patch({ active: true })
    expect(res.status, 'U9.unboundActivate.status').toBe(400)
    expect(res.body.error.code, 'U9.unboundActivate.code').toBe('WEBHOOK_SHEET_REQUIRED')
  })
})

describe('U10 delivery history', () => {
  const stored = () => [
    {
      id: 'del_r1',
      webhook_id: 'wh_routes_1',
      event: 'record.updated',
      payload: { sheetId: SHEET, recordId: 'rec1', changes: { f: 1 } },
      status: 'success',
      http_status: 200,
      response_body: 'accepted',
      attempt_count: 1,
      created_at: '2026-10-02T00:00:00.000Z',
      delivered_at: '2026-10-02T00:00:01.000Z',
      next_retry_at: null,
    },
    {
      id: 'del_r2',
      webhook_id: 'wh_routes_1',
      event: 'record.updated',
      payload: { sheetId: SHEET, recordId: 'rec2', changes: { f: 2 } },
      status: 'pending',
      http_status: 502,
      response_body: 'unavailable',
      attempt_count: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      delivered_at: null,
      next_retry_at: '2026-10-01T00:05:00.000Z',
    },
  ]
  const get = () => request(pinned.url()).get('/api/multitable/webhooks/wh_routes_1/deliveries')

  for (const [tid, reason] of [
    ['U10a.denied', 'sheet_not_readable'],
    ['U10a.deleted', 'sheet_not_live'],
    ['U10a.inactive', 'owner_inactive'],
  ] as const) {
    test(`${tid} owner no longer passes (${reason}) → 403`, async () => {
      st.s.deliveries = stored()
      st.s.history = { ok: false, reason }
      const res = await get()
      expect(res.status, `${tid}.status`).toBe(403)
    })
  }

  test('U10.otherOwner another user cannot read the webhook history → 403', async () => {
    st.s.webhook = webhookRow({ created_by: 'someone_else' })
    st.s.deliveries = stored()
    const res = await get()
    expect(res.status, 'U10.otherOwner.status').toBe(403)
  })

  test('U10a.null an unbound webhook lists nothing', async () => {
    st.s.webhook = webhookRow({ sheet_id: null })
    st.s.deliveries = stored()
    const res = await get()
    expect(res.status, 'U10a.null.status').toBe(200)
    expect((res.body.data.deliveries as unknown[]).length, 'U10a.null.count').toBe(0)
  })

  test('U10b allowed: every stored row listed without the stored request/response bodies', async () => {
    st.s.deliveries = stored()
    const res = await get()
    expect(res.status, 'U10b.status').toBe(200)
    const items = res.body.data.deliveries as Array<Record<string, unknown>>
    expect(items.length, 'U10b.count').toBe(2)
    for (const item of items) {
      expect(Object.keys(item), 'U10b.no_payload').not.toContain('payload')
      expect(Object.keys(item), 'U10b.no_responseBody').not.toContain('responseBody')
      expect(Object.keys(item), 'U10b.no_response_body').not.toContain('response_body')
      expect(item, 'U10b.status_fields').toHaveProperty('attemptCount')
    }
  })
})
