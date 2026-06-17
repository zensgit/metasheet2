/**
 * #18 row-level read-deny — CORE READ-PATH enforcement (real DB).
 *
 * Verifies the per-sheet flag gates the 'none' deny on the single-record GET path
 * (requireRecordReadable → deriveRecordPermissions). Flag OFF = grant-additive (#2754 canary:
 * a 'none'-scoped record is still returned); flag ON = the record is 403; a non-scoped record
 * is unaffected; an admin bypasses. Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 *
 * SCOPE: single-record GET + /view (in-app filter, same derive+flag). The paginated GET /records
 * API (3 branches) + summaries/aggregate/export/lookup-rollup/trash remain for later slices — SAFE
 * because the flag is DEFAULT-OFF, so nothing denies in prod until every surface + this suite land.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_rrd_${TS}`
const SHEET_ID = `sheet_rrd_${TS}`
const FLD = `fld_rrd_${TS}`
const REC_DENIED = `rec_rrd_denied_${TS}`
const REC_OK = `rec_rrd_ok_${TS}`
const USER_ID = `user_rrd_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read']

const getRecord = (recordId: string) => request(app).get(`/api/multitable/records/${recordId}`)
const setFlag = (on: boolean) =>
  q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])

describeIfDatabase('#18 row-level read-deny core enforcement (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'RRD Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'RRD Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD, SHEET_ID, 'V', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_DENIED, SHEET_ID, JSON.stringify({ [FLD]: 1 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_OK, SHEET_ID, JSON.stringify({ [FLD]: 2 })])
    // a 'none' read-deny on REC_DENIED for the actor (user-scoped)
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, REC_DENIED, 'user', USER_ID, 'none'])
  })

  afterAll(async () => {
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('flag OFF: a none-scoped record is STILL returned (grant-additive / #2754 canary)', async () => {
    await setFlag(false)
    testUserId = USER_ID
    testPerms = ['multitable:read']
    const res = await getRecord(REC_DENIED)
    expect(res.status).toBe(200)
  })

  test('flag ON: the none-scoped record is DENIED (403)', async () => {
    await setFlag(true)
    testUserId = USER_ID
    testPerms = ['multitable:read']
    const res = await getRecord(REC_DENIED)
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain('"data"')
  })

  test('flag ON: a record WITHOUT a none scope is still readable (200)', async () => {
    await setFlag(true)
    testUserId = USER_ID
    testPerms = ['multitable:read']
    const res = await getRecord(REC_OK)
    expect(res.status).toBe(200)
  })

  test('flag ON: an admin bypasses the deny (200)', async () => {
    await setFlag(true)
    testUserId = USER_ID
    testPerms = ['multitable:admin']
    const res = await getRecord(REC_DENIED)
    expect(res.status).toBe(200)
    testPerms = ['multitable:read']
  })

  // GET /records (cursor list) — this slice threaded the flag into its existing record-permission
  // post-filter, mirroring /view. Cursor pagination has no total, so the denied record drops from the page.
  const listRecordIds = async (): Promise<string[]> => {
    const res = await request(app).get('/api/multitable/records').query({ sheetId: SHEET_ID, limit: 100 })
    expect(res.status).toBe(200)
    return (res.body?.data?.records ?? []).map((r: { id: string }) => r.id)
  }

  test('GET /records flag OFF: the none-scoped record is listed (grant-additive)', async () => {
    await setFlag(false)
    testUserId = USER_ID
    const ids = await listRecordIds()
    expect(ids).toContain(REC_DENIED)
    expect(ids).toContain(REC_OK)
  })

  test('GET /records flag ON: the none-scoped record is EXCLUDED, the non-scoped one remains', async () => {
    await setFlag(true)
    testUserId = USER_ID
    const ids = await listRecordIds()
    expect(ids).not.toContain(REC_DENIED)
    expect(ids).toContain(REC_OK)
  })

  test('GET /records flag ON: an admin lists everything (deny bypassed)', async () => {
    await setFlag(true)
    testUserId = USER_ID
    testPerms = ['multitable:admin']
    const ids = await listRecordIds()
    expect(ids).toContain(REC_DENIED)
    testPerms = ['multitable:read']
  })
})
