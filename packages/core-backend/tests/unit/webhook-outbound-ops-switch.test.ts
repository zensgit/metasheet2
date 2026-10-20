/**
 * Ops switch for outbound subscription webhooks (MULTITABLE_OUTBOUND_WEBHOOKS_DISABLED).
 *
 * The switch is parsed once when webhook-service is first loaded, so every case resets the module
 * registry, sets the env value, and imports the service fresh. The DB is an in-memory recording
 * stub (no shared database): each case holds exactly one webhook and one fixture payload, and the
 * fetch stub only ever sees this file's own requests.
 *
 * The fixture webhook is bound to the fixture sheet, and the delivery rules are stood in as "the owner can
 * read everything on that sheet" (body unchanged): the rules open their own read transaction, which the
 * recording stub cannot host. The rules are covered by their own unit and real-DB suites.
 */
import { createHmac } from 'crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types'
import type { WebhookDelivery } from '../../src/multitable/webhooks'

const SWITCH_ENV = 'MULTITABLE_OUTBOUND_WEBHOOKS_DISABLED'
const SIGNAL_PREFIX = 'outbound webhook ops switch: '

// ─── Fixture: one webhook, one payload ──────────────────────────────────────────────────

const WEBHOOK_ID = 'wh_ops_1'
const WEBHOOK_SECRET = 'whsec_ops_fixture'
const OWNER_ID = 'user_ops_1'
const SHEET_ID = 'sheet_ops_1'
const STORED_PAYLOAD = {
  sheetId: SHEET_ID,
  recordId: 'rec_ops_1',
  data: { fld_title: 'Hello' },
}

function webhookRow() {
  return {
    id: WEBHOOK_ID,
    name: 'Ops fixture',
    url: 'https://hooks.example.test/in',
    secret: WEBHOOK_SECRET,
    events: JSON.stringify(['record.created']),
    active: true,
    created_by: OWNER_ID,
    created_at: '2026-10-01T00:00:00.000Z',
    failure_count: 0,
    max_retries: 3,
    sheet_id: SHEET_ID,
  }
}

/** Due pending row: next_retry_at in the past, attempt_count below max_retries, never delivered. */
function pendingDeliveryRow() {
  return {
    id: 'del_ops_1',
    webhook_id: WEBHOOK_ID,
    event: 'record.created',
    payload: STORED_PAYLOAD,
    status: 'pending',
    http_status: null,
    response_body: null,
    attempt_count: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    delivered_at: null,
    next_retry_at: new Date(Date.now() - 60_000).toISOString(),
  }
}

function pendingDelivery(): WebhookDelivery {
  return {
    id: 'del_ops_2',
    webhookId: WEBHOOK_ID,
    event: 'record.created',
    payload: STORED_PAYLOAD,
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
  }
}

// ─── Recording DB stub ──────────────────────────────────────────────────────────────────

interface DbOp {
  kind: 'select' | 'insert' | 'update' | 'delete'
  table: string
  inTransaction: boolean
  data?: unknown
}

function createRecordingDb() {
  const state = {
    executeQueue: [] as unknown[],
    takeFirstQueue: [] as unknown[],
    ops: [] as DbOp[],
    transactionCalls: 0,
  }

  function chain(kind: DbOp['kind'], table: string, inTransaction: boolean) {
    const op: DbOp = { kind, table, inTransaction }
    state.ops.push(op)
    const self: Record<string, unknown> = {}
    for (const m of ['selectAll', 'select', 'where', 'orderBy', 'limit', 'forUpdate', 'skipLocked', 'returningAll']) {
      self[m] = vi.fn(() => self)
    }
    self.set = vi.fn((data: unknown) => {
      op.data = data
      return self
    })
    self.values = vi.fn((data: unknown) => {
      op.data = data
      return self
    })
    self.execute = vi.fn(async () => state.executeQueue.shift() ?? [])
    self.executeTakeFirst = vi.fn(async () => state.takeFirstQueue.shift())
    self.executeTakeFirstOrThrow = vi.fn(async () => {
      const v = state.takeFirstQueue.shift()
      if (!v) throw new Error('no rows')
      return v
    })
    return self
  }

  function root(inTransaction: boolean) {
    return {
      selectFrom: vi.fn((t: string) => chain('select', t, inTransaction)),
      insertInto: vi.fn((t: string) => chain('insert', t, inTransaction)),
      updateTable: vi.fn((t: string) => chain('update', t, inTransaction)),
      deleteFrom: vi.fn((t: string) => chain('delete', t, inTransaction)),
    }
  }

  const db = {
    ...root(false),
    transaction: vi.fn(() => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => {
        state.transactionCalls += 1
        return fn(root(true))
      },
    })),
  }
  return { db: db as unknown as Kysely<Database>, rawDb: db, state }
}

