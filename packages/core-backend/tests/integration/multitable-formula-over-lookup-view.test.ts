/**
 * A-min (formula-over-lookup, design #2246) — real-DB wire proof.
 *
 * Proves the headline fix through the actual PATCH write path:
 *  - T1/T2 (positive, same-record): editing a record's LINK field re-runs that record's formula
 *    AND it computes against the ACTUAL hydrated lookup value (not stale, not absent→0).
 *  - T4a (positive since A-full, design #2410): editing the foreign record's target DOES
 *    recompute the related record's formula — the one-hop propagation that was the A-min-era
 *    negative boundary. The full A-full matrix lives in
 *    multitable-formula-over-lookup-afull-view.test.ts.
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list.
 * Numeric semantics observed in tests/unit/multitable-formula-over-lookup.test.ts: a single-value
 * numeric lookup [9] hydrates and `={lu}+1` evaluates to 10 (the base engine coerces the scalar
 * join numerically); absent → 1. So 10 vs 6 (no re-run) vs 1 (value-source=0) are all distinct.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_fol_${TS}`
const BASE_ID = `base_fol_${TS}`
const FS = `sheet_fol_foreign_${TS}` // foreign sheet (separate from the main sheet)
const MS = `sheet_fol_main_${TS}` // main sheet (link + lookup + formula)
const FLD_FTARGET = `fld_ftarget_${TS}`
const FLD_LINK = `fld_link_${TS}`
const FLD_LU = `fld_lu_${TS}`
const FLD_F = `fld_f_${TS}`
const REC_FX = `rec_fx_${TS}` // foreign target = 5
const REC_FY = `rec_fy_${TS}` // foreign target = 9
const REC_M = `rec_m_${TS}` // main record, seeded linked to REC_FX with a STALE formula (6)

let app: Express
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const readFormula = async (recordId: string, sheetId: string) => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
  const data = (r.rows as any[])[0]?.data
  const parsed = typeof data === 'string' ? JSON.parse(data) : data
  return parsed?.[FLD_F]
}

describeIfDatabase('multitable formula-over-lookup A-min (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: USER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'FoL Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS, BASE_ID, 'Foreign Sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_ID, 'Main Sheet'])

    // foreign sheet: one numeric target field + two records (5, 9)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_FTARGET, FS, 'FTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_FX, FS, JSON.stringify({ [FLD_FTARGET]: 5 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_FY, FS, JSON.stringify({ [FLD_FTARGET]: 9 })])

    // main sheet: link -> FS, lookup (link -> FS.FTarget), formula = {lookup}+1
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_FTARGET, foreignSheetId: FS }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_F, MS, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 3])

    // main record: seeded with a STALE formula value (6, as if computed for the REC_FX link) +
    // an existing link to REC_FX, and the formula→lookup dependency edge.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_M, MS, JSON.stringify({ [FLD_F]: 6 })])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}`, FLD_LINK, REC_M, REC_FX])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)', [MS, FLD_F, FLD_LU, MS])
  })

  afterAll(async () => {
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_links WHERE record_id = $1', [REC_M]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('T1/T2: same-record link edit re-runs the formula against the ACTUAL hydrated lookup value', async () => {
    // Re-point REC_M's link from REC_FX(5) to REC_FY(9). The formula = {lookup}+1 must re-run
    // (trigger) and compute against the new lookup value 9 (value-source) → 10.
    // 10 distinguishes from 6 (no re-run / stale) and from 1 (re-ran but lookup absent → 0).
    const res = await request(app).post('/api/multitable/patch').send({
      sheetId: MS,
      changes: [{ recordId: REC_M, fieldId: FLD_LINK, value: [REC_FY], expectedVersion: 1 }],
    })
    expect(res.status).toBe(200)
    expect(await readFormula(REC_M, MS)).toBe(10) // DB-materialized, authoritative
  })

  test('T4a (flipped by A-full #2410): editing the FOREIGN record DOES recompute the related formula', async () => {
    // After T1, REC_M.formula = 10 (lookup = REC_FY.FTarget = 9). Now edit the FOREIGN record
    // REC_FY.FTarget 9 → 100 on the SEPARATE foreign sheet. Under A-full's bounded one-hop
    // propagation the related record's lookup-backed formula recomputes: [100] + 1 → 101.
    // (Until #2410's implementation this was the locked NEGATIVE asserting 10 — A-min's
    // deliberate same-record boundary. The flip is the A-full headline.)
    const res = await request(app).post('/api/multitable/patch').send({
      sheetId: FS,
      changes: [{ recordId: REC_FY, fieldId: FLD_FTARGET, value: 100, expectedVersion: 1 }],
    })
    expect(res.status).toBe(200)
    expect(await readFormula(REC_M, MS)).toBe(101) // one-hop foreign propagation materialized
  })
})
