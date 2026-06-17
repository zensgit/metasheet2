/**
 * #18 row-level read-deny — CROSS-record enforcement (real DB).
 *
 * A lookup/rollup over a FOREIGN record the actor is denied ('none', with the FOREIGN sheet's
 * row_level_read_permissions_enabled flag ON) must treat that record as ABSENT: the lookup omits its
 * value, the rollup COUNT equals the readable-count (NEVER the true total → no cardinality leak), sum
 * excludes it, and the link summary omits its id. Flag-OFF on the foreign sheet → full values (#2754
 * canary). Admin bypasses. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_rrx_${TS}`
const MS = `sheet_rrx_src_${TS}` // source sheet
const FS = `sheet_rrx_for_${TS}` // foreign sheet
const FLD_FNAME = `fld_rrx_fname_${TS}` // foreign display (string)
const FLD_FVAL = `fld_rrx_fval_${TS}` // foreign value (number)
const FLD_LINK = `fld_rrx_link_${TS}`
const FLD_LOOKUP = `fld_rrx_lk_${TS}`
const FLD_COUNT = `fld_rrx_cnt_${TS}` // rollup countall
const FLD_SUM = `fld_rrx_sum_${TS}` // rollup sum
const FR_OK = `rec_rrx_fok_${TS}` // val 10
const FR_DENIED = `rec_rrx_fden_${TS}` // val 100, 'none' to USER
const REC = `rec_rrx_src_${TS}`
const USER_ID = `user_rrx_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let testRoles: string[] = ['member']
function buildApp(): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: USER_ID, roles: testRoles, perms: ['multitable:read'], permissions: ['multitable:read'] }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}
const setForeignFlag = (on: boolean) =>
  q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [FS, on])
async function readSrc() {
  const res = await request(buildApp()).get(`/api/multitable/records/${REC}`)
  expect(res.status).toBe(200)
  return res.body?.data
}
const rollupCfg = (aggregation: string) =>
  JSON.stringify({ linkFieldId: FLD_LINK, foreignSheetId: FS, targetFieldId: FLD_FVAL, aggregation })
const lookupCfg = () => JSON.stringify({ linkFieldId: FLD_LINK, foreignSheetId: FS, targetFieldId: FLD_FVAL })

describeIfDatabase('#18 row-level read-deny cross-record (lookup/rollup/link-summary, real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'RRX Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FS, BASE_ID, 'RRX Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [MS, BASE_ID, 'RRX Source'])
    // foreign fields + records
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FNAME, FS, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FVAL, FS, 'Val', 'number', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR_OK, FS, JSON.stringify({ [FLD_FNAME]: 'OK', [FLD_FVAL]: 10 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR_DENIED, FS, JSON.stringify({ [FLD_FNAME]: 'SECRET', [FLD_FVAL]: 100 })])
    // source fields: link → lookup(val) → rollup countall + rollup sum(val)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LOOKUP, MS, 'Lookup', 'lookup', lookupCfg(), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_COUNT, MS, 'Count', 'rollup', rollupCfg('countall'), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SUM, MS, 'Sum', 'rollup', rollupCfg('sum'), 4])
    // source record links BOTH foreign records
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC, MS, JSON.stringify({ [FLD_LINK]: [FR_OK, FR_DENIED] })])
    for (const fr of [FR_OK, FR_DENIED]) {
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_rrx_${fr}`, FLD_LINK, REC, fr])
    }
    // a 'none' read-deny on FR_DENIED for the actor, on the FOREIGN sheet
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [FS, FR_DENIED, 'user', USER_ID, 'none'])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [FS]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('flag OFF (foreign): lookup + rollup include the would-be-denied record (#2754 canary)', async () => {
    testRoles = ['member']
    await setForeignFlag(false)
    const d = await readSrc()
    expect((d.record.data[FLD_LOOKUP] as number[]).slice().sort((a, b) => a - b)).toEqual([10, 100])
    expect(d.record.data[FLD_COUNT]).toBe(2)
    expect(d.record.data[FLD_SUM]).toBe(110)
    const sum = (d.linkSummaries?.[FLD_LINK] ?? []) as Array<{ id: string }>
    expect(sum.map((s) => s.id).slice().sort()).toEqual([FR_DENIED, FR_OK].slice().sort())
  })

  test('flag ON (foreign): denied record ABSENT — lookup omits, countall=readable (NO leak), sum excludes, summary omits', async () => {
    testRoles = ['member']
    await setForeignFlag(true)
    const d = await readSrc()
    expect(d.record.data[FLD_LOOKUP]).toEqual([10]) // denied 100 omitted
    expect(d.record.data[FLD_COUNT]).toBe(1) // NOT 2 → no cardinality leak (the readable count, never the true total)
    expect(d.record.data[FLD_SUM]).toBe(10) // denied 100 excluded
    const sum = (d.linkSummaries?.[FLD_LINK] ?? []) as Array<{ id: string }>
    expect(sum.map((s) => s.id)).toEqual([FR_OK]) // denied id omitted from the link summary
  })

  test('flag ON (foreign) + admin: bypasses the deny (countall=2)', async () => {
    testRoles = ['admin']
    await setForeignFlag(true)
    const d = await readSrc()
    expect(d.record.data[FLD_COUNT]).toBe(2)
    expect((d.record.data[FLD_LOOKUP] as number[]).length).toBe(2)
    testRoles = ['member']
  })
})
