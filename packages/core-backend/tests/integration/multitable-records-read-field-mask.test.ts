/**
 * Real-DB integration test for the interactive read-path field mask (#2015, design-lock
 * docs/development/multitable-records-read-field-mask-design-20260529.md, scope B / value-only).
 *
 * Proves that `GET /view` and `GET /records/:recordId` honor the subject-scoped layer-3 read gate
 * (field_permissions.visible=false), not only static layer-2 (property.hidden). Before the fix these
 * paths masked row/record data by layer-2 only and shipped a field_permissions-denied value inside
 * the JSON payload, relying on the client to hide it from the returned fieldPermissions metadata.
 *
 * Fail-first discipline (design §5, non-negotiable #2): R1/R2 were demonstrated RED against the
 * unmodified origin/main route code (the denied canary present in the response body) and GREEN after
 * the mask swap. Each of R1/R2 folds in a POSITIVE control (the record is present with its visible
 * value) so an empty/dropped response can never false-green the "canary absent" assertion.
 *
 * Seed non-negotiable (design §5 #1): FLD_SECRET.property is `{}` — property.hidden is UNSET — so the
 * deny comes SOLELY from layer-3 field_permissions. If it were also static-hidden, layer-2
 * (filterVisiblePropertyFields) would already mask it on origin/main and R1/R2 would prove nothing.
 *
 * Runs only with DATABASE_URL (describeIfDatabase + a sentinel test so it fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
// IDs are namespaced (`*_mask_*_${TS}`) so they can never collide with a sibling integration test's
// fixtures in the shared real-DB run — meta_fields.id / meta_records.id are global PKs (TS alone is
// not collision-safe; multitable-view-aggregate.test.ts and -formula-dryrun.test.ts share the DB).
const BASE_ID = `base_mask_${TS}`
const SHEET_ID = `sheet_mask_${TS}`
const FLD_VISIBLE = `fld_mask_visible_${TS}` // never denied — the positive control
const FLD_SECRET = `fld_mask_secret_${TS}` // denied to USER_ID via field_permissions.visible=false (layer-3 only)
const FLD_VIEWHIDDEN = `fld_mask_viewhidden_${TS}` // layer-1 only (in view.hidden_field_ids) — value must STAY (display-only)
const FLD_LINK = `fld_mask_link_${TS}` // link field denied to USER_ID — its summary must be masked too
const REC_ID = `rec_mask_${TS}`
const VIEW_ID = `view_mask_${TS}` // a view whose hidden_field_ids = [FLD_VIEWHIDDEN] (the layer-1 control)
const FSHEET_ID = `sheet_mask_foreign_${TS}` // link target sheet
const FPRIM = `fld_mask_foreign_prim_${TS}` // foreign display field (type 'string' → chosen by the summary builder)
const FREC_ID = `rec_mask_foreign_${TS}` // foreign record linked from REC_ID via FLD_LINK
const USER_ID = `u_mask_${TS}` // FLD_SECRET + FLD_LINK denied to this subject
const USER_ID_2 = `u_mask_other_${TS}` // NO deny row → must still see FLD_SECRET / the link summary (per-subject, grant-additive)
const VISIBLE_VALUE = 10
const VIEWHIDDEN_VALUE = 77
const SECRET_CANARY = 'do-not-leak-canary' // proves a field_permissions-denied value never reaches the wire
const LINK_CANARY = 'do-not-leak-link-canary' // the foreign record's display value — must not leak via a denied field's summary

let app: Express
let testUserId: string = USER_ID // mutable: a test can drop the user (401) or swap to the ungranted user
let testPerms: string[] = ['multitable:read']
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const viewReq = (query: Record<string, string>) => request(app).get('/api/multitable/view').query(query)
const recordReq = (recordId: string, query: Record<string, string>) =>
  request(app).get(`/api/multitable/records/${recordId}`).query(query)

describeIfDatabase('multitable interactive read-path field mask (#2015, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'Mask Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'Mask Sheet'])
    // All fields property `{}` → property.hidden UNSET. The deny must come solely from layer-3 (below).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VISIBLE, SHEET_ID, 'Visible', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'number', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VIEWHIDDEN, SHEET_ID, 'ViewHidden', 'number', '{}', 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, SHEET_ID, 'Linked', 'link', JSON.stringify({ foreignSheetId: FSHEET_ID }), 4])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify({ [FLD_VISIBLE]: VISIBLE_VALUE, [FLD_SECRET]: SECRET_CANARY, [FLD_VIEWHIDDEN]: VIEWHIDDEN_VALUE })])
    // The real D3c field-read deny gate: subject-scoped, layer-3. USER_ID_2 gets NO row (R5 / R6 control).
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID, false, false])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_LINK, 'user', USER_ID, false, false])
    // R4 layer-1 control: a view whose hidden_field_ids = [FLD_VIEWHIDDEN] (display-only, NOT a data drop).
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids) VALUES ($1,$2,$3,$4,$5::jsonb)', [VIEW_ID, SHEET_ID, 'Mask View', 'grid', JSON.stringify([FLD_VIEWHIDDEN])])
    // R6 link-summary fixtures: foreign sheet + a 'string' display field carrying LINK_CANARY + a link row.
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FSHEET_ID, BASE_ID, 'Mask Foreign Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FPRIM, FSHEET_ID, 'ForeignName', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FREC_ID, FSHEET_ID, JSON.stringify({ [FPRIM]: LINK_CANARY })])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_LINK, REC_ID, FREC_ID])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FSHEET_ID]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FSHEET_ID]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_ID, FSHEET_ID]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R1 (required): GET /view omits a field_permissions-denied value from rows[].data (canary never on the wire)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const res = await viewReq({ sheetId: SHEET_ID })
    expect(res.status).toBe(200)
    const row = res.body.data.rows.find((r: { id: string }) => r.id === REC_ID)
    // positive control: the record is present with its visible value (defeats an empty-response false-green)
    expect(row).toBeDefined()
    expect(row.data[FLD_VISIBLE]).toBe(VISIBLE_VALUE)
    // metadata intact: the deny is still reported to the client (computed regardless of the data-mask fix → GREEN even pre-fix)
    expect(res.body.data.meta.permissions.fieldPermissions[FLD_SECRET].visible).toBe(false)
    // THE LEAK (RED pre-fix, GREEN post-fix): the denied value is gone from data AND from anywhere in the body
    expect(row.data[FLD_SECRET]).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
  })

  test('R2 (required): GET /records/:recordId omits a field_permissions-denied value from record.data (canary never on the wire)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const res = await recordReq(REC_ID, { sheetId: SHEET_ID })
    expect(res.status).toBe(200)
    // positive control
    expect(res.body.data.record.data[FLD_VISIBLE]).toBe(VISIBLE_VALUE)
    // metadata intact (GREEN pre-fix too)
    expect(res.body.data.fieldPermissions[FLD_SECRET].visible).toBe(false)
    // THE LEAK (RED pre-fix, GREEN post-fix)
    expect(res.body.data.record.data[FLD_SECRET]).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
  })

  test('R3: the mask does not over-strip — a non-denied field value is present on both paths', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const view = await viewReq({ sheetId: SHEET_ID })
    expect(view.body.data.rows.find((r: { id: string }) => r.id === REC_ID).data[FLD_VISIBLE]).toBe(VISIBLE_VALUE)
    const record = await recordReq(REC_ID, { sheetId: SHEET_ID })
    expect(record.body.data.record.data[FLD_VISIBLE]).toBe(VISIBLE_VALUE)
  })

  test('R4: layer-1 (view.hidden_field_ids) is NOT a data drop — the value STAYS, only the metadata hides it', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    // Pins the §2 non-goal: layer-1 stays a display concern on the interactive reads (client toggles the
    // column via fieldPermissions metadata without a round-trip). Only layer-3 (field_permissions) drops data.
    const view = await viewReq({ viewId: VIEW_ID })
    expect(view.status).toBe(200)
    const row = view.body.data.rows.find((r: { id: string }) => r.id === REC_ID)
    expect(row.data[FLD_VIEWHIDDEN]).toBe(VIEWHIDDEN_VALUE) // value present in data (NOT security-dropped)
    expect(view.body.data.meta.permissions.fieldPermissions[FLD_VIEWHIDDEN].visible).toBe(false) // hidden via metadata
    expect(row.data[FLD_SECRET]).toBeUndefined() // FLD_SECRET still layer-3-denied even on the view path

    const record = await recordReq(REC_ID, { viewId: VIEW_ID })
    expect(record.status).toBe(200)
    expect(record.body.data.record.data[FLD_VIEWHIDDEN]).toBe(VIEWHIDDEN_VALUE)
    expect(record.body.data.fieldPermissions[FLD_VIEWHIDDEN].visible).toBe(false)
  })

  test('R6: a denied field\'s link SUMMARY is masked too (not just row.data) — foreign display value never leaks', async () => {
    // Positive control FIRST (defeats an empty-summary false-green): the ungranted user DOES receive the
    // link summary carrying LINK_CANARY, proving the fixtures actually produce a summary.
    testUserId = USER_ID_2; testPerms = ['multitable:read']
    const granted = await viewReq({ sheetId: SHEET_ID, includeLinkSummaries: 'true' })
    expect(granted.status).toBe(200)
    expect(granted.body.data.linkSummaries?.[REC_ID]?.[FLD_LINK]).toBeDefined()
    expect(JSON.stringify(granted.body)).toContain(LINK_CANARY)

    // The denied user: the link field's summary key is gone, and LINK_CANARY is nowhere in the body.
    testUserId = USER_ID; testPerms = ['multitable:read']
    const denied = await viewReq({ sheetId: SHEET_ID, includeLinkSummaries: 'true' })
    expect(denied.status).toBe(200)
    expect(denied.body.data.linkSummaries?.[REC_ID]?.[FLD_LINK]).toBeUndefined()
    expect(JSON.stringify(denied.body)).not.toContain(LINK_CANARY)
  })

  test('R5: an ungranted-to-deny user still sees the value (per-subject; the mask does not deny the wrong user)', async () => {
    testUserId = USER_ID_2; testPerms = ['multitable:read'] // no field_permissions deny row for this subject
    const view = await viewReq({ sheetId: SHEET_ID })
    expect(view.status).toBe(200)
    expect(view.body.data.rows.find((r: { id: string }) => r.id === REC_ID).data[FLD_SECRET]).toBe(SECRET_CANARY)
    const record = await recordReq(REC_ID, { sheetId: SHEET_ID })
    expect(record.status).toBe(200)
    expect(record.body.data.record.data[FLD_SECRET]).toBe(SECRET_CANARY)
    testUserId = USER_ID
  })

  test('R7: unauthenticated → 401 on both paths (the mask never runs on an empty fieldScopeMap)', async () => {
    testUserId = ''; testPerms = ['multitable:read'] // no user object on the request
    expect((await viewReq({ sheetId: SHEET_ID })).status).toBe(401)
    expect((await recordReq(REC_ID, { sheetId: SHEET_ID })).status).toBe(401)
    testUserId = USER_ID
  })
})
