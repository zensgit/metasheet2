/**
 * Real-DB integration test for F2 — records-summary display field gate.
 *
 * F2 closes the caller-controlled displayFieldId bulk-read channel:
 * a sheet reader denied one field must not be able to request
 * /records-summary?displayFieldId=<denied> and receive that field for every row.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_f2summary_${TS}`
const SHEET_ID = `sheet_f2summary_${TS}`
const REC_1 = `rec_f2summary_1_${TS}`
const REC_2 = `rec_f2summary_2_${TS}`
const FLD_SECRET = `fld_f2summary_secret_${TS}`
const FLD_VISIBLE = `fld_f2summary_visible_${TS}`
const FLD_STATIC_HIDDEN = `fld_f2summary_static_hidden_${TS}`
const USER_DENIED = `u_f2summary_denied_${TS}`
const USER_ALLOWED = `u_f2summary_allowed_${TS}`
const SECRET_CANARY_1 = 'secret-summary-canary-alpha'
const SECRET_CANARY_2 = 'secret-summary-canary-beta'
const VISIBLE_1 = 'Visible Alpha'
const VISIBLE_2 = 'Visible Beta'
const STATIC_HIDDEN_CANARY = 'static-hidden-summary-canary'

let app: Express
let testUserId = USER_DENIED
let testPerms: string[] = ['multitable:read']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const summaryReq = (query: Record<string, string | number | null | undefined> = {}) =>
  request(app).get('/api/multitable/records-summary').query({ sheetId: SHEET_ID, ...query })

describeIfDatabase('F2 records-summary field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'F2 Summary Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'F2 Summary Sheet'])
    // Secret is ordered first so the pre-F2 default fallback leaks it when displayFieldId is omitted.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VISIBLE, SHEET_ID, 'Visible', 'string', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_STATIC_HIDDEN, SHEET_ID, 'Static Hidden', 'string', '{"hidden":true}', 3])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1),($4,$2,$5::jsonb,1)', [
      REC_1,
      SHEET_ID,
      JSON.stringify({
        [FLD_SECRET]: SECRET_CANARY_1,
        [FLD_VISIBLE]: VISIBLE_1,
        [FLD_STATIC_HIDDEN]: STATIC_HIDDEN_CANARY,
      }),
      REC_2,
      JSON.stringify({
        [FLD_SECRET]: SECRET_CANARY_2,
        [FLD_VISIBLE]: VISIBLE_2,
        [FLD_STATIC_HIDDEN]: STATIC_HIDDEN_CANARY,
      }),
    ])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_DENIED, false, false])
  })

  beforeEach(() => {
    testUserId = USER_DENIED
    testPerms = ['multitable:read']
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('R1: explicit layer-3 denied displayFieldId is rejected generically and leaks no bulk values', async () => {
    const res = await summaryReq({ displayFieldId: FLD_SECRET })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid displayFieldId' },
    })
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY_1)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY_2)
  })

  test('R2: non-existent displayFieldId uses the same generic rejection as a denied field', async () => {
    const res = await summaryReq({ displayFieldId: `fld_f2summary_missing_${TS}` })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid displayFieldId' },
    })
  })

  test('R3: omitted displayFieldId defaults to the first readable field, not the first string field blindly', async () => {
    const res = await summaryReq()
    expect(res.status).toBe(200)
    expect(res.body.data.records).toEqual([
      { id: REC_1, display: VISIBLE_1 },
      { id: REC_2, display: VISIBLE_2 },
    ])
    expect(res.body.data.displayMap).toEqual({
      [REC_1]: VISIBLE_1,
      [REC_2]: VISIBLE_2,
    })
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY_1)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY_2)
  })

  test('R4: search applies only to the readable effective display field', async () => {
    const res = await summaryReq({ search: 'secret-summary-canary' })
    expect(res.status).toBe(200)
    expect(res.body.data.records).toEqual([])
    expect(res.body.data.displayMap).toEqual({})
    expect(res.body.data.page).toMatchObject({ total: 0, hasMore: false })
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY_1)
  })

  test('R5: a readable subject with no layer-3 deny can explicitly use the secret display field', async () => {
    testUserId = USER_ALLOWED
    const res = await summaryReq({ displayFieldId: FLD_SECRET })
    expect(res.status).toBe(200)
    expect(res.body.data.records).toEqual([
      { id: REC_1, display: SECRET_CANARY_1 },
      { id: REC_2, display: SECRET_CANARY_2 },
    ])
  })

  test('R6: static-hidden displayFieldId is rejected by the same gate', async () => {
    const res = await summaryReq({ displayFieldId: FLD_STATIC_HIDDEN })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid displayFieldId' },
    })
    expect(JSON.stringify(res.body)).not.toContain(STATIC_HIDDEN_CANARY)
  })
})
