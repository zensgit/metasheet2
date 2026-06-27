/**
 * Cross-base / link referential integrity — dangling-link repair (real DB). `meta_links.foreign_record_id` has
 * NO FK (record_id does: ON DELETE CASCADE), so an inbound edge to a since-deleted record DANGLES and would
 * surface as a GHOST foreign id on read.
 *   (i) repair-on-read: loadLinkValuesByRecord filters edges whose foreign record no longer exists.
 *   (ii) sheet-delete cascade: DELETE /sheets/:id cleans inbound edges (foreign_record_id IN the sheet's records)
 *        in the SAME transaction before the records vanish.
 * Goldens: (a) a manually-inserted dangling edge is NOT surfaced as a ghost link id (repair-on-read; RED before);
 * (b) deleting the foreign sheet removes the inbound edges (cascade; RED before) and the source reads no ghost.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_dl_${TS}`
const SA = `sheet_dl_a_${TS}` // source sheet (has the link field)
const SB = `sheet_dl_b_${TS}` // foreign target sheet (deleted in golden b)
const FLD_LINK = `fld_dl_link_${TS}`
const FLD_B = `fld_dl_b_${TS}`
const RA = `rec_dl_a_${TS}`
const RB = `rec_dl_b_${TS}`
const GHOST = `rec_dl_ghost_${TS}` // never inserted into meta_records → a dangling foreign_record_id
const U = `u_dl_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const buildApp = (): Express => {
  const a = express(); a.use(express.json())
  a.use((req, _res, next) => { ;(req as { user?: unknown }).user = { id: U, roles: ['member'], perms: ['multitable:read', 'multitable:write'], permissions: ['multitable:read', 'multitable:write'] }; next() })
  a.use('/api/multitable', univerMetaRouter()); return a
}
const linkValue = async (recId: string): Promise<unknown[]> => {
  const res = await request(buildApp()).get(`/api/multitable/records/${recId}`)
  expect(res.status).toBe(200)
  const v = res.body?.data?.record?.data?.[FLD_LINK]
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x as { id?: string })?.id ?? x)) : []
}
const inboundEdgeCount = async (foreignId: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE foreign_record_id=$1', [foreignId])).rows[0] as { n: number }).n)

describeIfDatabase('multitable dangling-link referential integrity (real DB)', () => {
  beforeEach(async () => {
    await q('DELETE FROM meta_links WHERE field_id=$1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id=$1', [BASE]).catch(() => {})
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'DL Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SB, BASE, 'DL B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SA, BASE, 'DL A'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_B, SB, 'BF', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, SA, 'Link', 'link', JSON.stringify({ foreignSheetId: SB }), 1])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [U])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [RB, SB, JSON.stringify({ [FLD_B]: 'b-val' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [RA, SA, JSON.stringify({ [FLD_LINK]: [RB] })])
    // authoritative edge RA → RB (meta_links is the source of truth, not data[FLD_LINK])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_dl_real_${TS}`, FLD_LINK, RA, RB])
  })
  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id=$1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SA, SB]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id=$1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id=$1', [U]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) repair-on-read: a dangling inbound edge (foreign record never existed) is NOT surfaced as a ghost link id', async () => {
    // foreign_record_id has no FK → a dangling edge is insertable; it must be filtered on read.
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_dl_ghost_${TS}`, FLD_LINK, RA, GHOST])
    const v = await linkValue(RA)
    expect(v).toContain(RB) // the real linked record still surfaces
    expect(v).not.toContain(GHOST) // the dangling edge is filtered (RED before the repair-on-read fix)
  })

  test('(b) sheet-delete cascade: deleting the foreign sheet cleans inbound edges + the source reads no ghost', async () => {
    expect(await inboundEdgeCount(RB)).toBe(1) // RA → RB edge exists pre-delete
    const del = await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
    expect(del.status).toBe(200)
    expect(await inboundEdgeCount(RB)).toBe(0) // (ii) cascade physically cleaned the inbound edge (RED before: stays 1)
    expect(await linkValue(RA)).not.toContain(RB) // RA no longer shows the gone record
  })
})
