/**
 * Rollup string/boolean reducers (slice 2b) — real DB.
 *
 * Pins the end-to-end behavior of the non-numeric reducers and the downstream consequences of a rollup
 * no longer always being numeric:
 *  1. VALUE: concatenate → string, and/or/xor → boolean, surfaced through GET /records/:recordId.
 *  2. DASHBOARD: a sum/avg metric over a concatenate (string) or and/or/xor (boolean) rollup is REJECTED
 *     (400), while a numeric rollup is still accepted — DASHBOARD_NUMERIC_FIELD_TYPES now resolves the
 *     rollup's effective result type instead of treating every rollup as numeric.
 *
 * Trigger: GET /records/:recordId computes applyLookupRollup unconditionally and returns the value at
 * res.body.data.record.data[rollupFieldId]; POST /dashboard/query runs widget validation.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_sb_${TS}`

const BASE = `base_sb_${TS}`
const FS = `sheet_sb_fs_${TS}`
const MS = `sheet_sb_main_${TS}`

const FLD_TAG = `fld_sb_tag_${TS}` // foreign string target (for concatenate)
const FLD_FLAG = `fld_sb_flag_${TS}` // foreign boolean target (for and/or/xor)
const FLD_NUM = `fld_sb_num_${TS}` // foreign number target (for the numeric-rollup control)
const FLD_GROUP = `fld_sb_group_${TS}` // MS string field — dashboard group-by
const FLD_LINK = `fld_sb_lk_${TS}`
const FLD_CONCAT = `fld_sb_concat_${TS}` // concatenate(tag) -> 'a, b, c'
const FLD_AND = `fld_sb_and_${TS}` // and(flag) -> false (FR3 false)
const FLD_OR = `fld_sb_or_${TS}` // or(flag) -> true
const FLD_XOR = `fld_sb_xor_${TS}` // xor(flag) -> 2 truthy -> false
const FLD_SUM = `fld_sb_sum_${TS}` // sum(num) -> 35 (numeric rollup control)

const FR1 = `rec_sb_f1_${TS}` // tag a, flag true,  num 10
const FR2 = `rec_sb_f2_${TS}` // tag b, flag true,  num 20
const FR3 = `rec_sb_f3_${TS}` // tag c, flag false, num 5
const REC = `rec_sb_src_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: ['member'], perms: ['multitable:read'], permissions: ['multitable:read'] }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

async function readRollup(fieldId: string): Promise<unknown> {
  const res = await request(buildApp(USER)).get(`/api/multitable/records/${REC}`)
  expect(res.status).toBe(200)
  return res.body?.data?.record?.data?.[fieldId]
}

function rollup(aggregation: string, targetFieldId: string): string {
  return JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId, foreignSheetId: FS, aggregation })
}

async function dashboardSum(valueFieldId: string, metric: 'sum' | 'avg' = 'sum') {
  return request(buildApp(USER)).post('/api/multitable/dashboard/query').send({
    sheetId: MS,
    widgets: [{ title: 'W', chartType: 'bar', groupByFieldId: FLD_GROUP, metric, valueFieldId }],
  })
}

describeIfDatabase('multitable rollup string/boolean reducers (slice 2b, real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE, 'SB Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS, BASE, 'SB Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE, 'SB Main'])

    for (const [fid, name, type, order] of [
      [FLD_TAG, 'Tag', 'string', 1],
      [FLD_FLAG, 'Flag', 'boolean', 2],
      [FLD_NUM, 'Num', 'number', 3],
    ] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [fid, FS, name, type, '{}', order])
    }
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR1, FS, JSON.stringify({ [FLD_TAG]: 'a', [FLD_FLAG]: true, [FLD_NUM]: 10 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR2, FS, JSON.stringify({ [FLD_TAG]: 'b', [FLD_FLAG]: true, [FLD_NUM]: 20 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR3, FS, JSON.stringify({ [FLD_TAG]: 'c', [FLD_FLAG]: false, [FLD_NUM]: 5 })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_GROUP, MS, 'Group', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_CONCAT, MS, 'Concat', 'rollup', rollup('concatenate', FLD_TAG), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_AND, MS, 'And', 'rollup', rollup('and', FLD_FLAG), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_OR, MS, 'Or', 'rollup', rollup('or', FLD_FLAG), 5])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_XOR, MS, 'Xor', 'rollup', rollup('xor', FLD_FLAG), 6])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_SUM, MS, 'Sum', 'rollup', rollup('sum', FLD_NUM), 7])

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC, MS, JSON.stringify({ [FLD_GROUP]: 'g1', [FLD_LINK]: [FR1, FR2, FR3] })])
    for (const fr of [FR1, FR2, FR3]) {
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
        [`lnk_sb_${fr}`, FLD_LINK, REC, fr])
    }
  })

  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('concatenate → string value end-to-end', async () => {
    expect(await readRollup(FLD_CONCAT)).toBe('a, b, c')
  })

  test('and/or/xor → boolean values end-to-end', async () => {
    expect(await readRollup(FLD_AND)).toBe(false) // FR3 flag=false
    expect(await readRollup(FLD_OR)).toBe(true)
    expect(await readRollup(FLD_XOR)).toBe(false) // 2 truthy (FR1,FR2) → even
    expect(await readRollup(FLD_SUM)).toBe(35) // numeric control unaffected
  })

  test('dashboard REJECTS sum/avg over a concatenate (string) rollup', async () => {
    const res = await dashboardSum(FLD_CONCAT, 'sum')
    expect(res.status).toBe(400)
  })

  test('dashboard REJECTS avg over an and/or/xor (boolean) rollup', async () => {
    const res = await dashboardSum(FLD_AND, 'avg')
    expect(res.status).toBe(400)
  })

  test('dashboard ACCEPTS sum over a numeric rollup (not rejected as non-numeric)', async () => {
    const res = await dashboardSum(FLD_SUM, 'sum')
    expect(res.status).toBe(200)
  })
})
