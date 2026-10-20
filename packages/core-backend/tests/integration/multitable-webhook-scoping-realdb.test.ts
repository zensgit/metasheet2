/**
 * Subscription webhook delivery rules — real-DB permission matrix (M1–M23 except M21; U12, U13, U14).
 *
 * Rule: a subscription webhook delivers only what its owner can read through the product at delivery time —
 * only the bound sheet, only rows the owner can read there (on row-level-deny sheets a row that is no longer
 * live is not delivered), only fields the owner can see (same chain as the record read path), only the
 * envelope allow-list. Every refusal has a same-fixture positive twin.
 *
 * Synthetic data only; payloads are fed straight into `deliverEvent` (legacy shape without an event id,
 * durable shape with one) or inserted as due pending rows for the retry tick. Outbound HTTP is a loopback
 * stub. Step order, not timing, sequences every "before / after". Runs only with DATABASE_URL.
 */
import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

// ── Partial replacements (default: delegate to the real implementation) ─────────────────────
const hooks = vi.hoisted(() => ({
  /** M22: before the deny read for this record, delete the record on another connection. */
  deleteBeforeDenyRead: null as null | { recordId: string; run: () => Promise<void> },
  /** M23 / U13 / U14: throw once on the first access read for any of these owners. */
  failAccessOnceFor: null as null | Set<string>,
  failedOwner: null as null | string,
}))

vi.mock('../../src/multitable/permission-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/permission-service')>()
  return {
    ...actual,
    isRecordReadDeniedForUserStrict: async (...args: Parameters<typeof actual.isRecordReadDeniedForUserStrict>) => {
      const armed = hooks.deleteBeforeDenyRead
      if (armed && args[2] === armed.recordId) {
        hooks.deleteBeforeDenyRead = null
        await armed.run()
      }
      return actual.isRecordReadDeniedForUserStrict(...args)
    },
  }
})

vi.mock('../../src/multitable/recovery-authorization-stability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/recovery-authorization-stability')>()
  return {
    ...actual,
    loadDatabaseFreshRecoveryAccess: async (...args: Parameters<typeof actual.loadDatabaseFreshRecoveryAccess>) => {
      const armed = hooks.failAccessOnceFor
      if (armed && armed.has(args[1])) {
        hooks.failAccessOnceFor = null
        hooks.failedOwner = args[1]
        throw Object.assign(new Error('injected check failure'), { code: '57P01' })
      }
      return actual.loadDatabaseFreshRecoveryAccess(...args)
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
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  deriveElearningProjectionBaseId,
  deriveElearningProjectionSheetId,
} from '../../src/multitable/elearning-projection-constants'
import { WebhookService } from '../../src/multitable/webhook-service'
import { apiTokensRouter } from '../../src/routes/api-tokens'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { usePinnedServer } from '../utils/pinned-server'
import {
  ENTRY_PATHS,
  TICK_SHAPES,
  captureRefusals,
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
  parseBody,
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

/**
 * One owner and their sheets:
 *  S1 — row-level read deny ON; fields F-pub, F-pub2, F-hid (hidden from the owner by field_permissions
 *       only), F-def (hidden by the field definition only), F-taint (formula over a lookup whose foreign
 *       target the owner cannot see — excluded by the formula-taint step only), F-status (rule input),
 *       L-pub (link to a sheet the owner cannot read); rows R-ok (readable), R-deny (record grant 'none'),
 *       R-rule (denied by a conditional rule).
 *  S0 — no row-level deny; F-pub0; row R0.   S2 — another readable sheet; F-s2; row R2.
 */
async function world(label: string, owner: OwnerOptions = {}) {
  const n = `${label}_${seq++}`
  const w = {
    n,
    ownerId: id(`owner_${n}`),
    baseA: id(`baseA_${n}`),
    baseB: id(`baseB_${n}`),
    s1: id(`s1_${n}`),
    s0: id(`s0_${n}`),
    s2: id(`s2_${n}`),
    fx: id(`fx_${n}`),
    fy: id(`fy_${n}`),
    fPub: id(`fpub_${n}`),
    fPub2: id(`fpub2_${n}`),
    fHid: id(`fhid_${n}`),
    fDef: id(`fdef_${n}`),
    fStatus: id(`fstatus_${n}`),
    fLink: id(`flink_${n}`),
    fLookup: id(`flookup_${n}`),
    fTaint: id(`ftaint_${n}`),
    lPub: id(`lpub_${n}`),
    fxTarget: id(`fxt_${n}`),
    fyName: id(`fyn_${n}`),
    fPub0: id(`fpub0_${n}`),
    fS2: id(`fs2_${n}`),
    rOk: id(`rok_${n}`),
    rDeny: id(`rdeny_${n}`),
    rRule: id(`rrule_${n}`),
    rFx: id(`rfx_${n}`),
    rFy: id(`rfy_${n}`),
    r0: id(`r0_${n}`),
    r2: id(`r2_${n}`),
  }
  await createOwner(w.ownerId, owner)
  await createBase(w.baseA)
  await createBase(w.baseB)
  await createSheet(w.s1, w.baseA, { rowLevelDeny: true })
  await createSheet(w.s0, w.baseA)
  await createSheet(w.s2, w.baseA)
  await createSheet(w.fx, w.baseB)
  await createSheet(w.fy, w.baseA)
  // Foreign target the owner cannot see (makes F-taint tainted).
  await createField(w.fxTarget, w.fx, 'number', {}, 1)
  await createRecord(w.rFx, w.fx, { [w.fxTarget]: 7 })
  await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,false,false)', [w.fx, w.fxTarget, 'user', w.ownerId])
  // A sheet the owner cannot read (sheet assignment without a read code).
  await createField(w.fyName, w.fy, 'string', {}, 1)
  await createRecord(w.rFy, w.fy, { [w.fyName]: 'y' })
  await q(`INSERT INTO spreadsheet_permissions (sheet_id, user_id, perm_code, subject_type, subject_id) VALUES ($1, $2, 'spreadsheet:none', 'user', $2)`, [w.fy, w.ownerId])
  // S1 fields.
  await createField(w.fPub, w.s1, 'string', {}, 1)
  await createField(w.fPub2, w.s1, 'string', {}, 2)
  await createField(w.fHid, w.s1, 'string', {}, 3)
  await createField(w.fDef, w.s1, 'string', { hidden: true }, 4)
  await createField(w.fStatus, w.s1, 'string', {}, 5)
  await createField(w.fLink, w.s1, 'link', { foreignSheetId: w.fx }, 6)
  await createField(w.fLookup, w.s1, 'lookup', { linkFieldId: w.fLink, targetFieldId: w.fxTarget, foreignSheetId: w.fx }, 7)
  await createField(w.fTaint, w.s1, 'formula', { expression: `={${w.fLookup}}+1` }, 8)
  await createField(w.lPub, w.s1, 'link', { foreignSheetId: w.fy }, 9)
  await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)', [w.s1, w.fTaint, w.fLookup, w.s1])
  await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,false,false)', [w.s1, w.fHid, 'user', w.ownerId])
  await createRecord(w.rOk, w.s1, { [w.fPub]: 'a', [w.fStatus]: 'public', [w.fLink]: [w.rFx], [w.fTaint]: 8, [w.lPub]: [w.rFy] })
  await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [id(`lnk_${n}`), w.fLink, w.rOk, w.rFx])
  await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [id(`lnky_${n}`), w.lPub, w.rOk, w.rFy])
  await createRecord(w.rDeny, w.s1, { [w.fPub]: 'b', [w.fStatus]: 'public' })
  await q(`INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,'user',$3,'none')`, [w.s1, w.rDeny, w.ownerId])
  await createRecord(w.rRule, w.s1, { [w.fPub]: 'c', [w.fStatus]: 'secret' })
  await q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [
    w.s1,
    JSON.stringify([{ id: 'deny_secret', fieldId: w.fStatus, operator: 'eq', value: 'secret', effect: 'deny_read' }]),
  ])
  // S0 and S2.
  await createField(w.fPub0, w.s0, 'string', {}, 1)
  await createRecord(w.r0, w.s0, { [w.fPub0]: 'z' })
  await createField(w.fS2, w.s2, 'string', {}, 1)
  await createRecord(w.r2, w.s2, { [w.fS2]: 's' })
  return w
}
type World = Awaited<ReturnType<typeof world>>

