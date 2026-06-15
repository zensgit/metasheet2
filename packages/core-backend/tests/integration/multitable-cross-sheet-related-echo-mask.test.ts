/**
 * Real-DB integration test for cross-sheet related write echoes.
 * Design-lock: docs/development/multitable-cross-sheet-related-echo-mask-design-20260601.md.
 *
 * POST /patch recomputes lookup/rollup dependents through computeDependentLookupRollupRecords().
 * Same-sheet dependents are masked by the edited sheet's F3 echo set, but cross-sheet dependents
 * were returned as-is. This test proves the related sheet's field-read gate is applied per sheet.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_xrel_${TS}`
const BASE_FOREIGN = `base_xrel_foreign_${TS}`
const SHEET_A = `sheet_xrel_a_${TS}`
const SHEET_B = `sheet_xrel_b_${TS}`
const SHEET_C = `sheet_xrel_c_${TS}`
const SHEET_D = `sheet_xrel_d_${TS}`

const A_EDIT = `fld_xrel_a_edit_${TS}`
const A_VISIBLE = `fld_xrel_a_visible_${TS}`
const A_SECRET = `fld_xrel_a_secret_${TS}`
const A_SELF_LINK = `fld_xrel_a_self_link_${TS}`
const A_SELF_LOOKUP = `fld_xrel_a_self_lookup_${TS}`

const B_LINK = `fld_xrel_b_link_${TS}`
const B_LOOKUP_VISIBLE = `fld_xrel_b_lookup_visible_${TS}`
const B_LOOKUP_SECRET = `fld_xrel_b_lookup_secret_${TS}`
const B_LOOKUP_HIDDEN = `fld_xrel_b_lookup_hidden_${TS}`

const C_LINK = `fld_xrel_c_link_${TS}`
const C_LOOKUP_VISIBLE = `fld_xrel_c_lookup_visible_${TS}`

const D_LINK = `fld_xrel_d_link_${TS}`
const D_LOOKUP_VISIBLE = `fld_xrel_d_lookup_visible_${TS}`

const A_REC = `rec_xrel_a_${TS}`
const A_DEP = `rec_xrel_a_dep_${TS}`
const B_REC = `rec_xrel_b_${TS}`
const C_REC = `rec_xrel_c_${TS}`
const D_REC = `rec_xrel_d_${TS}`

const USER_DENIED = `u_xrel_denied_${TS}`
const USER_SHEET_A_ONLY = `u_xrel_a_only_${TS}`
const USER_BASE_READ = `u_xrel_base_read_${TS}`
const USER_GRANTED = `u_xrel_granted_${TS}` // no deny row → per-subject positive control

const VISIBLE_CANARY = `visible-cross-related-${TS}`
const SECRET_CANARY = `do-not-leak-cross-related-${TS}`

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: USER_DENIED,
  roles: ['member'],
  perms: ['multitable:write'],
}

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const batchPatch = (value: string) =>
  request(app).post('/api/multitable/patch').send({
    sheetId: SHEET_A,
    changes: [{ recordId: A_REC, fieldId: A_EDIT, value }],
  })

const related = (body: any, sheetId: string, recordId: string) =>
  body.data?.relatedRecords?.find((r: { sheetId: string; recordId: string }) => r.sheetId === sheetId && r.recordId === recordId)

const sameSheetRecord = (body: any, recordId: string) =>
  body.data?.records?.find((r: { recordId: string }) => r.recordId === recordId)

describeIfDatabase('cross-sheet related write echo field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Cross Related Base'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_FOREIGN, 'Cross Related Foreign Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE_ID, 'Source'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE_ID, 'Dependent B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_C, BASE_ID, 'Dependent C'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_D, BASE_FOREIGN, 'Dependent D Foreign Base'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [A_EDIT, SHEET_A, 'Edit', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [A_VISIBLE, SHEET_A, 'Visible', 'string', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [A_SECRET, SHEET_A, 'Secret Source', 'string', '{}', 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [A_SELF_LINK, SHEET_A, 'Self Link', 'link', JSON.stringify({ foreignSheetId: SHEET_A }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [A_SELF_LOOKUP, SHEET_A, 'Self Lookup', 'lookup', JSON.stringify({ linkFieldId: A_SELF_LINK, targetFieldId: A_VISIBLE, foreignSheetId: SHEET_A }), 5])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [B_LINK, SHEET_B, 'Source Link', 'link', JSON.stringify({ foreignSheetId: SHEET_A }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [B_LOOKUP_VISIBLE, SHEET_B, 'Visible Lookup', 'lookup', JSON.stringify({ linkFieldId: B_LINK, targetFieldId: A_VISIBLE, foreignSheetId: SHEET_A }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [B_LOOKUP_SECRET, SHEET_B, 'Secret Lookup', 'lookup', JSON.stringify({ linkFieldId: B_LINK, targetFieldId: A_SECRET, foreignSheetId: SHEET_A }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [B_LOOKUP_HIDDEN, SHEET_B, 'Static Hidden Lookup', 'lookup', JSON.stringify({ linkFieldId: B_LINK, targetFieldId: A_SECRET, foreignSheetId: SHEET_A, hidden: true }), 4])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [C_LINK, SHEET_C, 'Source Link', 'link', JSON.stringify({ foreignSheetId: SHEET_A }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [C_LOOKUP_VISIBLE, SHEET_C, 'Visible Lookup', 'lookup', JSON.stringify({ linkFieldId: C_LINK, targetFieldId: A_VISIBLE, foreignSheetId: SHEET_A }), 2])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [D_LINK, SHEET_D, 'Source Link', 'link', JSON.stringify({ foreignSheetId: SHEET_A, foreignBaseId: BASE_ID }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [D_LOOKUP_VISIBLE, SHEET_D, 'Visible Lookup', 'lookup', JSON.stringify({ linkFieldId: D_LINK, targetFieldId: A_VISIBLE, foreignSheetId: SHEET_A }), 2])

    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [A_REC, SHEET_A, JSON.stringify({ [A_EDIT]: 'initial', [A_VISIBLE]: VISIBLE_CANARY, [A_SECRET]: SECRET_CANARY }), USER_DENIED])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [A_DEP, SHEET_A, '{}', USER_DENIED])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [B_REC, SHEET_B, '{}', USER_DENIED])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [C_REC, SHEET_C, '{}', USER_DENIED])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [D_REC, SHEET_D, '{}', USER_DENIED])

    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [A_SELF_LINK, A_DEP, A_REC])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [B_LINK, B_REC, A_REC])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [C_LINK, C_REC, A_REC])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [D_LINK, D_REC, A_REC])

    // Deny solely at layer-3: B_LOOKUP_SECRET.property.hidden is unset.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_B, B_LOOKUP_SECRET, 'user', USER_DENIED, false, false])
    // Sheet-only user can edit A but cannot read B/C, pinning the existing unreadable-related-sheet drop behavior.
    await q('INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)', [SHEET_A, USER_SHEET_A_ONLY, 'user', USER_SHEET_A_ONLY, 'spreadsheet:write'])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[A_SELF_LINK, B_LINK, C_LINK, D_LINK]]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B, SHEET_C, SHEET_D]]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B, SHEET_C, SHEET_D]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B, SHEET_C, SHEET_D]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B, SHEET_C, SHEET_D]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_B, SHEET_C, SHEET_D]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_ID, BASE_FOREIGN]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R1-R4/R6: cross-sheet related echoes are masked per related sheet while same-sheet echo still works', async () => {
    currentUser = { id: USER_DENIED, roles: ['member'], perms: ['multitable:write'] }
    const res = await batchPatch(`edit-${TS}-1`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const b = related(res.body, SHEET_B, B_REC)
    expect(b).toBeDefined()
    expect(b.data[B_LOOKUP_VISIBLE]).toEqual([VISIBLE_CANARY]) // positive control: cross-sheet data is not dropped
    expect(b.data[B_LOOKUP_SECRET]).toBeUndefined() // R1: layer-3 denied computed field omitted
    expect(b.data[B_LOOKUP_HIDDEN]).toBeUndefined() // R3: layer-2 hidden computed field omitted
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)

    const c = related(res.body, SHEET_C, C_REC)
    expect(c).toBeDefined()
    expect(c.data[C_LOOKUP_VISIBLE]).toEqual([VISIBLE_CANARY]) // R4: independent per-related-sheet allow set

    expect(related(res.body, SHEET_D, D_REC)).toBeUndefined() // R7: cross-base related sheet requires base-read

    const same = sameSheetRecord(res.body, A_DEP)
    expect(same).toBeDefined()
    expect(same.data[A_SELF_LOOKUP]).toEqual([VISIBLE_CANARY]) // R6: same-sheet related echo regression guard
  })

  test('R5: unreadable related sheets are dropped rather than returned with empty data', async () => {
    currentUser = { id: USER_SHEET_A_ONLY, roles: ['member'], perms: ['comments:write'] }
    const res = await batchPatch(`edit-${TS}-2`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(related(res.body, SHEET_B, B_REC)).toBeUndefined()
    expect(related(res.body, SHEET_C, C_REC)).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
  })

  test('R7 positive control: cross-base related echo is delivered when the caller has base-read', async () => {
    currentUser = { id: USER_BASE_READ, roles: ['member'], perms: ['multitable:write', 'multitable:base:read'] }
    const res = await batchPatch(`edit-${TS}-base-read`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const d = related(res.body, SHEET_D, D_REC)
    expect(d).toBeDefined()
    expect(d.data[D_LOOKUP_VISIBLE]).toEqual([VISIBLE_CANARY])
  })

  test('per-subject: a user WITHOUT the deny row receives B_LOOKUP_SECRET — the mask is subject-scoped, not global', async () => {
    // Direct contrast to R1: the SAME B_LOOKUP_SECRET that is masked for USER_DENIED is delivered to a user
    // who has no field_permissions deny row. This proves the omission in R1 is the field-read gate firing for
    // that subject — not the field being structurally absent / the lookup failing to resolve. USER_GRANTED has
    // no deny row and (like USER_DENIED) reads sheet B under the default-allow sheet model, so the cross-sheet
    // echo must carry the resolved value verbatim.
    currentUser = { id: USER_GRANTED, roles: ['member'], perms: ['multitable:write'] }
    const res = await batchPatch(`edit-${TS}-3`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const b = related(res.body, SHEET_B, B_REC)
    expect(b).toBeDefined()
    expect(b.data[B_LOOKUP_SECRET]).toEqual([SECRET_CANARY]) // present for the granted subject (was masked for USER_DENIED)
    expect(b.data[B_LOOKUP_VISIBLE]).toEqual([VISIBLE_CANARY]) // visible field unchanged across subjects
    expect(b.data[B_LOOKUP_HIDDEN]).toBeUndefined() // layer-2 static-hidden stays omitted for everyone (not subject-scoped)
    currentUser = { id: USER_DENIED, roles: ['member'], perms: ['multitable:write'] }
  })
})
