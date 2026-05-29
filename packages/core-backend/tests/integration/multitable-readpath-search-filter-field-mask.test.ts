/**
 * Real-DB integration test for the read-path search/filter/sort field-mask (priority-#2 (a), design
 * docs/development/multitable-readpath-search-filter-field-mask-design-20260529.md, #2038).
 *
 * After #2015 gated returned DATA by layer-3 (field_permissions.visible), the SEARCH/FILTER/SORT field
 * SELECTION on GET /view and GET .../view-aggregate still ran on the static layer-2 set — so a denied
 * field stayed searchable-by-value, filterable, and sortable. This locks the layer-3-only selection fix.
 *
 * Fail-first (design §6 #2): R1–R6 demonstrated RED on origin/main (pre-fix), GREEN after. R7/R8/R9 are
 * controls/regression-guards (green pre+post). Seed non-negotiables: FLD_SECRET denied SOLELY via layer-3
 * (property.hidden UNSET); the search canary is UNIQUE to FLD_SECRET + a visible-field positive control;
 * R5/R6 assert a NON-ZERO data.total (no empty==empty vacuous pass); FLD_VIEWHIDDEN is layer-3-visible but
 * layer-1 (view.hidden_field_ids) hidden (R9 pins layer-1 ≠ selection gate).
 *
 * Runs only with DATABASE_URL (describeIfDatabase + sentinel → fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_rps_${TS}`
const SHEET_ID = `sheet_rps_${TS}`
const FLD_VISIBLE = `fld_rps_visible_${TS}` // never denied — searchable/filterable positive control
const FLD_SECRET = `fld_rps_secret_${TS}` // denied to USER_ID via field_permissions.visible=false (layer-3 only)
const FLD_VIEWHIDDEN = `fld_rps_viewhidden_${TS}` // layer-3 visible, but layer-1 hidden in VIEW_VH (R9)
// IDs sort in insertion order (_1.._4) so /view's default `created_at ASC, id ASC` order is deterministic (R4).
const REC1 = `rec_rps_1_${TS}`, REC2 = `rec_rps_2_${TS}`, REC3 = `rec_rps_3_${TS}`, REC4 = `rec_rps_4_${TS}`
const VIEW_SORT_VISIBLE = `view_rps_sortvis_${TS}` // benign sort → forces /view in-memory search path (R2)
const VIEW_FILTER_SECRET = `view_rps_filtsec_${TS}` // filter [VISIBLE=sharedterm AND SECRET=secretval1] (R3/R6/R7)
const VIEW_SORT_SECRET = `view_rps_sortsec_${TS}` // sort by FLD_SECRET (R4)
const VIEW_VH = `view_rps_vh_${TS}` // hidden_field_ids=[FLD_VIEWHIDDEN] (R9)
const USER_ID = `u_rps_${TS}` // FLD_SECRET denied
const USER_ID_2 = `u_rps_other_${TS}` // no deny → R8 control
const SHARED = 'sharedterm' // in FLD_VISIBLE on REC1/REC2 AND FLD_SECRET on REC3
const SECRET_CANARY = 'do-not-leak-canary' // UNIQUE to FLD_SECRET (REC4) — the search probe
const VH_TERM = 'viewhidden-only-term' // UNIQUE to FLD_VIEWHIDDEN (REC4) — R9 probe

let app: Express
let testUserId: string = USER_ID
let testPerms: string[] = ['multitable:read']
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const viewReq = (query: Record<string, string>) => request(app).get('/api/multitable/view').query(query)
const aggReq = (query: Record<string, string>) => request(app).get(`/api/multitable/sheets/${SHEET_ID}/view-aggregate`).query(query)
const rowIds = (res: { body: { data?: { rows?: Array<{ id: string }> } } }) => (res.body.data?.rows ?? []).map((r) => r.id)

describeIfDatabase('multitable read-path search/filter/sort field mask (#2038, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'RPS Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'RPS Sheet'])
    // All 'string' (searchable) + property {} → property.hidden UNSET (deny must be solely layer-3).
    for (const [fid, name, order] of [[FLD_VISIBLE, 'Visible', 1], [FLD_SECRET, 'Secret', 2], [FLD_VIEWHIDDEN, 'ViewHidden', 3]] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET_ID, name, 'string', '{}', order])
    }
    // Records (inserted in id order → deterministic default order REC1..REC4). SHARED lives in a VISIBLE field
    // on REC1/REC2 but in the DENIED field on REC3; the canary lives ONLY in the denied field on REC4.
    const recs: Array<[string, Record<string, string>]> = [
      [REC1, { [FLD_VISIBLE]: SHARED, [FLD_SECRET]: 'secretval1', [FLD_VIEWHIDDEN]: 'vh1' }],
      [REC2, { [FLD_VISIBLE]: SHARED, [FLD_SECRET]: 'secretval2', [FLD_VIEWHIDDEN]: 'vh2' }],
      [REC3, { [FLD_VISIBLE]: 'plain3', [FLD_SECRET]: SHARED, [FLD_VIEWHIDDEN]: 'vh3' }],
      [REC4, { [FLD_VISIBLE]: 'plain4', [FLD_SECRET]: SECRET_CANARY, [FLD_VIEWHIDDEN]: VH_TERM }],
    ]
    for (const [rid, data] of recs) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid, SHEET_ID, JSON.stringify(data)])
    }
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID, false, false])

    const view = (id: string, extra: Record<string, unknown>) =>
      q('INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, hidden_field_ids) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
        [id, SHEET_ID, id, 'grid', JSON.stringify(extra.filter_info ?? null), JSON.stringify(extra.sort_info ?? null), JSON.stringify(extra.hidden_field_ids ?? [])])
    await view(VIEW_SORT_VISIBLE, { sort_info: { rules: [{ fieldId: FLD_VISIBLE, desc: false }] } })
    await view(VIEW_FILTER_SECRET, { filter_info: { conjunction: 'and', conditions: [{ fieldId: FLD_VISIBLE, operator: 'is', value: SHARED }, { fieldId: FLD_SECRET, operator: 'is', value: 'secretval1' }] } })
    await view(VIEW_SORT_SECRET, { sort_info: { rules: [{ fieldId: FLD_SECRET, desc: false }] } })
    await view(VIEW_VH, { hidden_field_ids: [FLD_VIEWHIDDEN] })
  })

  afterAll(async () => {
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R1 (required): GET /view search SQL fast-path — denied field NOT searchable (canary never matches/leaks)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const res = await viewReq({ sheetId: SHEET_ID, search: SECRET_CANARY }) // no view → fast-path
    expect(res.status).toBe(200)
    expect(rowIds(res)).not.toContain(REC4) // pre-fix: REC4 matched via FLD_SECRET=canary
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
    // positive control: search still works on a VISIBLE field (proves "denied not searched", not "search broken")
    const ok = await viewReq({ sheetId: SHEET_ID, search: SHARED })
    expect(rowIds(ok)).toEqual(expect.arrayContaining([REC1, REC2]))
  })

  test('R2 (required): GET /view search IN-MEMORY path (search + benign sort) — the other search path is also gated', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const res = await viewReq({ sheetId: SHEET_ID, viewId: VIEW_SORT_VISIBLE, search: SECRET_CANARY }) // sort → in-memory path
    expect(res.status).toBe(200)
    expect(rowIds(res)).not.toContain(REC4)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
  })

  test('R3: GET /view saved filter on a denied field is DROPPED (row set not narrowed by the denied value)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const res = await viewReq({ sheetId: SHEET_ID, viewId: VIEW_FILTER_SECRET })
    expect(res.status).toBe(200)
    // post-fix: only FLD_VISIBLE='sharedterm' applies → REC1+REC2 (pre-fix: +SECRET='secretval1' → REC1 only)
    expect(rowIds(res).sort()).toEqual([REC1, REC2].sort())
  })

  test('R4: GET /view saved sort on a denied field is DROPPED (order not determined by the denied field)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const res = await viewReq({ sheetId: SHEET_ID, viewId: VIEW_SORT_SECRET })
    expect(res.status).toBe(200)
    // FLD_SECRET asc would put REC4 (canary) first; dropped → default created_at/id order → REC1 first.
    expect(rowIds(res)[0]).toBe(REC1)
  })

  test('R5 (required): view-aggregate search — denied field not searched (total unchanged, asserted non-zero)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const res = await aggReq({ search: SHARED }) // SHARED: VISIBLE on REC1/REC2, DENIED on REC3
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(2) // post-fix: only the 2 visible matches (pre-fix: 3, incl REC3 via denied)
  })

  test('R6 (required): view-aggregate saved denied filter DROPPED (total unchanged, asserted non-zero)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const res = await aggReq({ viewId: VIEW_FILTER_SECRET })
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(2) // post-fix: VISIBLE='sharedterm' only → 2 (pre-fix: +denied SECRET → 1)
  })

  test('R7: /view ↔ view-aggregate filtered-SET parity under a denied filter (counts agree)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const v = await viewReq({ sheetId: SHEET_ID, viewId: VIEW_FILTER_SECRET })
    const a = await aggReq({ viewId: VIEW_FILTER_SECRET })
    expect(v.status).toBe(200); expect(a.status).toBe(200)
    expect(rowIds(v).length).toBe(a.body.data.total) // the :5926-5929 invariant, post-fix
  })

  test('R8: non-over-restriction — visible field stays searchable; an ungranted-to-deny user CAN search the field', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    expect(rowIds(await viewReq({ sheetId: SHEET_ID, search: SHARED }))).toEqual(expect.arrayContaining([REC1, REC2]))
    testUserId = USER_ID_2 // no field_permissions deny row for this subject
    const ung = await viewReq({ sheetId: SHEET_ID, search: SECRET_CANARY })
    expect(ung.status).toBe(200)
    expect(rowIds(ung)).toContain(REC4) // FLD_SECRET searchable for the ungranted user (per-subject)
    testUserId = USER_ID
  })

  test('R9: layer-1 ≠ selection gate — a readable-but-view-hidden field stays searchable on BOTH endpoints (counts agree)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    // FLD_VIEWHIDDEN is in VIEW_VH.hidden_field_ids (layer-1) but NOT field_permissions-denied (layer-3 visible).
    // It must stay searchable on both endpoints (layer-1 is display-only). RED if impl gates aggregate
    // selection by the layer-1∧layer-3 output set (which would drop FLD_VIEWHIDDEN on aggregate only).
    const v = await viewReq({ sheetId: SHEET_ID, viewId: VIEW_VH, search: VH_TERM })
    const a = await aggReq({ viewId: VIEW_VH, search: VH_TERM })
    expect(v.status).toBe(200); expect(a.status).toBe(200)
    expect(rowIds(v)).toContain(REC4) // /view still searches the view-hidden (but readable) field
    expect(a.body.data.total).toBe(rowIds(v).length) // and view-aggregate agrees (both see REC4)
    expect(a.body.data.total).toBe(1)
  })
})