async function hook(w: World, sheetId: string | null, label: string, opts: { maxRetries?: number; ownerId?: string } = {}) {
  const webhookId = id(`wh_${label}_${w.n}`)
  const url = `https://sink.test/scoping/${label}/${w.n}/${Date.now()}`
  await insertWebhook(webhookId, opts.ownerId ?? w.ownerId, sheetId, url, { maxRetries: opts.maxRetries })
  return { webhookId, url }
}

async function deliver(path: EntryPath, label: string, event: string, payload: Record<string, unknown>) {
  const sink = createSink()
  const svc = new WebhookService(db, sink.fetchFn)
  await svc.deliverEvent(event as never, payload, eventIdFor(path, label))
  return sink
}

async function tickOnce(sink = createSink()) {
  await new WebhookService(db, sink.fetchFn).retryFailedDeliveries()
  await settle(100)
  return sink
}

/** Entry-path refusal: no row, no request, and the logged reason. */
async function expectRefused(tid: string, webhookId: string, url: string, sink: ReturnType<typeof createSink>, reasons: string[], reason: string | null) {
  expect((await deliveryRows(webhookId)).length, `${tid}.rows`).toBe(0)
  await settle()
  expect(sink.to(url).length, `${tid}.sends`).toBe(0)
  if (reason) expect(reasons, `${tid}.reason`).toContain(reason)
}

/** Entry-path delivery: one row and one request; returns the request body and the stored row payload. */
async function expectDelivered(tid: string, webhookId: string, url: string, sink: ReturnType<typeof createSink>) {
  const rows = await deliveryRows(webhookId)
  expect(rows.length, `${tid}.rows`).toBe(1)
  expect(await waitFor(() => sink.to(url).length, 1), `${tid}.sends`).toBe(1)
  const stored = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload
  return { body: parseBody(sink.to(url)[0].body), stored: stored as Record<string, unknown> }
}

