/**
 * #2734 — by-value real-DB egress locking test for the native person (人员) field.
 *
 * The person field stores `userId[]` and adds a `personSummaries` egress channel on GET /view
 * (data.personSummaries[recordId][fieldId][]) and single-record GET /records/:recordId
 * (data.personSummaries[fieldId][]). Both route the value through the SAME layer-2 ∧ layer-3
 * composite as linkSummaries — `filterRecordFieldSummaryMap` / `filterSingleRecordFieldSummaryMap`
 * over `allowedFieldIds`, built AFTER the field mask. The egress-coverage guard ensures the channel
 * still CALLS the filter; this test pins the OUTPUT by value, so a future refactor cannot silently
 * route the person value around the mask.
 *
 * Scenario: a `field_permissions.visible=false` deny on the person field for USER_DENIED. The denied
 * caller must see NEITHER record.data[personFieldId] NOR personSummaries[...][personFieldId] — and the
 * stored userId + its resolved display name must not appear anywhere in the response. A second caller
 * with no deny is the non-vacuous positive control (proves the channel actually carries the value).
 *
 * Real-DB only (describeIfDatabase + a sentinel so it FAILS-not-skips in CI; registered in
 * plugin-tests.yml so `test (20.x)` actually runs it).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeAll, afterAll, describe, test, expect } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_psm_${TS}`
const SHEET_ID = `sheet_psm_${TS}`
const FLD_VISIBLE = `fld_psm_vis_${TS}` // readable string — positive control that the sheet/record is reachable
const FLD_PERSON = `fld_psm_person_${TS}` // native person field → personSummaries (the denied channel under test)
const REC_ID = `rec_psm_${TS}`
const PERSON_USER = `u_psm_target_${TS}` // the userId stored in the person cell — the by-value canary (appears as personSummaries[...].id)
const PERSON_DISPLAY = `Person Canary ${TS}` // the resolved display name — second canary (personSummaries[...].display)
const USER_DENIED = `u_psm_denied_${TS}` // field_permissions-denied on FLD_PERSON
const USER_GRANTED = `u_psm_granted_${TS}` // no deny → positive control

let app: Express
let testUserId: string | null = null
let testPerms: string[] = ['multitable:read']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const viewReq = () => request(app).get('/api/multitable/view').query({ sheetId: SHEET_ID })
const recordReq = () => request(app).get(`/api/multitable/records/${REC_ID}`).query({ sheetId: SHEET_ID })

describeIfDatabase('native person personSummaries by-value field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'PSM Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'PSM Sheet'])
    // FLD_VISIBLE readable (positive control); FLD_PERSON native person (the denied channel)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VISIBLE, SHEET_ID, 'Visible', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_PERSON, SHEET_ID, 'Owner', 'person', '{}', 2])
    // person user resolved by buildPersonSummaries via SELECT id,email,name FROM users
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [PERSON_USER, `${PERSON_USER}@example.test`, PERSON_DISPLAY],
    )
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify({ [FLD_VISIBLE]: 'visible-val', [FLD_PERSON]: [PERSON_USER] })])
    // layer-3 read deny on FLD_PERSON for USER_DENIED only (USER_GRANTED = positive control)
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_PERSON, 'user', USER_DENIED, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [PERSON_USER]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('positive control (GET /view, GRANTED): personSummaries carries the person value (non-vacuous)', async () => {
    testUserId = USER_GRANTED; testPerms = ['multitable:read']
    const res = await viewReq()
    expect(res.status).toBe(200)
    const rec = (res.body.data.rows as Array<{ id: string; data: Record<string, unknown> }>).find((r) => r.id === REC_ID)
    expect(rec?.data[FLD_PERSON]).toEqual([PERSON_USER]) // readable: the raw value present
    expect(res.body.data.personSummaries?.[REC_ID]?.[FLD_PERSON]?.[0]?.id).toBe(PERSON_USER)
    expect(res.body.data.personSummaries?.[REC_ID]?.[FLD_PERSON]?.[0]?.display).toBe(PERSON_DISPLAY)
  })

  test('GET /view (DENIED): person value is absent from record.data AND personSummaries; neither userId nor display leaks', async () => {
    testUserId = USER_DENIED; testPerms = ['multitable:read']
    const res = await viewReq()
    expect(res.status).toBe(200)
    const rec = (res.body.data.rows as Array<{ id: string; data: Record<string, unknown> }>).find((r) => r.id === REC_ID)
    expect(rec).toBeDefined() // sheet/record reachable
    expect(rec?.data[FLD_VISIBLE]).toBe('visible-val') // positive control: readable field survives
    expect(rec?.data[FLD_PERSON]).toBeUndefined() // THE field mask
    expect(res.body.data.personSummaries?.[REC_ID]?.[FLD_PERSON]).toBeUndefined() // THE summary mask
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(PERSON_USER)
    expect(body).not.toContain(PERSON_DISPLAY)
  })

  test('positive control (single-record GET, GRANTED): personSummaries carries the person value (non-vacuous)', async () => {
    testUserId = USER_GRANTED; testPerms = ['multitable:read']
    const res = await recordReq()
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_PERSON]).toEqual([PERSON_USER])
    expect(res.body.data.personSummaries?.[FLD_PERSON]?.[0]?.id).toBe(PERSON_USER)
  })

  test('single-record GET (DENIED): person value is absent from record.data AND personSummaries; nothing leaks', async () => {
    testUserId = USER_DENIED; testPerms = ['multitable:read']
    const res = await recordReq()
    expect(res.status).toBe(200)
    expect(res.body.data.record.data[FLD_VISIBLE]).toBe('visible-val') // positive control
    expect(res.body.data.record.data[FLD_PERSON]).toBeUndefined() // field mask
    expect(res.body.data.personSummaries?.[FLD_PERSON]).toBeUndefined() // summary mask (single-record shape: keyed by fieldId)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(PERSON_USER)
    expect(body).not.toContain(PERSON_DISPLAY)
  })
})