// ─── Per-site priming (identical for switch on and off) ─────────────────────────────────

type Site = 'deliverEvent' | 'executeDelivery' | 'retryTick'

function prime(state: ReturnType<typeof createRecordingDb>['state'], site: Site) {
  if (site === 'deliverEvent') {
    state.executeQueue.push([webhookRow()]) // active-webhook select
    state.takeFirstQueue.push(webhookRow()) // executeDelivery → getWebhookById
  } else if (site === 'executeDelivery') {
    state.takeFirstQueue.push(webhookRow()) // getWebhookById
  } else {
    state.executeQueue.push([pendingDeliveryRow()]) // claim select (in transaction)
    state.executeQueue.push([]) // lease update (in transaction)
    state.takeFirstQueue.push(webhookRow()) // tick → getWebhookById
    state.takeFirstQueue.push(webhookRow()) // executeDelivery → getWebhookById
  }
}

function okFetch() {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: true,
    status: 200,
    text: async () => 'ok',
  }))
}

const flush = () => new Promise((r) => setTimeout(r, 20))

// ─── Module loading with a given raw env value ──────────────────────────────────────────

const originalEnv = process.env[SWITCH_ENV]

function setRawSwitch(raw: string | undefined) {
  if (raw === undefined) delete process.env[SWITCH_ENV]
  else process.env[SWITCH_ENV] = raw
}

async function loadService(raw: string | undefined) {
  vi.resetModules()
  vi.doMock('../../src/multitable/webhook-delivery-authority', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/multitable/webhook-delivery-authority')>()
    return {
      ...actual,
      authorizeWebhookDelivery: async (_db: unknown, _webhook: unknown, _event: unknown, payload: unknown) => ({
        deliver: true as const,
        payload: { ...(payload as Record<string, unknown>) },
      }),
    }
  })
  setRawSwitch(raw)
  // Same Logger module instance webhook-service binds to (registry reset above, not since).
  const { Logger } = await import('../../src/core/logger')
  const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  const mod = await import('../../src/multitable/webhook-service')
  const signals = () =>
    info.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith(SIGNAL_PREFIX))
  return { WebhookService: mod.WebhookService, signals }
}

function signalState(line: string): 'on' | 'off' {
  const rest = line.slice(SIGNAL_PREFIX.length)
  if (rest.startsWith('on')) return 'on'
  if (rest.startsWith('off')) return 'off'
  throw new Error(`unrecognised signal: ${line}`)
}

async function runSite(
  WebhookService: Awaited<ReturnType<typeof loadService>>['WebhookService'],
  site: Site,
) {
  const { db, state } = createRecordingDb()
  prime(state, site)
  const queuedBefore = { execute: state.executeQueue.length, takeFirst: state.takeFirstQueue.length }
  const fetchFn = okFetch()
  const svc = new WebhookService(db, fetchFn as unknown as typeof fetch)
  const delivery = pendingDelivery()
  const deliveryBefore = { ...delivery }
  let result: unknown
  if (site === 'deliverEvent') {
    result = await svc.deliverEvent('record.created', STORED_PAYLOAD)
  } else if (site === 'executeDelivery') {
    result = await svc.executeDelivery(delivery)
  } else {
    result = await svc.retryFailedDeliveries()
  }
  await flush()
  return { state, fetchFn, result, delivery, deliveryBefore, queuedBefore }
}