describeIfDatabase('subscription webhook delivery rules — real-DB matrix', () => {
  let refusals: ReturnType<typeof captureRefusals>

  beforeAll(() => {
    const app = express()
    app.use(express.json())
    app.use(apiTokensRouter())
    app.use((req, _res, next) => {
      ;(req as any).user = { id: authState.userId, roles: [], perms: ['multitable:read', 'workflow:write'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    pinned.setApp(app)
  })

  afterEach(() => {
    hooks.deleteBeforeDenyRead = null
    hooks.failAccessOnceFor = null
    hooks.failedOwner = null
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await cleanupFixtureRows()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  for (const path of ENTRY_PATHS) {
    describe(`entry path [${path}]`, () => {
      const P = `[${path}]`

      test(`M1 ${P} readable row, readable field: delivered with that field only`, async () => {
        const w = await world('m1')
        const h = await hook(w, w.s1, 'm1')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: w.s1, recordId: w.rOk, changes: { [w.fPub]: 'x' } })
        const { body, stored } = await expectDelivered('M1', h.webhookId, h.url, sink)
        expect(body.changes, 'M1.body').toEqual({ [w.fPub]: 'x' })
        expect(stored.changes, 'M1.rowPayload').toEqual({ [w.fPub]: 'x' })
      })

      test(`M2 ${P} a field hidden from the owner by field permissions is not delivered`, async () => {
        const w = await world('m2')
        const h = await hook(w, w.s1, 'm2')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: w.s1, recordId: w.rOk, changes: { [w.fPub]: 'x', [w.fHid]: 'secret-value' } })
        const { body, stored } = await expectDelivered('M2', h.webhookId, h.url, sink)
        expect(Object.keys(body.changes as object), 'M2.noFhid').not.toContain(w.fHid)
        expect(JSON.stringify(body), 'M2.noFhidValue').not.toContain('secret-value')
        expect(Object.keys(stored.changes as object), 'M2.rowNoFhid').not.toContain(w.fHid)
      })

      test(`M3 ${P} an update that only touched a field hidden from the owner is not delivered`, async () => {
        refusals = captureRefusals()
        const w = await world('m3')
        const h = await hook(w, w.s1, 'm3')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: w.s1, recordId: w.rOk, changes: { [w.fHid]: 'y' } })
        await expectRefused('M3', h.webhookId, h.url, sink, refusals.reasons(), 'all_values_masked')
      })

      test(`M4 ${P} an event from another sheet is not delivered`, async () => {
        const w = await world('m4')
        const h = await hook(w, w.s0, 'm4')
        const sink = await deliver(path, w.n, 'record.created', { sheetId: w.s2, recordId: w.r2, data: { [w.fS2]: 's' } })
        await expectRefused('M4', h.webhookId, h.url, sink, [], null)
      })

      test(`M4+ ${P} the same webhook gets its own sheet's event`, async () => {
        const w = await world('m4p')
        const h = await hook(w, w.s0, 'm4p')
        const sink = await deliver(path, w.n, 'record.created', { sheetId: w.s0, recordId: w.r0, data: { [w.fPub0]: 'z' } })
        await expectDelivered('M4+', h.webhookId, h.url, sink)
      })

      const idOnly = (w: World) => ({ sheetId: w.s0, recordId: w.r0 })
      const floorCases: Array<{ tid: string; reason: string; owner?: OwnerOptions; after?: (w: World) => Promise<void> }> = [
        { tid: 'M5', reason: 'sheet_not_readable', after: (w) => revokePermission(w.ownerId, 'multitable:read') },
        { tid: 'M6', reason: 'owner_inactive', owner: { isActive: false } },
        { tid: 'M6a', reason: 'owner_gate', owner: { activationStatus: 'pending_activation' } },
        { tid: 'M6c', reason: 'owner_must_change_password', owner: { mustChangePassword: true } },
        { tid: 'M8', reason: 'sheet_not_live', after: async (w) => { await q('UPDATE meta_sheets SET deleted_at = now() WHERE id = $1', [w.s0]) } },
        { tid: 'M19', reason: 'automation_not_manageable', owner: { permissions: ['multitable:read'] } },
      ]
      for (const fc of floorCases) {
        test(`${fc.tid} ${P} id-only update refused (${fc.reason})`, async () => {
          refusals = captureRefusals()
          const w = await world(fc.tid.toLowerCase(), fc.owner)
          const h = await hook(w, w.s0, fc.tid.toLowerCase())
          if (fc.after) await fc.after(w)
          const sink = await deliver(path, w.n, 'record.updated', idOnly(w))
          await expectRefused(fc.tid, h.webhookId, h.url, sink, refusals.reasons(), fc.reason)
        })
      }
      for (const tid of ['M5+', 'M8+']) {
        test(`${tid} ${P} same fixture before the change: delivered`, async () => {
          const w = await world(tid.replace('+', 'p').toLowerCase())
          const h = await hook(w, w.s0, tid.replace('+', 'p').toLowerCase())
          const sink = await deliver(path, w.n, 'record.updated', idOnly(w))
          await expectDelivered(tid, h.webhookId, h.url, sink)
        })
      }

      test(`M7 ${P} a row denied to the owner is not delivered`, async () => {
        refusals = captureRefusals()
        const w = await world('m7')
        const h = await hook(w, w.s1, 'm7')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: w.s1, recordId: w.rDeny, changes: { [w.fPub]: 'x' } })
        await expectRefused('M7', h.webhookId, h.url, sink, refusals.reasons(), 'record_read_denied')
      })

      test(`M7b ${P} a link value is delivered exactly as the record list returns it to the owner`, async () => {
        const w = await world('m7b')
        const h = await hook(w, w.s1, 'm7b')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: w.s1, recordId: w.rOk, changes: { [w.fPub]: 'x', [w.lPub]: [w.rFy] } })
        const { body } = await expectDelivered('M7b', h.webhookId, h.url, sink)
        authState.userId = w.ownerId
        const res = await request(pinned.url()).get('/api/multitable/records').query({ sheetId: w.s1, limit: 100 })
        expect(res.status, 'M7b.listStatus').toBe(200)
        const listed = (res.body.data.records as Array<{ id: string; data: Record<string, unknown> }>).find((r) => r.id === w.rOk)
        expect(listed, 'M7b.listed').toBeDefined()
        const changes = body.changes as Record<string, unknown>
        expect(w.lPub in changes, 'M7b.presence').toBe(w.lPub in (listed!.data ?? {}))
        if (w.lPub in changes) expect(changes[w.lPub], 'M7b.value').toEqual(listed!.data[w.lPub])
      })

      for (const shape of ['data', 'changes', 'fwbDecision', 'fwbLink'] as const) {
        for (const actor of ['user', 'admin'] as const) {
          const tid = `M11.${shape}.${actor}`
          test(`${tid} ${P} producer shape delivered with the allowed envelope`, async () => {
            const w = await world(`m11${shape}${actor}`, actor === 'admin' ? { role: 'admin' } : {})
            const h = await hook(w, w.s1, `m11${shape}${actor}`)
            const base = { sheetId: w.s1, recordId: w.rOk }
            const payload =
              shape === 'data' ? { ...base, data: { [w.fPub]: 'x', [w.fHid]: 'y' }, actorId: w.ownerId }
              : shape === 'changes' ? { ...base, changes: { [w.fPub]: 'x', [w.fHid]: 'y' }, _automationDepth: 1 }
              : shape === 'fwbDecision' ? { ...base, nodeKey: 'node_1', entryEpoch: 2 }
              : { ...base }
            const sink = await deliver(path, w.n, 'record.updated', payload)
            const { body } = await expectDelivered(tid, h.webhookId, h.url, sink)
            if (shape === 'data' || shape === 'changes') {
              expect(body[shape], `${tid}.values`).toEqual({ [w.fPub]: 'x' })
            } else {
              expect(Object.keys(body).sort(), `${tid}.keys`).toEqual(['recordId', 'sheetId'])
            }
          })
        }
      }

      for (const variant of ['roleColumn', 'userRoles', 'roleColumn.noCodes'] as const) {
        test(`M13.${variant} ${P} an admin owner follows the read path's admin exception for denied rows`, async () => {
          // roleColumn.noCodes: admin only through users.role, with no permission codes at all — still an
          // active account (the account check must not be read as "has no permission codes").
          const owner: OwnerOptions =
            variant === 'roleColumn' ? { role: 'admin' }
            : variant === 'userRoles' ? { role: 'user', adminRoleRow: true }
            : { role: 'admin', permissions: [] }
          const w = await world(`m13${variant}`, owner)
          const h = await hook(w, w.s1, `m13${variant}`)
          const sink = await deliver(path, w.n, 'record.updated', { sheetId: w.s1, recordId: w.rDeny, changes: { [w.fPub]: 'x' } })
          await expectDelivered(`M13.${variant}`, h.webhookId, h.url, sink)
        })
      }

      test(`M14 ${P} a formula field over a lookup the owner cannot see is not delivered`, async () => {
        const w = await world('m14')
        const h = await hook(w, w.s1, 'm14')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: w.s1, recordId: w.rOk, changes: { [w.fPub]: 'x', [w.fTaint]: 8 } })
        const { body } = await expectDelivered('M14', h.webhookId, h.url, sink)
        expect(Object.keys(body.changes as object), 'M14.noFtaint').not.toContain(w.fTaint)
        expect(body.changes, 'M14.kept').toEqual({ [w.fPub]: 'x' })
      })

      test(`M15 ${P} an e-learning projection sheet is not delivered to a non-admin owner`, async () => {
        refusals = captureRefusals()
        const w = await world('m15')
        const orgId = id(`org_${w.n}`)
        const elBase = deriveElearningProjectionBaseId(orgId)
        const elSheet = deriveElearningProjectionSheetId(orgId)
        await createBase(elBase)
        await createSheet(elSheet, elBase, { systemKind: 'elearning_projection' })
        await q('INSERT INTO elearning_stats_multitable_sheets (org_id, base_id, sheet_id) VALUES ($1,$2,$3)', [orgId, elBase, elSheet])
        const h = await hook(w, elSheet, 'm15')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: elSheet, recordId: 'rec_el' })
        await expectRefused('M15', h.webhookId, h.url, sink, refusals.reasons(), 'sheet_not_readable')
      })

      test(`M16 ${P} a field hidden by its definition is not delivered`, async () => {
        const w = await world('m16')
        const h = await hook(w, w.s1, 'm16')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: w.s1, recordId: w.rOk, data: { [w.fPub]: 'x', [w.fDef]: 'y' } })
        const { body } = await expectDelivered('M16', h.webhookId, h.url, sink)
        expect(Object.keys(body.data as object), 'M16.noFdef').not.toContain(w.fDef)
        expect(body.data, 'M16.kept').toEqual({ [w.fPub]: 'x' })
      })

      for (const event of ['updated', 'created'] as const) {
        test(`M17.${event} ${P} a rule-denied row removed before the check is not delivered`, async () => {
          refusals = captureRefusals()
          const w = await world(`m17${event}`)
          const h = await hook(w, w.s1, `m17${event}`)
          await q('DELETE FROM meta_records WHERE id = $1', [w.rRule])
          const key = event === 'updated' ? 'changes' : 'data'
          const sink = await deliver(path, w.n, `record.${event}`, { sheetId: w.s1, recordId: w.rRule, [key]: { [w.fPub]: 'x' } })
          await expectRefused(`M17.${event}`, h.webhookId, h.url, sink, refusals.reasons(), 'record_not_live')
        })
      }

      for (const event of ['updated', 'created'] as const) {
        test(`M17+.${event} ${P} the same event on a live readable row is delivered`, async () => {
          const w = await world(`m17p${event}`)
          const h = await hook(w, w.s1, `m17p${event}`)
          const key = event === 'updated' ? 'changes' : 'data'
          const sink = await deliver(path, w.n, `record.${event}`, { sheetId: w.s1, recordId: w.rOk, [key]: { [w.fPub]: 'x' } })
          await expectDelivered(`M17+.${event}`, h.webhookId, h.url, sink)
        })
      }

      test(`M17d ${P} record.deleted on a row-level-deny sheet is not delivered to a non-admin owner`, async () => {
        refusals = captureRefusals()
        const w = await world('m17d')
        const h = await hook(w, w.s1, 'm17d')
        await q('DELETE FROM meta_records WHERE id = $1', [w.rRule])
        const sink = await deliver(path, w.n, 'record.deleted', { sheetId: w.s1, recordId: w.rRule })
        await expectRefused('M17d', h.webhookId, h.url, sink, refusals.reasons(), 'record_not_live')
      })

      test(`M17d+.s0 ${P} record.deleted on a sheet without row-level deny is delivered (ids only)`, async () => {
        const w = await world('m17ds0')
        const h = await hook(w, w.s0, 'm17ds0')
        await q('DELETE FROM meta_records WHERE id = $1', [w.r0])
        const sink = await deliver(path, w.n, 'record.deleted', { sheetId: w.s0, recordId: w.r0, actorId: w.ownerId })
        const { body } = await expectDelivered('M17d+.s0', h.webhookId, h.url, sink)
        expect(Object.keys(body).sort(), 'M17d+.s0.keys').toEqual(['recordId', 'sheetId'])
      })

      test(`M17d+.admin ${P} record.deleted is delivered to an admin owner (ids only)`, async () => {
        const w = await world('m17dad', { role: 'admin' })
        const h = await hook(w, w.s1, 'm17dad')
        await q('DELETE FROM meta_records WHERE id = $1', [w.rRule])
        const sink = await deliver(path, w.n, 'record.deleted', { sheetId: w.s1, recordId: w.rRule, actorId: w.ownerId })
        const { body } = await expectDelivered('M17d+.admin', h.webhookId, h.url, sink)
        expect(Object.keys(body).sort(), 'M17d+.admin.keys').toEqual(['recordId', 'sheetId'])
      })

      test(`M18 ${P} a hidden system (people) sheet is not delivered`, async () => {
        refusals = captureRefusals()
        const w = await world('m18')
        const people = id(`people_${w.n}`)
        await createSheet(people, w.baseA, { systemKind: 'people_directory' })
        const h = await hook(w, people, 'm18')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: people, recordId: 'rec_p' })
        await expectRefused('M18', h.webhookId, h.url, sink, refusals.reasons(), 'sheet_hidden')
      })

      test(`M21+ ${P} ops switch off: an event is written and sent`, async () => {
        const w = await world('m21p')
        const h = await hook(w, w.s0, 'm21p')
        const sink = await deliver(path, w.n, 'record.updated', { sheetId: w.s0, recordId: w.r0, changes: { [w.fPub0]: 'b' } })
        await expectDelivered('M21+', h.webhookId, h.url, sink)
      })

      for (const target of ['rule', 'ok'] as const) {
        const tid = target === 'rule' ? 'M22' : 'M22+'
        test(`${tid} ${P} liveness and the deny read come from one snapshot (row removed mid-check)`, async () => {
          refusals = captureRefusals()
          const w = await world(`m22${target}`)
          const h = await hook(w, w.s1, `m22${target}`)
          const recordId = target === 'rule' ? w.rRule : w.rOk
          hooks.deleteBeforeDenyRead = {
            recordId,
            run: async () => {
              await poolManager.get().query('DELETE FROM meta_records WHERE id = $1', [recordId])
            },
          }
          await deliver(path, w.n, 'record.updated', { sheetId: w.s1, recordId, changes: { [w.fPub]: 'x' } })
          const rows = await deliveryRows(h.webhookId)
          if (target === 'rule') {
            expect(rows.length, 'M22.rows').toBe(0)
            expect(refusals.reasons(), 'M22.reason').toContain('record_read_denied')
          } else {
            expect(rows.length, 'M22+.rows').toBe(1)
          }
          // The mid-check removal really happened inside the deny read.
          expect(hooks.deleteBeforeDenyRead, `${tid}.armedUsed`).toBeNull()
        })
      }
    })
  }

  // ── Durable-only ─────────────────────────────────────────────────────────────────────────
  test('M12 [D] the same event id delivered twice: one row, one request', async () => {
    const w = await world('m12')
    const h = await hook(w, w.s0, 'm12')
    const sink = createSink()
    const svc = new WebhookService(db, sink.fetchFn)
    const eventId = id(`evt_m12_${w.n}`)
    await svc.deliverEvent('record.updated', { sheetId: w.s0, recordId: w.r0 }, eventId)
    await svc.deliverEvent('record.updated', { sheetId: w.s0, recordId: w.r0 }, eventId)
    expect((await deliveryRows(h.webhookId)).length, 'M12.rows').toBe(1)
    expect(await waitFor(() => sink.to(h.url).length, 1), 'M12.sends').toBe(1)
  })

  // ── TO: webhooks of different owners on the same sheet and event are decided per owner ────
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
      await waitFor(() => sink.to(a.url).length, 1)
      await settle(200)
      expect((await deliveryRows(a.id)).length, 'TO.read.reader.rows').toBe(1)
      expect((await deliveryRows(b.id)).length, 'TO.read.denied.rows').toBe(0)
      expect(sink.to(b.url).length, 'TO.read.denied.sends').toBe(0)
    })

    test(`TO.field [${order}] a field one owner cannot see is absent from that owner's body only`, async () => {
      const n = `tof_${order}_${seq++}`
      const admin = id(`to_admin_${n}`)
      const user = id(`to_user_${n}`)
      const baseId = id(`to_base_${n}`)
      const sheetId = id(`to_sheet_${n}`)
      const fPub = id(`to_fpub_${n}`)
      const fHid = id(`to_fhid_${n}`)
      const recordId = id(`to_rec_${n}`)
      await createOwner(admin, { role: 'admin' })
      await createOwner(user)
      await createBase(baseId)
      await createSheet(sheetId, baseId)
      await createField(fPub, sheetId, 'string', {}, 1)
      await createField(fHid, sheetId, 'string', {}, 2)
      await createRecord(recordId, sheetId, { [fPub]: 'p', [fHid]: 'h' })
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,false,false)', [sheetId, fHid, 'user', user])
      const a = { id: id(`to_wh_admin_${n}`), url: `https://sink.test/tof/admin/${n}` }
      const u = { id: id(`to_wh_user_${n}`), url: `https://sink.test/tof/user/${n}` }
      const ordered = order === 'readerFirst' ? [[a, admin], [u, user]] as const : [[u, user], [a, admin]] as const
      for (const [h, owner] of ordered) await insertWebhook(h.id, owner, sheetId, h.url, { events: ['record.created'] })
      const sink = createSink()
      await new WebhookService(db, sink.fetchFn).deliverEvent('record.created', { sheetId, recordId, data: { [fPub]: 'p', [fHid]: 'h' } })
      await waitFor(() => sink.to(a.url).length + sink.to(u.url).length, 2)
      expect(sink.to(a.url).length, 'TO.field.admin.sends').toBe(1)
      expect(sink.to(u.url).length, 'TO.field.user.sends').toBe(1)
      expect(Object.keys(parseBody(sink.to(a.url)[0].body).data as object).sort(), 'TO.field.admin.keys').toEqual([fHid, fPub].sort())
      expect(Object.keys(parseBody(sink.to(u.url)[0].body).data as object), 'TO.field.user.keys').toEqual([fPub])
      // The stored rows are decided per owner too (each attempt re-masks, so check the rows themselves).
      const storedData = async (webhookId: string) => {
        const [row] = await deliveryRows(webhookId)
        const payload = typeof row?.payload === 'string' ? JSON.parse(row.payload) : row?.payload
        return Object.keys((payload?.data ?? {}) as object).sort()
      }
      expect(await storedData(a.id), 'TO.field.admin.rowKeys').toEqual([fHid, fPub].sort())
      expect(await storedData(u.id), 'TO.field.user.rowKeys').toEqual([fPub])
    })
  }

  async function twoOwners(label: string) {
    const w = await world(label)
    const otherOwner = id(`owner2_${w.n}`)
    await createOwner(otherOwner)
    const a = await hook(w, w.s0, `${label}a`)
    const b = await hook(w, w.s0, `${label}b`, { ownerId: otherOwner })
    return { w, owners: new Map([[w.ownerId, a], [otherOwner, b]]) }
  }

  test('M23 [D] a failed check on one webhook does not stop the other; the redelivery completes it', async () => {
    const { w, owners } = await twoOwners('m23')
    const sink = createSink()
    const svc = new WebhookService(db, sink.fetchFn)
    const eventId = id(`evt_m23_${w.n}`)
    hooks.failAccessOnceFor = new Set(owners.keys())
    let thrown = 0
    await svc.deliverEvent('record.updated', { sheetId: w.s0, recordId: w.r0 }, eventId).catch(() => {
      thrown += 1
    })
    const failed = (hooks.failedOwner as string | null) ?? [...owners.keys()][0]
    const A = owners.get(failed)!
    const B = [...owners.entries()].find(([k]) => k !== failed)![1]
    expect((await deliveryRows(B.webhookId)).length, 'M23.first.B.rows').toBe(1)
    expect(await waitFor(() => sink.to(B.url).length, 1), 'M23.first.B.sends').toBe(1)
    expect((await deliveryRows(A.webhookId)).length, 'M23.first.A.rows').toBe(0)
    expect(thrown, 'M23.first.throws').toBe(1)
    await svc.deliverEvent('record.updated', { sheetId: w.s0, recordId: w.r0 }, eventId)
    expect((await deliveryRows(B.webhookId)).length, 'M23.second.B.rows').toBe(1)
    expect((await deliveryRows(A.webhookId)).length, 'M23.second.A.rows').toBe(1)
    expect(await waitFor(() => sink.to(A.url).length, 1), 'M23.second.A.sends').toBe(1)
    expect(sink.to(B.url).length, 'M23.second.B.sends').toBe(1)
  })

  test('U13.legacy [L] a failed check on one webhook is isolated; the other is delivered; no throw', async () => {
    const { w, owners } = await twoOwners('u13l')
    const sink = createSink()
    hooks.failAccessOnceFor = new Set(owners.keys())
    await new WebhookService(db, sink.fetchFn).deliverEvent('record.updated', { sheetId: w.s0, recordId: w.r0 })
    const failed = (hooks.failedOwner as string | null) ?? [...owners.keys()][0]
    const A = owners.get(failed)!
    const B = [...owners.entries()].find(([k]) => k !== failed)![1]
    expect((await deliveryRows(B.webhookId)).length, 'U13.legacy.B.rows').toBe(1)
    expect(await waitFor(() => sink.to(B.url).length, 1), 'U13.legacy.B.sends').toBe(1)
    expect((await deliveryRows(A.webhookId)).length, 'U13.legacy.A.rows').toBe(0)
  })

  test('U13.durable [D] a failed check on one webhook: the other is claimed and sent, then deliverEvent throws once', async () => {
    const { w, owners } = await twoOwners('u13d')
    const sink = createSink()
    hooks.failAccessOnceFor = new Set(owners.keys())
    let thrown = 0
    await new WebhookService(db, sink.fetchFn)
      .deliverEvent('record.updated', { sheetId: w.s0, recordId: w.r0 }, id(`evt_u13_${w.n}`))
      .catch(() => {
        thrown += 1
      })
    const failed = (hooks.failedOwner as string | null) ?? [...owners.keys()][0]
    const A = owners.get(failed)!
    const B = [...owners.entries()].find(([k]) => k !== failed)![1]
    expect((await deliveryRows(B.webhookId)).length, 'U13.durable.B.rows').toBe(1)
    expect(await waitFor(() => sink.to(B.url).length, 1), 'U13.durable.B.sends').toBe(1)
    expect((await deliveryRows(A.webhookId)).length, 'U13.durable.A.rows').toBe(0)
    expect(thrown, 'U13.durable.throwsOnce').toBe(1)
  })

  test('U12 [D+tick] no event id or actor in the body; X-Webhook-Delivery is the delivery id on the first attempt and the retry', async () => {
    const w = await world('u12')
    const h = await hook(w, w.s0, 'u12', { maxRetries: 3 })
    const sink = createSink(500)
    const svc = new WebhookService(db, sink.fetchFn)
    const eventId = id(`evt_u12_${w.n}`)
    await svc.deliverEvent(
      'record.updated',
      { sheetId: w.s0, recordId: w.r0, changes: { [w.fPub0]: 'v' }, actorId: w.ownerId, _eventId: eventId },
      eventId,
    )
    await waitFor(() => sink.to(h.url).length, 1)
    const [row] = await deliveryRows(h.webhookId)
    await waitFor(() => 0, 1, 300) // let the failure handler store the backoff
    await q(`UPDATE multitable_webhook_deliveries SET next_retry_at = now() - interval '1 minute' WHERE id = $1`, [row?.id ?? null])
    sink.setStatus(200)
    await new WebhookService(db, sink.fetchFn).retryFailedDeliveries()
    await waitFor(() => sink.to(h.url).length, 2)
    const requests = sink.to(h.url)
    expect(requests.length, 'U12.requests').toBe(2)
    const first = parseBody(requests[0].body)
    expect(Object.keys(first), 'U12.noEventId').not.toContain('_eventId')
    expect(Object.keys(first), 'U12.noActorId').not.toContain('actorId')
    expect(requests[0].headers['X-Webhook-Delivery'], 'U12.header.first').toBe(row?.id)
    expect(requests[1].headers['X-Webhook-Delivery'], 'U12.header.retry').toBe(row?.id)
    expect(first.changes, 'U12.values').toEqual({ [w.fPub0]: 'v' })
  })

  // ── Tick-only (directly inserted due pending rows) ───────────────────────────────────────
  for (const shape of TICK_SHAPES) {
    const P = `[${shape}]`
    const pend = async (w: World, webhookId: string, label: string, payload: Record<string, unknown>, event = 'record.updated') => {
      const deliveryId = id(`del_${label}_${w.n}`)
      await insertDuePending(deliveryId, webhookId, event, payload, pendingEventIdFor(shape as TickShape, `${label}${w.n}`))
      return deliveryId
    }

    test(`M9 ${P} read revoked after the row was stored: not sent, failure_count unchanged, row failed`, async () => {
      refusals = captureRefusals()
      const w = await world('m9')
      const h = await hook(w, w.s1, 'm9')
      const before = await webhookRow(h.webhookId)
      const deliveryId = await pend(w, h.webhookId, 'm9', { sheetId: w.s1, recordId: w.rOk, changes: { [w.fPub]: 'x' } })
      await revokePermission(w.ownerId, 'multitable:read')
      const sink = await tickOnce()
      expect(sink.to(h.url).length, 'M9.sends').toBe(0)
      expect((await webhookRow(h.webhookId))?.failure_count, 'M9.failureCount').toBe(before?.failure_count)
      expect((await deliveryRow(deliveryId))?.status, 'M9.status').toBe('failed')
      expect(refusals.reasons(), 'M9.reason').toContain('sheet_not_readable')
    })

    test(`M9+ ${P} same stored row without the revoke: sent once`, async () => {
      const w = await world('m9p')
      const h = await hook(w, w.s1, 'm9p')
      await pend(w, h.webhookId, 'm9p', { sheetId: w.s1, recordId: w.rOk, changes: { [w.fPub]: 'x' } })
      const sink = await tickOnce()
      expect(sink.to(h.url).length, 'M9+.sends').toBe(1)
    })

    test(`M10 ${P} a field hidden after the row was stored is removed from the attempt`, async () => {
      const w = await world('m10')
      const h = await hook(w, w.s1, 'm10')
      await pend(w, h.webhookId, 'm10', { sheetId: w.s1, recordId: w.rOk, changes: { [w.fPub]: 'a', [w.fPub2]: 'b' } })
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,false,false)', [w.s1, w.fPub, 'user', w.ownerId])
      const sink = await tickOnce()
      expect(sink.to(h.url).length, 'M10.sends').toBe(1)
      const body = parseBody(sink.to(h.url)[0].body)
      expect(Object.keys(body.changes as object), 'M10.noFpub').not.toContain(w.fPub)
      expect(body.changes, 'M10.kept').toEqual({ [w.fPub2]: 'b' })
    })

    test(`M17r ${P} a rule-denied row removed after the row was stored: not sent, failed`, async () => {
      refusals = captureRefusals()
      const w = await world('m17r')
      const h = await hook(w, w.s1, 'm17r')
      const before = await webhookRow(h.webhookId)
      const deliveryId = await pend(w, h.webhookId, 'm17r', { sheetId: w.s1, recordId: w.rRule, changes: { [w.fPub]: 'x' } })
      await q('DELETE FROM meta_records WHERE id = $1', [w.rRule])
      const sink = await tickOnce()
      expect(sink.to(h.url).length, 'M17r.sends').toBe(0)
      expect((await deliveryRow(deliveryId))?.status, 'M17r.status').toBe('failed')
      expect((await webhookRow(h.webhookId))?.failure_count, 'M17r.failureCount').toBe(before?.failure_count)
      expect(refusals.reasons(), 'M17r.reason').toContain('record_not_live')
    })

    test(`M17r+ ${P} a stored row for a live readable record: sent once`, async () => {
      const w = await world('m17rp')
      const h = await hook(w, w.s1, 'm17rp')
      await pend(w, h.webhookId, 'm17rp', { sheetId: w.s1, recordId: w.rOk, changes: { [w.fPub]: 'x' } })
      const sink = await tickOnce()
      expect(sink.to(h.url).length, 'M17r+.sends').toBe(1)
    })

    test(`M21+ ${P} ops switch off: a due stored row is sent once by the tick`, async () => {
      const w = await world('m21pt')
      const h = await hook(w, w.s0, 'm21pt')
      await pend(w, h.webhookId, 'm21pt', { sheetId: w.s0, recordId: w.r0, changes: { [w.fPub0]: 'b' } })
      const sink = await tickOnce()
      expect(sink.to(h.url).length, 'M21+.sends').toBe(1)
    })

    test(`U14 ${P} a failed check before an attempt: not sent, attempt counted, rescheduled, failure_count unchanged; failed at max`, async () => {
      refusals = captureRefusals()
      const w = await world('u14')
      const h = await hook(w, w.s0, 'u14', { maxRetries: 3 })
      const before = await webhookRow(h.webhookId)
      const deliveryId = await pend(w, h.webhookId, 'u14', { sheetId: w.s0, recordId: w.r0 })
      hooks.failAccessOnceFor = new Set([w.ownerId])
      const startedAt = Date.now()
      const sink = await tickOnce()
      expect(sink.to(h.url).length, 'U14.sends').toBe(0)
      const afterWebhook = await webhookRow(h.webhookId)
      expect(afterWebhook?.failure_count, 'U14.failureCount').toBe(before?.failure_count)
      expect(afterWebhook?.active, 'U14.stillActive').toBe(true)
      const row = await deliveryRow(deliveryId)
      expect(Number(row?.attempt_count), 'U14.attempt').toBe(1)
      expect(row?.status, 'U14.pending').toBe('pending')
      expect(new Date(row?.next_retry_at).getTime(), 'U14.nextRetry').toBeGreaterThanOrEqual(startedAt)
      expect(refusals.reasons(), 'U14.reason').toContain('authority_check_failed')
      // Last allowed attempt fails the check too → the row is failed (no send).
      await q(`UPDATE multitable_webhook_deliveries SET attempt_count = 2, next_retry_at = now() - interval '1 minute' WHERE id = $1`, [deliveryId])
      hooks.failAccessOnceFor = new Set([w.ownerId])
      await tickOnce(sink)
      expect(sink.to(h.url).length, 'U14.sendsAtMax').toBe(0)
      expect((await deliveryRow(deliveryId))?.status, 'U14.failedAtMax').toBe('failed')
      expect((await webhookRow(h.webhookId))?.failure_count, 'U14.failureCountAtMax').toBe(before?.failure_count)
    })
  }

  // ── M20: delivery history (route) ───────────────────────────────────────────────────────
  async function historyFixture(label: string) {
    const w = await world(label)
    const h = await hook(w, w.s0, label)
    for (let i = 0; i < 2; i += 1) {
      await q(
        `INSERT INTO multitable_webhook_deliveries
           (id, webhook_id, event, payload, status, http_status, response_body, attempt_count, created_at, delivered_at)
         VALUES ($1, $2, 'record.updated', $3::jsonb, 'success', 200, 'accepted', 1, now(), now())`,
        [id(`hist_${label}_${i}_${w.n}`), h.webhookId, JSON.stringify({ sheetId: w.s2, recordId: w.r2, data: { [w.fS2]: 's' } })],
      )
    }
    authState.userId = w.ownerId
    return { w, h }
  }
  const history = (webhookId: string) => request(pinned.url()).get(`/api/multitable/webhooks/${webhookId}/deliveries`)

  test('M20.authorized history: 200, every stored row listed, no stored request/response bodies', async () => {
    const { h } = await historyFixture('m20a')
    const res = await history(h.webhookId)
    expect(res.status, 'M20.authorized.status').toBe(200)
    const items = res.body.data.deliveries as Array<Record<string, unknown>>
    expect(items.length, 'M20.authorized.count').toBe(2)
    for (const item of items) {
      expect(Object.keys(item), 'M20.authorized.no_payload').not.toContain('payload')
      expect(Object.keys(item), 'M20.authorized.no_responseBody').not.toContain('responseBody')
      expect(Object.keys(item), 'M20.authorized.no_response_body').not.toContain('response_body')
    }
  })

  test('M20.revoked history after the owner lost read on the bound sheet: 403', async () => {
    const { w, h } = await historyFixture('m20r')
    await revokePermission(w.ownerId, 'multitable:read')
    const res = await history(h.webhookId)
    expect(res.status, 'M20.revoked.status').toBe(403)
  })

  test('M20.deleted history after the bound sheet was deleted: 403', async () => {
    const { w, h } = await historyFixture('m20d')
    await q('UPDATE meta_sheets SET deleted_at = now() WHERE id = $1', [w.s0])
    const res = await history(h.webhookId)
    expect(res.status, 'M20.deleted.status').toBe(403)
  })
})
