/**
 * Subscription webhook delivery — floor rules (real DB).
 *
 * The floor: a webhook delivers only for its bound sheet, only while its owner passes request admission
 * (live account, login gate, no forced password change), can read and manage automation on the bound
 * sheet, and the sheet is live and not a hidden system sheet. A failed check delivers nothing and never
 * counts as an endpoint failure. The delivery history is readable only while the owner can still read the
 * bound sheet, and never returns stored request or response bodies.
 *
 * Every negative case has a same-fixture positive twin (F0). Events carry no value map (approval write-back
 * shape) or are `record.created`, so no field mask can stand in for the floor check under test.
 * Runs only with DATABASE_URL.
 */
import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

const liveness = vi.hoisted(() => ({ failOnceFor: null as string | null }))

vi.mock('../../src/multitable/sheet-liveness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/sheet-liveness')>()
  return {
    ...actual,
    loadSheetLiveness: async (...args: Parameters<typeof actual.loadSheetLiveness>) => {
      if (liveness.failOnceFor !== null && args[1] === liveness.failOnceFor) {
        liveness.failOnceFor = null
        throw Object.assign(new Error('injected check failure'), { code: '57P01' })
      }
      return actual.loadSheetLiveness(...args)
    },
  }
})

// F9: a read inside the check catches and swallows a statement error (as a schema-tolerant loader would).
const swallow = vi.hoisted(() => ({ forSheet: null as string | null }))
vi.mock('../../src/multitable/stock-preparation-overview-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/stock-preparation-overview-contract')>()
  return {
    ...actual,
    loadStockPreparationOverviewSheetIds: async (...args: Parameters<typeof actual.loadStockPreparationOverviewSheetIds>) => {
      const [query, ids] = args as unknown as [(sql: string) => Promise<unknown>, string[]]
      if (swallow.forSheet && ids.includes(swallow.forSheet)) {
        swallow.forSheet = null
        try {
          await query('SELECT 1 FROM wsf_relation_that_does_not_exist')
        } catch {
          // swallowed
        }
        return new Set<string>()
      }
      return actual.loadStockPreparationOverviewSheetIds(...args)
    },
  }
})
// #6507 review round 2: the three capability resolvers no longer call loadStockPreparationOverviewSheetIds — they read
// the overview kind and the grid-export closure in ONE statement (loadStockPreparationSheetStamps). The same swallowed
// error is injected there, so F9 keeps exercising the check the webhook authority actually runs; the overview-loader
// mock above stays for its non-resolver callers. Whichever fires first consumes `swallow.forSheet`, and F9 asserts it
// WAS consumed (the injection really ran — a mock on a seam nobody calls can no longer make F9 pass vacuously).
vi.mock('../../src/multitable/sheet-grid-export-closure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/sheet-grid-export-closure')>()
  return {
    ...actual,
    loadStockPreparationSheetStamps: async (...args: Parameters<typeof actual.loadStockPreparationSheetStamps>) => {
      const [query, ids] = args as unknown as [(sql: string) => Promise<unknown>, string[]]
      if (swallow.forSheet && ids.includes(swallow.forSheet)) {
        swallow.forSheet = null
        try {
          await query('SELECT 1 FROM wsf_relation_that_does_not_exist')
        } catch {
          // swallowed
        }
        return { overviewSheetIds: new Set<string>(), gridExportClosedSheetIds: new Set<string>() }
      }
      return actual.loadStockPreparationSheetStamps(...args)
    },
  }
})

const authState = vi.hoisted(() => ({ userId: '' }))
vi.mock('../../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth')>()
  const authenticate = (req: any, _res: any, next: () => void) => {
    req.user = { id: authState.userId, roles: [], perms: [] }
    next()
  }
  return { ...actual, authenticate, authMiddleware: authenticate, default: authenticate }
})

