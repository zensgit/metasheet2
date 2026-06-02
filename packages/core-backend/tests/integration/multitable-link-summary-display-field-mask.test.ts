/**
 * Real-DB integration test for the `buildLinkSummaries` foreign-display-value leak (a #2106 follow-up to F5).
 *
 * `buildLinkSummaries` derives each linked foreign record's `display` from the foreign sheet's default display
 * field and echoes it into `linkSummaries` / `selected`. `resolveReadableSheetIds` gates SHEET-level read, and
 * the `filter*FieldSummaryMap` wrappers drop summaries for *link fields* the caller cannot read — but NOTHING
 * masked the foreign `display` VALUE when the link field is readable yet the foreign sheet's display field is
 * `field_permissions.visible=false` for the caller. So the denied value leaked via every consumer:
 *   - GET /view                         (data.linkSummaries[recordId][fieldId][].display)
 *   - GET /records/:recordId            (data.linkSummaries[fieldId][].display)
 *   - GET /fields/:fieldId/link-options?recordId=  (data.selected[].display)
 * The fix picks the foreign display field only from THAT sheet's own layer-2 ∧ layer-3 allowed set (the
 * crossSheetRelated per-sheet-keying rule), so the read at `data[displayFieldId]` is inherently safe.
 *
 * This is the complement of records-read R6 (which denies the LINK field → the whole summary key drops):
 * here the link field is VISIBLE (the key survives) and only the foreign DISPLAY field is denied, so the
 * leak is the surviving summary's `display` value. Seed non-negotiable: the denied display field's property
 * carries no `hidden` → deny is solely layer-3.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_lsd_${TS}`
const SHEET_A = `sheet_lsd_src_${TS}` // source sheet holding the (readable) link field
const FLD_LINK = `fld_lsd_link_${TS}` // link field → SHEET_B; NOT denied (so the summary key survives)
const FLD_A_NOTE = `fld_lsd_anote_${TS}` // readable bystander field on SHEET_A — the write target for S4
const REC_A = `rec_lsd_a_${TS}` // source record linked to REC_B
const SHEET_B = `sheet_lsd_foreign_${TS}` // foreign sheet
const FLD_B_DISPLAY = `fld_lsd_bdisplay_${TS}` // foreign default display (string), DENIED to USER on SHEET_B
const REC_B = `rec_lsd_b_${TS}`
const USER_ID = `u_lsd_${TS}` // denied FLD_B_DISPLAY on SHEET_B
const USER_ID_2 = `u_lsd_other_${TS}` // no deny → positive control
const B_CANARY = `do-not-leak-lsd-${TS}`

let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const viewReq = () => request(app).get('/api/multitable/view').query({ sheetId: SHEET_A, includeLinkSummaries: 'true' })
const recordReq = () => request(app).get(`/api/multitable/records/${REC_A}`).query({ sheetId: SHEET_A })
const linkOptions = () => request(app).get(`/api/multitable/fields/${FLD_LINK}/link-options`).query({ recordId: REC_A })
const batchPatch = (body: Record<string, unknown>) => request(app).post('/api/multitable/patch').send(body)

describeIfDatabase('buildLinkSummaries foreign-display-value field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Link Summary Display Base'])
    // source sheet A + a readable link field → B, and a source record
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE_ID, 'LSD Source'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, SHEET_A, 'Linked', 'link', JSON.stringify({ foreignSheetId: SHEET_B }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_A_NOTE, SHEET_A, 'Note', 'string', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_A, SHEET_A, '{}'])
    // foreign sheet B: its only string field is the (denied-to-USER) default display
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE_ID, 'LSD Foreign'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_B_DISPLAY, SHEET_B, 'BName', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_B, SHEET_B, JSON.stringify({ [FLD_B_DISPLAY]: B_CANARY })])
    // link REC_A → REC_B
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_LINK, REC_A, REC_B])
    // layer-3 read deny on the FOREIGN display field, for USER only (NOT on the source link field)
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_B, FLD_B_DISPLAY, 'user', USER_ID, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_B]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('S1 (GET /view): the FOREIGN display value is masked in linkSummaries, but the (readable) link-field key survives', async () => {
    // positive control FIRST (defeats an empty-summary false-green): an ungranted-to-deny user DOES get B_CANARY
    testUserId = USER_ID_2
    const granted = await viewReq()
    expect(granted.status).toBe(200)
    expect(granted.body.data.linkSummaries?.[REC_A]?.[FLD_LINK]?.[0]?.display).toBe(B_CANARY)

    // the denied user: the link-field summary is STILL present (link field is readable) but its display is masked
    testUserId = USER_ID
    const denied = await viewReq()
    expect(denied.status).toBe(200)
    const summary = denied.body.data.linkSummaries?.[REC_A]?.[FLD_LINK]
    expect(summary?.[0]?.id).toBe(REC_B) // the summary key/entry survives (this is NOT the link-field-denied R6 case)
    expect(summary?.[0]?.display).not.toBe(B_CANARY) // THE LEAK (RED pre-fix): foreign display value
    expect(JSON.stringify(denied.body)).not.toContain(B_CANARY)
  })

  test('S2 (GET /records/:recordId): the FOREIGN display value is masked in the single-record linkSummaries', async () => {
    testUserId = USER_ID_2
    const granted = await recordReq()
    expect(granted.status).toBe(200)
    expect(granted.body.data.linkSummaries?.[FLD_LINK]?.[0]?.display).toBe(B_CANARY)

    testUserId = USER_ID
    const denied = await recordReq()
    expect(denied.status).toBe(200)
    const summary = denied.body.data.linkSummaries?.[FLD_LINK]
    expect(summary?.[0]?.id).toBe(REC_B)
    expect(summary?.[0]?.display).not.toBe(B_CANARY) // THE LEAK (RED pre-fix)
    expect(JSON.stringify(denied.body)).not.toContain(B_CANARY)
  })

  test('S3 (GET /fields/:fieldId/link-options?recordId=): the FOREIGN display value is masked in data.selected', async () => {
    testUserId = USER_ID_2
    const granted = await linkOptions()
    expect(granted.status).toBe(200)
    expect(granted.body.data.selected.find((r: { id: string }) => r.id === REC_B)?.display).toBe(B_CANARY)

    testUserId = USER_ID
    const denied = await linkOptions()
    expect(denied.status).toBe(200)
    const sel = denied.body.data.selected.find((r: { id: string }) => r.id === REC_B)
    expect(sel).toBeDefined() // the linked record is still listed in `selected`
    expect(sel.display).not.toBe(B_CANARY) // THE LEAK (RED pre-fix)
    expect(JSON.stringify(denied.body)).not.toContain(B_CANARY)
  })

  test('S4 (POST /patch write-echo): the FOREIGN display value is masked in the linkSummaries echo of a patched record', async () => {
    // RecordWriteService rebuilds linkSummaries for the updated record (→ buildLinkSummaries) whenever the sheet
    // has a link field and a row is updated. Edit a readable BYSTANDER field so updates.length>0 triggers the
    // echo; the link itself is untouched. (PATCH /records/:id echoes link IDs, not summaries — POST /patch is
    // the linkSummaries write surface.)
    testPerms = ['multitable:read', 'multitable:write']
    testUserId = USER_ID_2
    const granted = await batchPatch({ sheetId: SHEET_A, changes: [{ recordId: REC_A, fieldId: FLD_A_NOTE, value: 'granted-edit' }] })
    expect(granted.status).toBe(200)
    expect(granted.body.data.linkSummaries?.[REC_A]?.[FLD_LINK]?.[0]?.display).toBe(B_CANARY)

    testUserId = USER_ID
    const denied = await batchPatch({ sheetId: SHEET_A, changes: [{ recordId: REC_A, fieldId: FLD_A_NOTE, value: 'denied-edit' }] })
    expect(denied.status).toBe(200)
    const summary = denied.body.data.linkSummaries?.[REC_A]?.[FLD_LINK]
    expect(summary?.[0]?.id).toBe(REC_B) // the (readable) link-field summary survives in the echo
    expect(summary?.[0]?.display).not.toBe(B_CANARY) // THE LEAK (RED pre-fix)
    expect(JSON.stringify(denied.body)).not.toContain(B_CANARY)
    testPerms = ['multitable:read']
  })
})