// Warm the transform cache once, so the per-case fresh imports below stay fast.
beforeAll(async () => {
  await import('../../src/core/logger')
  await import('../../src/multitable/webhook-service')
}, 180_000)

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  setRawSwitch(originalEnv)
  vi.restoreAllMocks()
  vi.doUnmock('../../src/multitable/webhook-delivery-authority')
  vi.resetModules()
})

// ─── Switch on: nothing written, nothing sent, row state untouched ──────────────────────

describe('outbound ops switch on', () => {
  it('deliverEvent returns no deliveries, reads no webhooks, writes no rows and sends nothing', async () => {
    const { WebhookService } = await loadService('1')
    const run = await runSite(WebhookService, 'deliverEvent')
    expect(run.result).toEqual([])
    expect(run.state.ops).toEqual([])
    expect(run.state.transactionCalls).toBe(0)
    expect(run.fetchFn).not.toHaveBeenCalled()
    expect(run.state.executeQueue.length).toBe(run.queuedBefore.execute)
    expect(run.state.takeFirstQueue.length).toBe(run.queuedBefore.takeFirst)
  })

  it('deliverEvent with an event id also returns before any read or write', async () => {
    const { WebhookService } = await loadService('1')
    const { db, state } = createRecordingDb()
    prime(state, 'deliverEvent')
    const fetchFn = okFetch()
    const svc = new WebhookService(db, fetchFn as unknown as typeof fetch)
    const result = await svc.deliverEvent('record.created', STORED_PAYLOAD, 'evt_ops_1')
    await flush()
    expect(result).toEqual([])
    expect(state.ops).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('retry tick returns 0 before the claim: no transaction, no select, no lease, row unchanged', async () => {
    const { WebhookService } = await loadService('1')
    const run = await runSite(WebhookService, 'retryTick')
    expect(run.result).toBe(0)
    expect(run.state.transactionCalls).toBe(0)
    expect(run.state.ops).toEqual([])
    expect(run.fetchFn).not.toHaveBeenCalled()
    // The due row's status / next_retry_at / attempt_count were never read or written.
    expect(run.state.executeQueue.length).toBe(run.queuedBefore.execute)
    expect(run.state.ops.filter((op) => op.kind === 'update')).toEqual([])
  })

  it('executeDelivery sends nothing and leaves status and attempt count unchanged', async () => {
    const { WebhookService } = await loadService('1')
    const run = await runSite(WebhookService, 'executeDelivery')
    expect(run.fetchFn).not.toHaveBeenCalled()
    expect(run.state.ops).toEqual([])
    expect(run.delivery.status).toBe(run.deliveryBefore.status)
    expect(run.delivery.attemptCount).toBe(run.deliveryBefore.attemptCount)
    expect(run.delivery).toEqual(run.deliveryBefore)
  })
})

// ─── Switch off (same fixtures): each site writes / sends exactly once ──────────────────

describe('outbound ops switch off', () => {
  it('deliverEvent writes exactly one delivery row and sends once', async () => {
    const { WebhookService } = await loadService(undefined)
    const run = await runSite(WebhookService, 'deliverEvent')
    const inserts = run.state.ops.filter(
      (op) => op.kind === 'insert' && op.table === 'multitable_webhook_deliveries',
    )
    expect(inserts).toHaveLength(1)
    expect(run.result).toHaveLength(1)
    expect(run.fetchFn).toHaveBeenCalledTimes(1)
    expect(run.fetchFn.mock.calls[0][0]).toBe(webhookRow().url)
  })

  it('executeDelivery for an existing webhook sends once and records the outcome', async () => {
    const { WebhookService } = await loadService(undefined)
    const run = await runSite(WebhookService, 'executeDelivery')
    expect(run.fetchFn).toHaveBeenCalledTimes(1)
    expect(run.delivery.status).toBe('success')
    expect(run.delivery.attemptCount).toBe(1)
    const deliveryUpdates = run.state.ops.filter(
      (op) => op.kind === 'update' && op.table === 'multitable_webhook_deliveries',
    )
    expect(deliveryUpdates).toHaveLength(1)
  })

  it('retry tick claims the due row once and resends it with the stored payload and signature', async () => {
    const { WebhookService } = await loadService(undefined)
    const run = await runSite(WebhookService, 'retryTick')
    expect(run.result).toBe(1)
    expect(run.state.transactionCalls).toBe(1)
    const lease = run.state.ops.filter((op) => op.kind === 'update' && op.inTransaction)
    expect(lease).toHaveLength(1)
    expect(run.fetchFn).toHaveBeenCalledTimes(1)

    const [url, init] = run.fetchFn.mock.calls[0]
    const expectedBody = JSON.stringify(STORED_PAYLOAD)
    const expectedSignature = createHmac('sha256', WEBHOOK_SECRET).update(expectedBody).digest('hex')
    const headers = init.headers as Record<string, string>
    expect(url).toBe(webhookRow().url)
    expect(init.body).toBe(expectedBody)
    expect(headers['X-Webhook-Signature']).toBe(expectedSignature)
  })
})

// ─── Startup signal reports the parsed value the checks act on ──────────────────────────

describe('outbound ops switch startup signal', () => {
  const cases: Array<{ raw: string | undefined; expected: 'on' | 'off' }> = [
    { raw: 'true', expected: 'on' },
    { raw: ' 1 ', expected: 'on' },
    { raw: 'YES', expected: 'on' },
    { raw: '0', expected: 'off' },
    { raw: 'tru', expected: 'off' },
    { raw: 'disabled', expected: 'off' },
    { raw: '', expected: 'off' },
    { raw: undefined, expected: 'off' },
  ]

  for (const { raw, expected } of cases) {
    it(`raw value ${JSON.stringify(raw)}: one signal line, matching the behaviour of all three checks`, async () => {
      const { WebhookService, signals } = await loadService(raw)
      // Constructing more than one service does not repeat the signal.
      new WebhookService(createRecordingDb().db)
      new WebhookService(createRecordingDb().db)
      const lines = signals()
      expect(lines).toHaveLength(1)
      const signal = signalState(lines[0])
      expect(signal).toBe(expected)

      for (const site of ['deliverEvent', 'executeDelivery', 'retryTick'] as const) {
        const run = await runSite(WebhookService, site)
        const behaviour = run.fetchFn.mock.calls.length === 0 && run.state.ops.length === 0 ? 'on' : 'off'
        expect({ site, behaviour }).toEqual({ site, behaviour: signal })
      }
    })
  }

  const laterChanges: Array<{ atLoad: string | undefined; later: string; expected: 'on' | 'off' }> = [
    { atLoad: '1', later: '0', expected: 'on' },
    { atLoad: undefined, later: '1', expected: 'off' },
  ]

  for (const { atLoad, later, expected } of laterChanges) {
    it(`value read at load (${JSON.stringify(atLoad)}) still applies after the env changes to ${JSON.stringify(later)}`, async () => {
      const { WebhookService, signals } = await loadService(atLoad)
      setRawSwitch(later)
      for (const site of ['deliverEvent', 'executeDelivery', 'retryTick'] as const) {
        const run = await runSite(WebhookService, site)
        const behaviour = run.fetchFn.mock.calls.length === 0 && run.state.ops.length === 0 ? 'on' : 'off'
        expect({ site, behaviour }).toEqual({ site, behaviour: expected })
      }
      const lines = signals()
      expect(lines).toHaveLength(1)
      expect(signalState(lines[0])).toBe(expected)
    })
  }
})
