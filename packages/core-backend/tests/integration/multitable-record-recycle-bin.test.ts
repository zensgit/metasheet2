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

  test('restore REBUILDS outbound links — a link field is not silently emptied', async () => {
    const fsheet = `sheet_rbl_${TS}`, ffld = `fld_rbl_t_${TS}`, frec = `rec_rbl_f_${TS}`
    const lfld = `fld_rbl_link_${TS}`, srec = `rec_rbl_s_${TS}`
    try {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [fsheet, BASE, 'RBL Foreign'])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [ffld, fsheet, 'T', 'string', '{}', 1])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [frec, fsheet, JSON.stringify({ [ffld]: 'x' })])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [lfld, SHEET, 'Link', 'link', JSON.stringify({ foreignSheetId: fsheet }), 2])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [srec, SHEET, JSON.stringify({ [FLD]: 'linked', [lfld]: [frec] })])
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_rbl_${TS}`, lfld, srec, frec])
      expect((await request(writerApp()).delete(`/api/multitable/records/${srec}`)).status).toBe(200)
      expect((await request(writerApp()).post(`/api/multitable/records/${srec}/restore`)).status).toBe(200)
      const back = await request(writerApp()).get(`/api/multitable/records/${srec}`)
      expect(back.status).toBe(200)
      // The restored link field must carry the foreign id again (meta_links rebuilt), not be empty.
      expect(JSON.stringify(back.body?.data?.record?.data?.[lfld] ?? null)).toContain(frec)
    } finally {
      await q('DELETE FROM meta_links WHERE field_id = $1', [lfld]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE sheet_id = ANY($1::text[])', [[SHEET, fsheet]]).catch(() => {})
      await q('DELETE FROM meta_records WHERE id = $1', [srec]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [fsheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE id = $1', [lfld]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [fsheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [fsheet]).catch(() => {})
    }
  })

  test('restore into a DELETED sheet is rejected (orphan guard), not resurrected', async () => {
    const tsheet = `sheet_rbo_${TS}`, trec = `rec_rbo_${TS}`
    try {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [tsheet, BASE, 'RBO'])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [trec, tsheet, JSON.stringify({})])
      expect((await request(writerApp()).delete(`/api/multitable/records/${trec}`)).status).toBe(200)
      await q('DELETE FROM meta_sheets WHERE id = $1', [tsheet]) // hard-delete the sheet; trash row survives
      expect((await request(writerApp()).post(`/api/multitable/records/${trec}/restore`)).status).toBe(409)
    } finally {
      await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [tsheet]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [tsheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [tsheet]).catch(() => {})
    }
  })

  test('restore PRESERVES the original created_at (not reset to restore-time)', async () => {
    const crec = `rec_rbc_${TS}`
    const old = '2020-01-02T03:04:05.000Z'
    try {
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_at) VALUES ($1,$2,$3::jsonb,1,$4)', [crec, SHEET, JSON.stringify({ [FLD]: 'old' }), old])
      expect((await request(writerApp()).delete(`/api/multitable/records/${crec}`)).status).toBe(200)
      expect((await request(writerApp()).post(`/api/multitable/records/${crec}/restore`)).status).toBe(200)
      const row = await q('SELECT created_at FROM meta_records WHERE id = $1', [crec])
      expect(new Date(row.rows[0].created_at as string).toISOString()).toBe(old)
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [crec]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE record_id = $1', [crec]).catch(() => {})
    }
  })
})

// P1 authz: trash list/restore must honor the same write-own row policy as deleteRecord (a write-own user
// sees/restores only OWN trash) and the same field-read mask as live read (field_permissions.visible=false
// must not leak through the trash API).
describeIfDatabase('multitable recycle bin — authz: write-own row policy + field-read mask (real DB)', () => {
  const A_BASE = `base_rba_${TS}`
  const A_SHEET = `sheet_rba_${TS}`
  const A_FLD = `fld_rba_${TS}`
  const A_SECRET = `fld_rbas_${TS}`
  const A_FULL = `u_rba_full_${TS}` // global multitable:write (does setup deletes; field-mask subject)
  const OWNER = `u_rba_own_${TS}` // sheet-scoped write-own, NO global write
  const OTHER = `u_rba_oth_${TS}`
  const REC_OWN = `rec_rba_own_${TS}`
  const REC_OTHER = `rec_rba_oth_${TS}`
  const fullApp = () => buildApp(A_FULL, ['multitable:read', 'multitable:write'])
  const ownApp = () => buildApp(OWNER, ['multitable:read'])

  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [A_BASE, 'RBA Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [A_SHEET, A_BASE, 'RBA Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [A_FLD, A_SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [A_SECRET, A_SHEET, 'Secret', 'string', '{}', 2])
    // OWNER: sheet-scoped write-own grant with no global write → requiresOwnWriteRowPolicy true.
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [A_SHEET, 'user', OWNER, 'spreadsheet:write-own'])
  })
  beforeEach(async () => {
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [A_SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [A_SHEET])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [REC_OWN, A_SHEET, JSON.stringify({ [A_FLD]: 'mine', [A_SECRET]: 'shh' }), OWNER])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [REC_OTHER, A_SHEET, JSON.stringify({ [A_FLD]: 'theirs', [A_SECRET]: 'shh' }), OTHER])
  })
  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [A_SHEET]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [A_SHEET]).catch(() => {})
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [A_SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [A_SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [A_SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [A_SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [A_BASE]).catch(() => {})
  })

  test('write-own: trash list shows only the actor\'s own deletions; full writer sees both', async () => {
    expect((await request(fullApp()).delete(`/api/multitable/records/${REC_OWN}`)).status).toBe(200)
    expect((await request(fullApp()).delete(`/api/multitable/records/${REC_OTHER}`)).status).toBe(200)
    const own = await request(ownApp()).get(`/api/multitable/sheets/${A_SHEET}/trash`)
    expect(own.status).toBe(200)
    expect(trashIds(own)).toEqual([REC_OWN]) // NOT REC_OTHER
    const full = await request(fullApp()).get(`/api/multitable/sheets/${A_SHEET}/trash`)
    expect(trashIds(full).slice().sort()).toEqual([REC_OTHER, REC_OWN].slice().sort())
    expect(full.body.data.total).toBe(2)
    expect(own.body.data.total).toBe(1) // own filter applies to total too
  })

  test('write-own: cannot restore another user\'s trashed record (403), but can restore own', async () => {
    expect((await request(fullApp()).delete(`/api/multitable/records/${REC_OTHER}`)).status).toBe(200)
    expect((await request(ownApp()).post(`/api/multitable/records/${REC_OTHER}/restore`)).status).toBe(403)
    expect((await request(fullApp()).delete(`/api/multitable/records/${REC_OWN}`)).status).toBe(200)
    expect((await request(ownApp()).post(`/api/multitable/records/${REC_OWN}/restore`)).status).toBe(200)
  })

  test('field mask: a field_permissions.visible=false field is redacted from the trash list data', async () => {
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [A_SHEET, A_SECRET, 'user', A_FULL, false, false])
    try {
      expect((await request(fullApp()).delete(`/api/multitable/records/${REC_OWN}`)).status).toBe(200)
      const res = await request(fullApp()).get(`/api/multitable/sheets/${A_SHEET}/trash`)
      expect(res.status).toBe(200)
      const rec = (res.body?.data?.records ?? []).find((r: { recordId: string }) => r.recordId === REC_OWN) as { data: Record<string, unknown> } | undefined
      expect(rec).toBeTruthy()
      expect(rec?.data[A_FLD]).toBe('mine') // visible field still present
      expect(A_SECRET in (rec?.data ?? {})).toBe(false) // hidden field redacted, not leaked
    } finally {
      await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2', [A_SHEET, A_SECRET]).catch(() => {})
    }
  })
})
