/**
 * Real-DB integration test for the view-config re-save guard (#2068 design-lock, impl).
 *
 * #2059 redacts saved-view filter literals on read (omits filterInfo.conditions[].value for fields the
 * requester can't read). Write-path edge: a field-denied canManageViews user who re-saves a view echoes
 * the redacted condition back WITHOUT a value → PATCH /views/:viewId would overwrite meta_views.filter_info
 * and silently ERASE the literal they were never allowed to see. This guard preserves the existing DB
 * literal when a redacted echo (denied field, NO `value` key) is re-saved.
 *
 * Fail-first (design §5): R1/R6 must be RED on unmodified main (DB literal erased after PATCH). Assertions
 * read meta_views.filter_info DIRECTLY (the response is redacted either way — advisor #2). Seed non-negotiable:
 * FLD_SECRET denied SOLELY via layer-3 (property.hidden UNSET). PATCH conditions mirror the seeded order
 * (the guard matches by array-index + (fieldId, operator); reorder → intentional 400, R5).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_rsg_${TS}`
const SHEET_ID = `sheet_rsg_${TS}`
const FLD_VISIBLE = `fld_rsg_visible_${TS}`
const FLD_SECRET = `fld_rsg_secret_${TS}` // layer-3 denied (property.hidden UNSET)
const FLD_STATIC_HIDDEN = `fld_rsg_statichidden_${TS}` // layer-2 property.hidden=true
const FLD_VIEWHIDDEN = `fld_rsg_viewhidden_${TS}` // layer-1: in hidden_field_ids, readable
const VIEW_ID = `view_rsg_${TS}`
const USER_ID = `u_rsg_${TS}` // canManageViews + FLD_SECRET denied
const USER_ID_2 = `u_rsg_other_${TS}` // no deny (R8 allowed reader)
const VIS_LIT = 'visible-literal'
const SECRET_LIT = 'secret-literal-do-not-erase'
const STATIC_LIT = 'statichidden-literal-do-not-erase'
const VH_LIT = 'viewhidden-literal'

// the seeded view's filter, in canonical order — the PATCH echoes mirror this order.
const SEED_CONDITIONS = [
  { fieldId: FLD_VISIBLE, operator: 'is', value: VIS_LIT },
  { fieldId: FLD_SECRET, operator: 'is', value: SECRET_LIT },
  { fieldId: FLD_STATIC_HIDDEN, operator: 'is', value: STATIC_LIT },
  { fieldId: FLD_VIEWHIDDEN, operator: 'is', value: VH_LIT },
]

let app: Express
let testUserId: string = USER_ID
let testPerms: string[] = ['multitable:read', 'multitable:write'] // write → canManageViews
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const patch = (b: unknown) => request(app).patch(`/api/multitable/views/${VIEW_ID}`).send(b as object)
const dbFilterInfo = async (): Promise<{ conditions?: Array<Record<string, unknown>> }> => {
  const r = await q('SELECT filter_info FROM meta_views WHERE id = $1', [VIEW_ID])
  const fi = (r.rows[0] as { filter_info?: unknown })?.filter_info
  return (typeof fi === 'string' ? JSON.parse(fi) : fi) as { conditions?: Array<Record<string, unknown>> }
}
const valueOf = (fi: { conditions?: Array<Record<string, unknown>> }, fieldId: string) =>
  fi.conditions?.find((c) => c.fieldId === fieldId)?.value

async function seedView() {
  await q('INSERT INTO meta_views (id, sheet_id, name, type, filter_info, hidden_field_ids) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
    [VIEW_ID, SHEET_ID, 'RSG View', 'grid', JSON.stringify({ conjunction: 'and', conditions: SEED_CONDITIONS }), JSON.stringify([FLD_VIEWHIDDEN])])
}

describeIfDatabase('multitable view-config re-save guard (#2068, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'RSG Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'RSG Sheet'])
    for (const [fid, name, order, prop] of [
      [FLD_VISIBLE, 'Visible', 1, '{}'], [FLD_SECRET, 'Secret', 2, '{}'],
      [FLD_STATIC_HIDDEN, 'StaticHidden', 3, '{"hidden":true}'], [FLD_VIEWHIDDEN, 'ViewHidden', 4, '{}'],
    ] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET_ID, name, 'string', prop, order])
    }
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  // each test starts from the canonical seeded view
  beforeEach(async () => { testUserId = USER_ID; testPerms = ['multitable:read', 'multitable:write']; await q('DELETE FROM meta_views WHERE id = $1', [VIEW_ID]); await seedView() })

  // a redacted echo of the seeded conditions: omit `value` for denied fields (FLD_SECRET / FLD_STATIC_HIDDEN)
  const redactedEcho = () => SEED_CONDITIONS.map((c) => (c.fieldId === FLD_SECRET || c.fieldId === FLD_STATIC_HIDDEN) ? { fieldId: c.fieldId, operator: c.operator } : { ...c })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R1 (req, fail-first): re-saving a redacted denied condition PRESERVES the DB literal (no-op title edit)', async () => {
    const res = await patch({ name: 'RSG Renamed', filterInfo: { conjunction: 'and', conditions: redactedEcho() } })
    expect(res.status).toBe(200)
    expect(valueOf(await dbFilterInfo(), FLD_SECRET)).toBe(SECRET_LIT) // DB literal preserved (RED on unmodified: erased)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_LIT) // response still redacts it
  })

  test('R2: an allowed field condition updates its value normally', async () => {
    const conds = redactedEcho().map((c) => c.fieldId === FLD_VISIBLE ? { ...c, value: 'visible-updated' } : c)
    expect((await patch({ filterInfo: { conjunction: 'and', conditions: conds } })).status).toBe(200)
    expect(valueOf(await dbFilterInfo(), FLD_VISIBLE)).toBe('visible-updated')
    expect(valueOf(await dbFilterInfo(), FLD_SECRET)).toBe(SECRET_LIT) // denied still preserved
  })

  test('R3: an explicit value for a denied field is written (existing canManageViews behavior, not a new policy)', async () => {
    const conds = redactedEcho().map((c) => c.fieldId === FLD_SECRET ? { fieldId: c.fieldId, operator: c.operator, value: 'secret-rewritten' } : c)
    const res = await patch({ filterInfo: { conjunction: 'and', conditions: conds } })
    expect(res.status).toBe(200)
    expect(valueOf(await dbFilterInfo(), FLD_SECRET)).toBe('secret-rewritten') // explicit write trusted
    expect(JSON.stringify(res.body)).not.toContain('secret-rewritten') // response redacts the denied field
  })

  test('R4: a removed denied condition stays removed (guard does not resurrect it)', async () => {
    // prune to the allowed condition only — FLD_SECRET (+ the other denied conds) dropped from the incoming list.
    // (removing FLD_SECRET while keeping a later still-redacted condition would shift indices → intentional 400, R5.)
    const conds = [{ fieldId: FLD_VISIBLE, operator: 'is', value: VIS_LIT }]
    expect((await patch({ filterInfo: { conjunction: 'and', conditions: conds } })).status).toBe(200)
    const fi = await dbFilterInfo()
    expect(fi.conditions?.some((c) => c.fieldId === FLD_SECRET)).toBe(false) // removed, NOT resurrected by the guard
  })

  test('R5: a redacted denied condition that no longer matches same-index → 400, DB unchanged', async () => {
    // drop FLD_VISIBLE so the denied FLD_SECRET echo lands at index 0, where current has FLD_VISIBLE (mismatch)
    const conds = redactedEcho().filter((c) => c.fieldId !== FLD_VISIBLE)
    const res = await patch({ filterInfo: { conjunction: 'and', conditions: conds } })
    expect(res.status).toBe(400)
    expect(valueOf(await dbFilterInfo(), FLD_SECRET)).toBe(SECRET_LIT) // DB untouched on reject
  })

  test('R6 (req, fail-first): re-saving a redacted property.hidden (layer-2) condition PRESERVES its literal', async () => {
    expect((await patch({ name: 'RSG R6', filterInfo: { conjunction: 'and', conditions: redactedEcho() } })).status).toBe(200)
    expect(valueOf(await dbFilterInfo(), FLD_STATIC_HIDDEN)).toBe(STATIC_LIT) // layer-2 preserved (RED on unmodified)
  })

  test('R7: a readable-but-view-hidden (layer-1) field writes normally — no preservation trigger', async () => {
    const conds = redactedEcho().map((c) => c.fieldId === FLD_VIEWHIDDEN ? { ...c, value: 'viewhidden-updated' } : c)
    expect((await patch({ filterInfo: { conjunction: 'and', conditions: conds } })).status).toBe(200)
    expect(valueOf(await dbFilterInfo(), FLD_VIEWHIDDEN)).toBe('viewhidden-updated') // layer-1 is readable → normal write
  })

  test('R8: after a preserved update, a fully-allowed reader sees the literal; the denied writer\'s response omitted it', async () => {
    const writerRes = await patch({ name: 'RSG R8', filterInfo: { conjunction: 'and', conditions: redactedEcho() } })
    expect(JSON.stringify(writerRes.body)).not.toContain(SECRET_LIT) // denied writer's immediate response: redacted
    testUserId = USER_ID_2; testPerms = ['multitable:read'] // allowed reader (no deny row)
    const readerRes = await request(app).get('/api/multitable/view').query({ sheetId: SHEET_ID, viewId: VIEW_ID })
    expect(readerRes.status).toBe(200)
    expect(JSON.stringify(readerRes.body)).toContain(SECRET_LIT) // allowed reader sees the preserved literal (cache held unredacted)
  })

  test('R9: a unary denied condition (no value, e.g. isNotEmpty) re-saves without rejection or a manufactured value', async () => {
    // seed FLD_SECRET as a unary condition (no value), then re-save the redacted echo (also no value)
    await q('DELETE FROM meta_views WHERE id = $1', [VIEW_ID])
    const unarySeed = [{ fieldId: FLD_VISIBLE, operator: 'is', value: VIS_LIT }, { fieldId: FLD_SECRET, operator: 'isNotEmpty' }]
    await q('INSERT INTO meta_views (id, sheet_id, name, type, filter_info, hidden_field_ids) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
      [VIEW_ID, SHEET_ID, 'RSG U', 'grid', JSON.stringify({ conjunction: 'and', conditions: unarySeed }), JSON.stringify([])])
    const res = await patch({ name: 'RSG U2', filterInfo: { conjunction: 'and', conditions: [{ fieldId: FLD_VISIBLE, operator: 'is', value: VIS_LIT }, { fieldId: FLD_SECRET, operator: 'isNotEmpty' }] } })
    expect(res.status).toBe(200) // not rejected
    const fi = await dbFilterInfo()
    const secretCond = fi.conditions?.find((c) => c.fieldId === FLD_SECRET)
    expect(secretCond).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(secretCond ?? {}, 'value')).toBe(false) // no manufactured value
  })

  test('R10: a malformed condition (null) → 400 VALIDATION_ERROR, DB unchanged (never a 500)', async () => {
    // z.record(z.unknown()) lets a client send conditions: [..., null]; the guard must reject, not throw.
    const res = await patch({ filterInfo: { conjunction: 'and', conditions: [{ fieldId: FLD_VISIBLE, operator: 'is', value: VIS_LIT }, null] } })
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('VALIDATION_ERROR')
    expect(valueOf(await dbFilterInfo(), FLD_SECRET)).toBe(SECRET_LIT) // DB untouched on reject
  })
})