import { db } from '../../src/db/db'
import { WebhookService } from '../../src/multitable/webhook-service'
import { apiTokensRouter } from '../../src/routes/api-tokens'
import { usePinnedServer } from '../utils/pinned-server'
import {
  ENTRY_PATHS,
  TICK_SHAPES,
  captureRefusals,
  cleanupFixtureRows,
  createBase,
  createOwner,
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
  revokePermission,
  settle,
  waitFor,
  webhookRow,
  type EntryPath,
  type OwnerOptions,
  type TickShape,
} from './multitable-webhook-scoping-fixtures'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// A DB-expected run (EXPECT_DB=1) must never skip-green.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? test : test.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const pinned = usePinnedServer()
let seq = 0

type FloorCase = {
  label: string
  ownerId: string
  sheetId: string
  otherSheetId: string
  webhookId: string
  url: string
}

/** One owner, one live sheet (no row-level deny) and one other sheet, one webhook bound to the first. */
async function floorCase(
  label: string,
  owner: OwnerOptions = {},
  options: { bind?: 'sheet' | 'null'; systemKind?: string | null } = {},
): Promise<FloorCase> {
  const n = `${label}_${seq++}`
  const ownerId = id(`owner_${n}`)
  const baseId = id(`base_${n}`)
  const sheetId = id(`s0_${n}`)
  const otherSheetId = id(`s2_${n}`)
  const webhookId = id(`wh_${n}`)
  const url = `https://sink.test/floor/${n}/${Date.now()}`
  await createOwner(ownerId, owner)
  await createBase(baseId)
  await createSheet(sheetId, baseId, { systemKind: options.systemKind ?? null })
  await createSheet(otherSheetId, baseId)
  await insertWebhook(webhookId, ownerId, options.bind === 'null' ? null : sheetId, url)
  return { label: n, ownerId, sheetId, otherSheetId, webhookId, url }
}

/** Approval write-back shape: ids only, no value map. */
const idOnly = (sheetId: string, recordId = 'rec_floor') => ({ sheetId, recordId })

async function entry(c: FloorCase, path: EntryPath, payload: Record<string, unknown>, event = 'record.updated') {
  const sink = createSink()
  const svc = new WebhookService(db, sink.fetchFn)
  await svc.deliverEvent(event as never, payload, eventIdFor(path, c.label))
  return { sink, svc }
}

async function tick(c: FloorCase, shape: TickShape, payload: Record<string, unknown>, event = 'record.updated') {
  const deliveryId = id(`del_${c.label}`)
  await insertDuePending(deliveryId, c.webhookId, event, payload, pendingEventIdFor(shape, c.label))
  const sink = createSink()
  const svc = new WebhookService(db, sink.fetchFn)
  await svc.retryFailedDeliveries()
  await settle(100)
  return { sink, deliveryId }
}

