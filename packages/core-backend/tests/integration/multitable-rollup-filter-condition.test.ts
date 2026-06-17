/**
 * Rollup filter condition (slice 3) — real DB.
 *
 * A rollup may carry an optional condition so it aggregates ONLY the linked foreign records that match
 * (e.g. SUM(amount) where status = "paid"). Two things are pinned:
 *  1. Behavior: the filter narrows count/countall/sum to the matched subset; no filter = aggregate all.
 *  2. SECURITY (owner gate): a condition that reads a foreign field the actor CANNOT read is a
 *     side-channel — the match-count would leak the masked field — so resolveLookupValues fails CLOSED
 *     and masks the WHOLE rollup to null. Crucially the fail-closed is SCOPED to the offending rollup:
 *     a sibling rollup whose condition reads a readable field still works for the same actor.
 *
 * Trigger: GET /records/:recordId computes applyLookupRollup unconditionally and returns the value at
 * res.body.data.record.data[rollupFieldId].
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const ALLOW_USER = `u_rf_allow_${TS}` // reads everything
const DENY_USER = `u_rf_deny_${TS}` // denied on the foreign SECRET field

const BASE = `base_rf_${TS}`
const FS = `sheet_rf_fs_${TS}`
const MS = `sheet_rf_main_${TS}`

const FLD_AMOUNT = `fld_rf_amt_${TS}` // number target
const FLD_STATUS = `fld_rf_status_${TS}` // string filter field (readable by all)
const FLD_SECRET = `fld_rf_secret_${TS}` // string filter field (DENIED for DENY_USER)
const FLD_LINK = `fld_rf_lk_${TS}`
const FLD_ALL = `fld_rf_all_${TS}` // countall, no filter -> 3
const FLD_PAID_COUNT = `fld_rf_pc_${TS}` // countall where status = paid -> 2
const FLD_PAID_SUM = `fld_rf_ps_${TS}` // sum amount where status = paid -> 30
const FLD_BY_SECRET = `fld_rf_bs_${TS}` // countall where secret = yes -> 2 (masks to null for DENY_USER)

const FR1 = `rec_rf_f1_${TS}` // amount 10, paid,   secret yes
const FR2 = `rec_rf_f2_${TS}` // amount 20, paid,   secret no
const FR3 = `rec_rf_f3_${TS}` // amount  5, unpaid, secret yes
const REC = `rec_rf_src_${TS}`

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

async function readRollup(userId: string, fieldId: string): Promise<unknown> {
  const res = await request(buildApp(userId)).get(`/api/multitable/records/${REC}`)
  expect(res.status).toBe(200)
  return res.body?.data?.record?.data?.[fieldId]
}

function rollup(aggregation: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_AMOUNT, foreignSheetId: FS, aggregation, ...extra })
}

describeIfDatabase('multitable rollup filter condition + fail-closed field-readability (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE, 'RF Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS, BASE, 'RF Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE, 'RF Main'])

    for (const [fid, name, type, order] of [
      [FLD_AMOUNT, 'Amount', 'number', 1],
      [FLD_STATUS, 'Status', 'string', 2],
      [FLD_SECRET, 'Secret', 'string', 3],
    ] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [fid, FS, name, type, '{}', order])
    }

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR1, FS, JSON.stringify({ [FLD_AMOUNT]: 10, [FLD_STATUS]: 'paid', [FLD_SECRET]: 'yes' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR2, FS, JSON.stringify({ [FLD_AMOUNT]: 20, [FLD_STATUS]: 'paid', [FLD_SECRET]: 'no' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR3, FS, JSON.stringify({ [FLD_AMOUNT]: 5, [FLD_STATUS]: 'unpaid', [FLD_SECRET]: 'yes' })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_ALL, MS, 'All', 'rollup', rollup('countall'), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PAID_COUNT, MS, 'PaidCount', 'rollup', rollup('countall', { filters: [{ fieldId: FLD_STATUS, operator: 'is', value: 'paid' }] }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PAID_SUM, MS, 'PaidSum', 'rollup', rollup('sum', { filters: [{ fieldId: FLD_STATUS, operator: 'is', value: 'paid' }] }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_BY_SECRET, MS, 'BySecret', 'rollup', rollup('countall', { filters: [{ fieldId: FLD_SECRET, operator: 'is', value: 'yes' }] }), 5])

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC, MS, JSON.stringify({ [FLD_LINK]: [FR1, FR2, FR3] })])
    for (const fr of [FR1, FR2, FR3]) {
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
        [`lnk_rf_${fr}`, FLD_LINK, REC, fr])
    }

    // DENY_USER cannot read the foreign SECRET field → any rollup whose CONDITION reads it must fail closed.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS, FLD_SECRET, 'user', DENY_USER, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('filter narrows the aggregate to matched linked records (countall/sum); no filter = all', async () => {
    expect(await readRollup(ALLOW_USER, FLD_ALL)).toBe(3) // no filter
    expect(await readRollup(ALLOW_USER, FLD_PAID_COUNT)).toBe(2) // status = paid -> FR1, FR2
    expect(await readRollup(ALLOW_USER, FLD_PAID_SUM)).toBe(30) // amount of paid -> 10 + 20
    expect(await readRollup(ALLOW_USER, FLD_BY_SECRET)).toBe(2) // secret = yes -> FR1, FR3
  })

  test('SECURITY fail-closed: a condition on a field the actor cannot read masks that rollup to null', async () => {
    expect(await readRollup(DENY_USER, FLD_BY_SECRET) ?? null).toBeNull() // condition reads denied FLD_SECRET
  })

  test('fail-closed is SCOPED: sibling rollups whose condition reads a readable field still work', async () => {
    expect(await readRollup(DENY_USER, FLD_ALL)).toBe(3) // no filter
    expect(await readRollup(DENY_USER, FLD_PAID_COUNT)).toBe(2) // condition reads FLD_STATUS (readable)
    expect(await readRollup(DENY_USER, FLD_PAID_SUM)).toBe(30)
  })
})
