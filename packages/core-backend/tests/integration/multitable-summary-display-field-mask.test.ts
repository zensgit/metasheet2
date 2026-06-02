/**
 * Real-DB integration test for F5 — record-summary display-value field mask on the cross-sheet read paths.
 * Design-lock: docs/development/multitable-record-egress-fieldperm-inventory-20260529.md (#2106) §3 F5.
 *
 * `loadRecordSummaries` derives a per-record `display` value from a display field. F2 (#2157) gated the
 * caller-controlled `displayFieldId` on `GET /records-summary` and passes `allowedFieldIds` so the DEFAULT
 * display field is picked only from readable fields. But two cross-sheet callers still pass NO allowedFieldIds:
 *   - `GET /fields/:fieldId/link-options` → loadRecordSummaries(FOREIGN sheet)
 *   - `GET /people-search`               → loadRecordSummaries(PEOPLE sheet)
 * So the default display field of the FOREIGN/PEOPLE sheet — keyed to THAT sheet, not the caller's — can be a
 * `field_permissions.visible=false` field, and its value leaks via `display`. F5 passes the foreign/people
 * sheet's own layer-2 ∧ layer-3 allowedFieldIds (the crossSheetRelated per-sheet-keying lesson).
 *
 * Seed non-negotiable: the denied display field's property carries no `hidden` → deny is solely layer-3.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const PEOPLE_DESC = '__metasheet_system:people__'

const TS = Date.now()
const BASE_ID = `base_f5_${TS}`
const SHEET_A = `sheet_f5_src_${TS}` // source sheet holding the link field
const FLD_LINK = `fld_f5_link_${TS}` // link field → SHEET_B
const SHEET_B = `sheet_f5_foreign_${TS}` // foreign sheet
const FLD_B_DISPLAY = `fld_f5_bdisplay_${TS}` // foreign default display (string), denied to USER
const REC_B = `rec_f5_b_${TS}`
const PEOPLE_SHEET = `sheet_f5_people_${TS}` // people sheet (description marker)
const FLD_P_NAME = `fld_f5_pname_${TS}` // people default display (string), denied to USER
const REC_P = `rec_f5_p_${TS}`
const USER_ID = `u_f5_${TS}` // denied FLD_B_DISPLAY + FLD_P_NAME
const USER_ID_2 = `u_f5_other_${TS}` // no deny → positive control
const B_CANARY = `do-not-leak-f5-link-${TS}`
const P_CANARY = `do-not-leak-f5-people-${TS}`

let app: Express
let testUserId = USER_ID

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const linkOptions = () => request(app).get(`/api/multitable/fields/${FLD_LINK}/link-options`)
const peopleSearch = () => request(app).get('/api/multitable/people-search').query({ baseId: BASE_ID })

describeIfDatabase('F5 record-summary display-value field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: ['multitable:read'] } : undefined; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'F5 Base'])
    // source sheet A + link field → B
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE_ID, 'F5 Source'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, SHEET_A, 'Linked', 'link', JSON.stringify({ foreignSheetId: SHEET_B }), 1])
    // foreign sheet B: its only string field is the (denied) default display
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE_ID, 'F5 Foreign'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_B_DISPLAY, SHEET_B, 'BName', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_B, SHEET_B, JSON.stringify({ [FLD_B_DISPLAY]: B_CANARY })])
    // people sheet (description marker) + denied display field
    await q('INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1,$2,$3,$4)', [PEOPLE_SHEET, BASE_ID, 'F5 People', PEOPLE_DESC])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_P_NAME, PEOPLE_SHEET, 'PName', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_P, PEOPLE_SHEET, JSON.stringify({ [FLD_P_NAME]: P_CANARY })])
    // layer-3 read deny (subject-scoped) on the foreign/people display fields, for USER only
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_B, FLD_B_DISPLAY, 'user', USER_ID, false, false])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [PEOPLE_SHEET, FLD_P_NAME, 'user', USER_ID, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[SHEET_B, PEOPLE_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_B, PEOPLE_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B, PEOPLE_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_B, PEOPLE_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R1 (link-options): a denied FOREIGN-sheet display field is not echoed as the summary display value', async () => {
    testUserId = USER_ID
    const res = await linkOptions()
    expect(res.status).toBe(200)
    const rec = res.body.data.records.find((r: { id: string }) => r.id === REC_B)
    expect(rec).toBeDefined() // the record is still listed (positive control: not an empty response)
    expect(rec.display).not.toBe(B_CANARY) // THE LEAK (RED pre-fix): denied foreign display value
    expect(JSON.stringify(res.body)).not.toContain(B_CANARY)
  })

  test('R2 (link-options positive): an ungranted-to-deny user DOES get the foreign display value (mask is per-subject)', async () => {
    testUserId = USER_ID_2
    const res = await linkOptions()
    expect(res.status).toBe(200)
    expect(res.body.data.records.find((r: { id: string }) => r.id === REC_B)?.display).toBe(B_CANARY)
    testUserId = USER_ID
  })

  test('R3 (people-search): a denied PEOPLE-sheet display field is not echoed as the summary display value', async () => {
    testUserId = USER_ID
    const res = await peopleSearch()
    expect(res.status).toBe(200)
    const item = res.body.data.items.find((r: { id: string }) => r.id === REC_P)
    expect(item).toBeDefined()
    expect(item.display).not.toBe(P_CANARY) // THE LEAK (RED pre-fix)
    expect(JSON.stringify(res.body)).not.toContain(P_CANARY)
  })

  test('R4 (people-search positive): an ungranted-to-deny user DOES get the people display value', async () => {
    testUserId = USER_ID_2
    const res = await peopleSearch()
    expect(res.status).toBe(200)
    expect(res.body.data.items.find((r: { id: string }) => r.id === REC_P)?.display).toBe(P_CANARY)
    testUserId = USER_ID
  })
})