describeIfDatabase('subscription webhook floor rules (real DB)', () => {
  let refusals: ReturnType<typeof captureRefusals>

  beforeAll(() => {
    const app = express()
    app.use(express.json())
    app.use(apiTokensRouter())
    pinned.setApp(app)
  })

  afterEach(() => {
    liveness.failOnceFor = null
    swallow.forSheet = null
  })

  afterAll(async () => {
    await cleanupFixtureRows()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── F0: positive twin for every floor refusal ─────────────────────────────────────────────
  for (const path of ENTRY_PATHS) {
    test(`F0.entry [${path}] bound webhook, readable sheet: one row written and one request sent`, async () => {
      refusals = captureRefusals()
      const c = await floorCase('f0e')
      const { sink } = await entry(c, path, idOnly(c.sheetId))
      expect((await deliveryRows(c.webhookId)).length, 'F0.entry.rows').toBe(1)
      expect(await waitFor(() => sink.to(c.url).length, 1), 'F0.entry.sends').toBe(1)
      expect(refusals.reasons(), 'F0.entry.noRefusal').toEqual([])
    })
  }
  for (const shape of TICK_SHAPES) {
    test(`F0.tick [${shape}] due pending row of a bound webhook is sent once`, async () => {
      const c = await floorCase('f0t')
      const { sink, deliveryId } = await tick(c, shape, idOnly(c.sheetId))
      expect(sink.to(c.url).length, 'F0.tick.sends').toBe(1)
      expect((await deliveryRow(deliveryId))?.status, 'F0.tick.status').toBe('success')
    })
  }

  test('F0.execute a direct attempt for a bound webhook with a readable sheet is sent once', async () => {
    const c = await floorCase('f0x')
    const deliveryId = id(`del_${c.label}`)
    await insertDuePending(deliveryId, c.webhookId, 'record.updated', idOnly(c.sheetId), null)
    const sink = createSink()
    await new WebhookService(db, sink.fetchFn).executeDelivery({
      id: deliveryId,
      webhookId: c.webhookId,
      event: 'record.updated',
      payload: idOnly(c.sheetId),
      status: 'pending',
      attemptCount: 0,
      createdAt: new Date().toISOString(),
    })
    expect(sink.to(c.url).length, 'F0.execute.sends').toBe(1)
    expect((await deliveryRow(deliveryId))?.status, 'F0.execute.status').toBe('success')
  })

  for (const variant of ['roleColumn', 'userRoles'] as const) {
    const owner: OwnerOptions = variant === 'roleColumn'
      ? { role: 'admin', permissions: [] }
      : { role: 'user', adminRoleRow: true, permissions: [] }
    for (const path of ENTRY_PATHS) {
      test(`F0.admin.${variant}.entry [${path}] admin without permission codes passes the floor`, async () => {
        refusals = captureRefusals()
        const c = await floorCase('f0admin', owner)
        const { sink } = await entry(c, path, idOnly(c.sheetId))
        expect((await deliveryRows(c.webhookId)).length, 'F0.admin.entry.rows').toBe(1)
        expect(await waitFor(() => sink.to(c.url).length, 1), 'F0.admin.entry.sends').toBe(1)
        expect(refusals.reasons(), 'F0.admin.entry.noRefusal').toEqual([])
      })
    }
    for (const shape of TICK_SHAPES) {
      test(`F0.admin.${variant}.tick [${shape}] admin without permission codes passes the send floor`, async () => {
        const c = await floorCase('f0admint', owner)
        const { sink, deliveryId } = await tick(c, shape, idOnly(c.sheetId))
        expect(sink.to(c.url).length, 'F0.admin.tick.sends').toBe(1)
        expect((await deliveryRow(deliveryId))?.status, 'F0.admin.tick.status').toBe('success')
      })
    }
  }

  for (const order of ['readerFirst', 'deniedFirst'] as const) {
    test(`TO.read [${order}] an owner who cannot read the sheet gets nothing while another owner's webhook delivers`, async () => {
      const n = `tor_${order}_${seq++}`
      const reader = id(`to_reader_${n}`)
      const denied = id(`to_denied_${n}`)
      const baseId = id(`to_base_${n}`)
      const sheetId = id(`to_sheet_${n}`)
      await createOwner(reader)
      await createOwner(denied, { permissions: ['workflow:write'] })
      await createBase(baseId)
      await createSheet(sheetId, baseId)
      const a = { id: id(`to_wh_reader_${n}`), url: `https://sink.test/to/reader/${n}` }
      const b = { id: id(`to_wh_denied_${n}`), url: `https://sink.test/to/denied/${n}` }
      const ordered = order === 'readerFirst' ? [[a, reader], [b, denied]] as const : [[b, denied], [a, reader]] as const
      for (const [h, owner] of ordered) await insertWebhook(h.id, owner, sheetId, h.url, { events: ['record.created'] })
      const sink = createSink()
      await new WebhookService(db, sink.fetchFn).deliverEvent('record.created', { sheetId, recordId: 'rec_to' })
      expect(await waitFor(() => sink.to(a.url).length, 1), 'TO.read.reader.sends').toBe(1)
      await settle(200)
      expect((await deliveryRows(a.id)).length, 'TO.read.reader.rows').toBe(1)
      expect((await deliveryRows(b.id)).length, 'TO.read.denied.rows').toBe(0)
      expect(sink.to(b.url).length, 'TO.read.denied.sends').toBe(0)
    })
  }

  // ── Refusals: entry half (no row, no request) and send half (due pending row → not sent, failed) ──
  type Refusal = {
    id: string
    reason: string
    build: () => Promise<{ c: FloorCase; payload: Record<string, unknown>; event?: string }>
  }
  const refusalCases: Refusal[] = [
    {
      id: 'F2',
      reason: 'no_sheet_binding',
      build: async () => {
        const c = await floorCase('f2', {}, { bind: 'null' })
        return { c, payload: idOnly(c.sheetId) }
      },
    },
    {
      id: 'F3',
      reason: 'sheet_mismatch',
      build: async () => {
        const c = await floorCase('f3')
        return { c, payload: idOnly(c.otherSheetId), event: 'record.created' }
      },
    },
    {
      id: 'F4.inactive',
      reason: 'owner_inactive',
      build: async () => {
        const c = await floorCase('f4i', { isActive: false })
        return { c, payload: idOnly(c.sheetId) }
      },
    },
    {
      id: 'F4.pending',
      reason: 'owner_gate',
      build: async () => {
        const c = await floorCase('f4p', { activationStatus: 'pending_activation' })
        return { c, payload: idOnly(c.sheetId) }
      },
    },
    {
      id: 'F4.mustChange',
      reason: 'owner_must_change_password',
      build: async () => {
        const c = await floorCase('f4m', { mustChangePassword: true })
        return { c, payload: idOnly(c.sheetId) }
      },
    },
    {
      id: 'F5',
      reason: 'sheet_not_readable',
      build: async () => {
        const c = await floorCase('f5')
        await revokePermission(c.ownerId, 'multitable:read')
        return { c, payload: idOnly(c.sheetId) }
      },
    },
    {
      id: 'F10.manageRevoked',
      reason: 'automation_not_manageable',
      build: async () => {
        const c = await floorCase('f10')
        await revokePermission(c.ownerId, 'workflow:write')
        return { c, payload: idOnly(c.sheetId) }
      },
    },
    {
      id: 'F6.deleted',
      reason: 'sheet_not_live',
      build: async () => {
        const c = await floorCase('f6d')
        await q('UPDATE meta_sheets SET deleted_at = now() WHERE id = $1', [c.sheetId])
        return { c, payload: idOnly(c.sheetId) }
      },
    },
    {
      id: 'F6.hidden',
      reason: 'sheet_hidden',
      build: async () => {
        const c = await floorCase('f6h', {}, { systemKind: 'people_directory' })
        return { c, payload: idOnly(c.sheetId) }
      },
    },
  ]

  for (const rc of refusalCases) {
    for (const path of ENTRY_PATHS) {
      test(`${rc.id}.entry [${path}] no delivery row and no request`, async () => {
        refusals = captureRefusals()
        const { c, payload, event } = await rc.build()
        const { sink } = await entry(c, path, payload, event)
        expect((await deliveryRows(c.webhookId)).length, `${rc.id}.entry.rows`).toBe(0)
        await settle()
        expect(sink.to(c.url).length, `${rc.id}.entry.sends`).toBe(0)
        // F2/F3 never become candidates (bound-sheet SQL filter), so no refusal is logged for them.
        if (rc.id !== 'F2' && rc.id !== 'F3') {
          expect(refusals.reasons(), `${rc.id}.entry.reason`).toContain(rc.reason)
        }
      })
    }
    for (const shape of TICK_SHAPES) {
      test(`${rc.id}.send [${shape}] due pending row is not sent and is marked failed`, async () => {
        refusals = captureRefusals()
        const { c, payload, event } = await rc.build()
        const before = await webhookRow(c.webhookId)
        const { sink, deliveryId } = await tick(c, shape, payload, event)
        expect(sink.to(c.url).length, `${rc.id}.send.sends`).toBe(0)
        expect((await webhookRow(c.webhookId))?.failure_count, `${rc.id}.send.failureCount`).toBe(before?.failure_count)
        expect((await deliveryRow(deliveryId))?.status, `${rc.id}.send.status`).toBe('failed')
        expect(refusals.reasons(), `${rc.id}.send.reason`).toContain(rc.reason)
      })
    }
  }

  // ── F8: a failed check delivers nothing and is not an endpoint failure ─────────────────────
  for (const path of ENTRY_PATHS) {
    test(`F8.entry [${path}] check error: no row, no request`, async () => {
      refusals = captureRefusals()
      const c = await floorCase('f8e')
      liveness.failOnceFor = c.sheetId
      const sink = createSink()
      const svc = new WebhookService(db, sink.fetchFn)
      let thrown = 0
      await svc.deliverEvent('record.updated', idOnly(c.sheetId), eventIdFor(path, c.label)).catch(() => {
        thrown += 1
      })
      expect((await deliveryRows(c.webhookId)).length, 'F8.entry.rows').toBe(0)
      await settle()
      expect(sink.to(c.url).length, 'F8.entry.sends').toBe(0)
      expect(refusals.reasons(), 'F8.entry.reason').toContain('authority_check_failed')
      // Durable path surfaces the failed check (so the consumer redelivers); legacy does not throw.
      expect(thrown, 'F8.entry.durableThrows').toBe(path === 'D' ? 1 : 0)
    })
  }
  for (const shape of TICK_SHAPES) {
    test(`F8.send [${shape}] check error before an attempt: no request, attempt counted, failure_count unchanged`, async () => {
      refusals = captureRefusals()
      const c = await floorCase('f8s')
      const before = await webhookRow(c.webhookId)
      liveness.failOnceFor = c.sheetId
      const { sink, deliveryId } = await tick(c, shape, idOnly(c.sheetId))
      expect(sink.to(c.url).length, 'F8.send.sends').toBe(0)
      const after = await webhookRow(c.webhookId)
      expect(after?.failure_count, 'F8.send.failureCount').toBe(before?.failure_count)
      expect(after?.active, 'F8.send.stillActive').toBe(true)
      const row = await deliveryRow(deliveryId)
      expect(Number(row?.attempt_count), 'F8.send.attempt').toBe(1)
      expect(row?.status, 'F8.send.status').toBe('pending')
      expect(new Date(row?.next_retry_at).getTime(), 'F8.send.rescheduled').toBeGreaterThan(Date.now() - 1000)
      expect(refusals.reasons(), 'F8.send.reason').toContain('authority_check_failed')
    })
  }

  // ── F7: delivery history ───────────────────────────────────────────────────────────────────
  async function insertStoredRows(webhookId: string, sheetId: string, n: number) {
    for (let i = 0; i < n; i += 1) {
      await q(
        `INSERT INTO multitable_webhook_deliveries
           (id, webhook_id, event, payload, status, http_status, response_body, attempt_count, created_at, delivered_at)
         VALUES ($1, $2, 'record.updated', $3::jsonb, 'success', 200, 'accepted', 1, now(), now())`,
        [id(`hist_${webhookId}_${i}`), webhookId, JSON.stringify({ sheetId, recordId: `r${i}`, data: { f: i } })],
      )
    }
  }
  const getHistory = (webhookId: string) => request(pinned.url()).get(`/api/multitable/webhooks/${webhookId}/deliveries`)

  test('F7.authorized history: 200, one item per stored row, no stored request/response bodies', async () => {
    const c = await floorCase('f7a')
    await insertStoredRows(c.webhookId, c.sheetId, 2)
    authState.userId = c.ownerId
    const res = await getHistory(c.webhookId)
    expect(res.status, 'F7.authorized.status').toBe(200)
    const items = res.body.data.deliveries as Array<Record<string, unknown>>
    expect(items.length, 'F7.authorized.count').toBe(2)
    for (const item of items) {
      expect(Object.keys(item), 'F7.authorized.no_payload').not.toContain('payload')
      expect(Object.keys(item), 'F7.authorized.no_responseBody').not.toContain('responseBody')
      expect(Object.keys(item), 'F7.authorized.no_response_body').not.toContain('response_body')
    }
  })

  test('F7.denied history after the owner lost read on the bound sheet: 403', async () => {
    const c = await floorCase('f7d')
    await insertStoredRows(c.webhookId, c.sheetId, 2)
    await revokePermission(c.ownerId, 'multitable:read')
    authState.userId = c.ownerId
    const res = await getHistory(c.webhookId)
    expect(res.status, 'F7.denied.status').toBe(403)
    expect(JSON.stringify(res.body), 'F7.denied.noRows').not.toContain('deliveries')
  })

  for (const [tid, owner] of [
    ['F7.inactive', { isActive: false }],
    ['F7.pending', { activationStatus: 'pending_activation' }],
    ['F7.mustChange', { mustChangePassword: true }],
  ] as const) {
    test(`${tid} history when the owner no longer passes request admission: 403`, async () => {
      const c = await floorCase(tid.toLowerCase().replace('.', ''), owner as OwnerOptions)
      await insertStoredRows(c.webhookId, c.sheetId, 2)
      authState.userId = c.ownerId
      const res = await getHistory(c.webhookId)
      expect(res.status, `${tid}.status`).toBe(403)
    })
  }

  test('F7.error history when the access check cannot be completed: 500 without rows', async () => {
    const c = await floorCase('f7e')
    await insertStoredRows(c.webhookId, c.sheetId, 2)
    authState.userId = c.ownerId
    liveness.failOnceFor = c.sheetId
    const res = await getHistory(c.webhookId)
    expect(res.status, 'F7.error.status').toBe(500)
    expect(JSON.stringify(res.body), 'F7.error.noRows').not.toContain('deliveries')
  })

  // ── F9: an error swallowed inside the check still refuses (closing sentinel) ─────────────
  for (const swallowed of [false, true]) {
    const tid = swallowed ? 'F9' : 'F9+'
    test(`${tid} ${swallowed ? 'a statement error swallowed inside the check → refused' : 'same fixture, no error → delivered'}`, async () => {
      refusals = captureRefusals()
      const c = await floorCase(swallowed ? 'f9' : 'f9p', { role: 'admin' })
      swallow.forSheet = swallowed ? c.sheetId : null
      const sink = createSink()
      await new WebhookService(db, sink.fetchFn).deliverEvent('record.deleted' as never, idOnly(c.sheetId))
      // The injection must have actually run inside the check (it clears the flag when it fires).
      if (swallowed) expect(swallow.forSheet, 'F9.injected').toBeNull()
      expect((await deliveryRows(c.webhookId)).length, `${tid}.rows`).toBe(swallowed ? 0 : 1)
      if (swallowed) expect(refusals.reasons(), 'F9.reason').toContain('authority_check_failed')
    })
  }

  test('F7.null history of an unbound webhook: 200 and an empty list', async () => {
    const c = await floorCase('f7n', {}, { bind: 'null' })
    await insertStoredRows(c.webhookId, c.sheetId, 2)
    authState.userId = c.ownerId
    const res = await getHistory(c.webhookId)
    expect(res.status, 'F7.null.status').toBe(200)
    expect((res.body.data.deliveries as unknown[]).length, 'F7.null.count').toBe(0)
  })
})
