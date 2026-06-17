/**
 * #15 recycle bin — real-DB integration. Pins the delete→trash→restore round-trip, the occupied-id
 * conflict (409, never overwrite a live record), and permission denial (a non-deleter can neither view
 * nor restore the trash). Triggers: DELETE /records/:id, GET /sheets/:sheetId/trash,
 * POST /records/:recordId/restore. canDeleteRecord == canWrite, so multitable:write gates the bin.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_rb_${TS}`
const SHEET = `sheet_rb_${TS}`
const FLD = `fld_rb_${TS}`
const REC = `rec_rb_${TS}`
const WRITER = `u_rb_w_${TS}`
const READER = `u_rb_ro_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string, perms: string[]): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: ['member'], perms, permissions: perms }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}
const writerApp = () => buildApp(WRITER, ['multitable:read', 'multitable:write'])
const readerApp = () => buildApp(READER, ['multitable:read'])
const trashIds = (res: { body?: { data?: { records?: Array<{ recordId: string }> } } }) =>
  (res.body?.data?.records ?? []).map((r) => r.recordId)

describeIfDatabase('multitable recycle bin — delete/trash/restore (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RB Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'RB Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD, SHEET, 'Name', 'string', '{}', 1])
  })

  beforeEach(async () => {
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC, SHEET, JSON.stringify({ [FLD]: 'hello' })])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('delete → record lands in trash → restore → back in records', async () => {
    expect((await request(writerApp()).delete(`/api/multitable/records/${REC}`)).status).toBe(200)
    // gone from the live table
    expect((await request(writerApp()).get(`/api/multitable/records/${REC}`)).status).toBe(404)
    // appears in the trash
    const trash = await request(writerApp()).get(`/api/multitable/sheets/${SHEET}/trash`)
    expect(trash.status).toBe(200)
    expect(trashIds(trash)).toContain(REC)
    // restore
    expect((await request(writerApp()).post(`/api/multitable/records/${REC}/restore`)).status).toBe(200)
    // back in the live table with its data
    const back = await request(writerApp()).get(`/api/multitable/records/${REC}`)
    expect(back.status).toBe(200)
    expect(back.body?.data?.record?.data?.[FLD]).toBe('hello')
    // and no longer in the trash
    expect(trashIds(await request(writerApp()).get(`/api/multitable/sheets/${SHEET}/trash`))).not.toContain(REC)
  })

  test('restore into an OCCUPIED id → 409 conflict, live record untouched', async () => {
    await request(writerApp()).delete(`/api/multitable/records/${REC}`)
    // simulate id reuse: a live record now occupies the id
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC, SHEET, JSON.stringify({ [FLD]: 'new owner' })])
    expect((await request(writerApp()).post(`/api/multitable/records/${REC}/restore`)).status).toBe(409)
    const live = await request(writerApp()).get(`/api/multitable/records/${REC}`)
    expect(live.body?.data?.record?.data?.[FLD]).toBe('new owner') // not overwritten by the trashed 'hello'
  })

  test('permission denial: a read-only (non-deleter) actor cannot view or restore the trash', async () => {
    await request(writerApp()).delete(`/api/multitable/records/${REC}`)
    expect((await request(readerApp()).get(`/api/multitable/sheets/${SHEET}/trash`)).status).toBe(403)
    expect((await request(readerApp()).post(`/api/multitable/records/${REC}/restore`)).status).toBe(403)
    // the writer can still restore it afterward (denial didn't consume the trash row)
    expect((await request(writerApp()).post(`/api/multitable/records/${REC}/restore`)).status).toBe(200)
  })
})
