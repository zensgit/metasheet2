/**
 * A-min-create (design #2255) — real-DB wire proof for the three INSERT paths.
 * A new/submitted/imported record's same-record link -> lookup -> formula now computes on its
 * first appearance (hydrated), instead of being uncomputed (create) or computed against 0 (submit).
 *
 *  - C1: POST /records create        -> formula = actual lookup value (was uncomputed)
 *  - C2: form-submit create          -> formula = actual value (was raw recalc -> 0)
 *  - C3: import-xlsx (inherited)     -> imported record's formula = actual value
 *  - N1: same-record boundary        -> creating one record does NOT recompute an unrelated record
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list.
 * Numeric semantics inherited from A-min: single-value numeric lookup [5] -> `={lu}+1` = 6.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { buildXlsxBuffer, type XlsxModule } from '../../src/multitable/xlsx-service'

const xlsx = (await import('xlsx')) as unknown as XlsxModule
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_folc_${TS}`
const BASE_ID = `base_folc_${TS}`
const FS = `sheet_folc_foreign_${TS}`
const MS = `sheet_folc_main_${TS}`
const FLD_FTARGET = `fld_ftarget_${TS}`
const FLD_LINK = `fld_link_${TS}`
const FLD_LU = `fld_lu_${TS}`
const FLD_F = `fld_f_${TS}`
const REC_FX = `rec_fx_${TS}` // ftarget = 5  -> formula 6 (C1, C2)
const REC_FZ = `rec_fz_${TS}` // ftarget = 8  -> formula 9 (C3, isolates the imported record)
const REC_B = `rec_b_${TS}` // pre-seeded unrelated record with a STALE formula (N1)
const V_FORM = `v_form_${TS}`

let app: Express
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const formulaOf = async (recordId: string) => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, MS])
  const data = (r.rows as any[])[0]?.data
  return (typeof data === 'string' ? JSON.parse(data) : data)?.[FLD_F]
}

describeIfDatabase('multitable formula-over-lookup on create/submit/import (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: USER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'FoLC Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS, BASE_ID, 'Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_ID, 'Main'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_FTARGET, FS, 'FTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_FX, FS, JSON.stringify({ [FLD_FTARGET]: 5 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_FZ, FS, JSON.stringify({ [FLD_FTARGET]: 8 })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_FTARGET, foreignSheetId: FS }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_F, MS, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 3])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)', [MS, FLD_F, FLD_LU, MS])

    // N1: an unrelated record with a stale formula value — must stay untouched by other records' create.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_B, MS, JSON.stringify({ [FLD_F]: 999 })])

    // form view for C2
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
      [V_FORM, MS, V_FORM, 'form', '[]', JSON.stringify({ conjunction: 'and', conditions: [] }), JSON.stringify({})])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('C1: POST /records create computes formula-over-lookup (was uncomputed on create)', async () => {
    const res = await request(app).post('/api/multitable/records').send({ sheetId: MS, data: { [FLD_LINK]: [REC_FX] } })
    expect(res.status).toBe(200)
    const id = res.body.data.record.id
    expect(res.body.data.record.data[FLD_F]).toBe(6) // echo carries fresh formula (masked; field visible)
    expect(await formulaOf(id)).toBe(6) // DB-materialized, authoritative
  })

  test('N1 (boundary): creating a record does NOT recompute an unrelated record', async () => {
    // REC_B was seeded with a stale 999 and is unrelated to C1's new record.
    expect(await formulaOf(REC_B)).toBe(999) // untouched — create-recalc is scoped to the new record
  })

  test('C2: form-submit create computes against the ACTUAL lookup value (was raw recalc -> 0)', async () => {
    const res = await request(app).post(`/api/multitable/views/${V_FORM}/submit`).send({ data: { [FLD_LINK]: [REC_FX] } })
    expect(res.status).toBe(200)
    expect(res.body.data.mode).toBe('create')
    const id = res.body.data.record.id
    expect(res.body.data.record.data[FLD_F]).toBe(6) // echo: 6 (hydrated), not 1 (raw -> lookup absent -> 0)
    expect(await formulaOf(id)).toBe(6)
  })

  test('C3: import-xlsx inherits create-time formula-over-lookup recalc', async () => {
    // minimal fixture: one row, the link column (header auto-maps to the link field by name) -> REC_FZ (ftarget 8) -> formula 9
    const buffer = buildXlsxBuffer(xlsx, { sheetName: 'Rows', headers: ['Link'], rows: [[REC_FZ]] })
    const res = await request(app).post(`/api/multitable/sheets/${MS}/import-xlsx`).attach('file', buffer, 'rows.xlsx')
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)
    // the imported record is the only MS record whose formula resolves to 9 (REC_FZ.ftarget 8 + 1)
    const r = await q(`SELECT data FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = '9'`, [MS, FLD_F])
    expect((r.rows as any[]).length).toBe(1)
  })

  test('MASK: a field_permissions-denied formula field is OMITTED from both create echoes (D1 mask preserved)', async () => {
    // Deny FLD_F to this user. The formula still COMPUTES server-side (the record write is unchanged),
    // but the fresh value must NOT appear in the create / form-submit echo. The form-submit realtime
    // shares the SAME readableEchoFieldIds gate (formulaEcho is built in the same masked loop), so a
    // denied field is omitted from the broadcast by construction.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [MS, FLD_F, 'user', USER, false, false])

    const created = await request(app).post('/api/multitable/records').send({ sheetId: MS, data: { [FLD_LINK]: [REC_FX] } })
    expect(created.status).toBe(200)
    expect(created.body.data.record.data[FLD_F]).toBeUndefined() // POST /records echo: masked
    expect(await formulaOf(created.body.data.record.id)).toBe(6) // but still computed in the DB

    const submitted = await request(app).post(`/api/multitable/views/${V_FORM}/submit`).send({ data: { [FLD_LINK]: [REC_FX] } })
    expect(submitted.status).toBe(200)
    expect(submitted.body.data.record.data[FLD_F]).toBeUndefined() // form-submit echo: masked

    await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2', [MS, FLD_F]).catch(() => {})
  })
})
