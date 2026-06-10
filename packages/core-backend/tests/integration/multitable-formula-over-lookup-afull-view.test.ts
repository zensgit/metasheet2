/**
 * A-full (formula-over-lookup foreign-record propagation, design #2410) — real-DB wire proof.
 *
 * Proves the bounded one-hop propagation through the actual PATCH write path:
 * editing a FOREIGN record's target field recomputes (and materializes) the formulas of the
 * related records whose lookup/rollup values changed — and ONLY those:
 *  - AF1: foreign target edit → related formula materialized fresh (flips A-min's T4a negative).
 *  - AF2: response echo masks the related formula per the related sheet's field-read gate,
 *    while the DB materialization stays reader-agnostic (full hydrated row, design §3.2).
 *  - AF3: editing an UNRELATED field on the foreign record does NOT rewrite the related
 *    formula — the affected-computed-id gate is target-field-aware (design §3.3).
 *  - AF4: per-related-sheet readability boundary — a sheet the actor cannot read is skipped
 *    (formula stays stale there), a readable one recomputes (design §3.4).
 *  - AF5: rollup-backed formulas recompute from the hydrated rollup value.
 *  - AF6: A-min same-record regression — a link edit on the related record itself still
 *    recomputes through the A-min path exactly as before.
 *
 * AF7 (create/submit/import regression) stays in multitable-formula-over-lookup-create-view
 * .test.ts; AF8 (no diff to src/formula/engine.ts / no migrations / no RBAC) is a static PR
 * boundary, not a runtime assertion.
 *
 * F1 guard (independent review of #2450): recompute must be restricted to the formulas the
 * dependency gate actually returns. M carries a SECOND, independent chain
 * (lu2 -> sheet G, f2 = {lu2}+1, seeded CORRECT at 8). A foreign edit on F must never rewrite
 * f2 — neither for an actor who cannot read G (pre-fix: actor-scoped hydration emptied lu2 and
 * persistently clobbered f2 to 1) nor for a full-perm actor (f2 simply does not depend on the
 * affected lookup).
 *
 * Stale seeding: related formulas are seeded as 6 (≠ current-value recompute results) so a
 * blind recompute (AF3) and a skipped recompute (AF4) are both distinguishable from a correct
 * one. Numeric semantics per A-min: lookup [9] + `={lu}+1` → 10; sum-rollup 9 + 1 → 10.
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml real-DB runner list.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_afull_${TS}`
const FS = `sheet_afull_foreign_${TS}` // foreign/source sheet
const MS = `sheet_afull_main_${TS}` // related: link + lookup + formula (readable in AF4)
const RS = `sheet_afull_rollup_${TS}` // related: link + rollup + formula (AF5)
const NS = `sheet_afull_noread_${TS}` // related: link + lookup + formula (unreadable in AF4)

const GS = `sheet_afull_other_${TS}` // second foreign sheet feeding M's INDEPENDENT chain (F1 guard)

const FLD_FTARGET = `fld_afull_ftarget_${TS}`
const FLD_FNOISE = `fld_afull_fnoise_${TS}`
const FLD_GVAL = `fld_afull_gval_${TS}`
const FLD_M_LINK = `fld_afull_m_link_${TS}`
const FLD_M_LU = `fld_afull_m_lu_${TS}`
const FLD_M_F = `fld_afull_m_f_${TS}`
const FLD_M_LINK2 = `fld_afull_m_link2_${TS}` // link -> GS (independent chain)
const FLD_M_LU2 = `fld_afull_m_lu2_${TS}` // lookup(GVal)
const FLD_M_F2 = `fld_afull_m_f2_${TS}` // formula = {lu2}+1, seeded CORRECT — must never be rewritten here
const FLD_R_LINK = `fld_afull_r_link_${TS}`
const FLD_R_RU = `fld_afull_r_ru_${TS}`
const FLD_R_F = `fld_afull_r_f_${TS}`
const FLD_N_LINK = `fld_afull_n_link_${TS}`
const FLD_N_LU = `fld_afull_n_lu_${TS}`
const FLD_N_F = `fld_afull_n_f_${TS}`

const REC_F1 = `rec_afull_f1_${TS}` // target = 9, the record edited throughout
const REC_F2 = `rec_afull_f2_${TS}` // target = 200, AF6 same-record re-link target
const REC_G1 = `rec_afull_g1_${TS}` // gval = 7 — never edited in this file
const REC_M1 = `rec_afull_m1_${TS}`
const REC_R1 = `rec_afull_r1_${TS}`
const REC_N1 = `rec_afull_n1_${TS}`

const USER_FULL = `u_afull_full_${TS}` // global multitable read+write
const USER_LIMITED = `u_afull_limited_${TS}` // sheet-scoped: F + M only (N, R unreadable)
const USER_MASKED = `u_afull_masked_${TS}` // global perms, but M's formula field is deny-masked

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: USER_FULL,
  roles: ['member'],
  perms: ['multitable:read', 'multitable:write'],
}

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const readField = async (recordId: string, sheetId: string, fieldId: string) => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
  const data = (r.rows as any[])[0]?.data
  const parsed = typeof data === 'string' ? JSON.parse(data) : data
  return parsed?.[fieldId]
}

const patchForeign = (fieldId: string, value: unknown) =>
  request(app).post('/api/multitable/patch').send({
    sheetId: FS,
    changes: [{ recordId: REC_F1, fieldId, value }],
  })

const related = (body: any, sheetId: string, recordId: string) =>
  body.data?.relatedRecords?.find((r: { sheetId: string; recordId: string }) => r.sheetId === sheetId && r.recordId === recordId)

describeIfDatabase('multitable formula-over-lookup A-full (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'A-full Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FS, BASE_ID, 'Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [MS, BASE_ID, 'Main Lookup'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [RS, BASE_ID, 'Rollup'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [NS, BASE_ID, 'No Read'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [GS, BASE_ID, 'Other Foreign'])

    // foreign sheet: numeric target + an unrelated noise field
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_FTARGET, FS, 'FTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_FNOISE, FS, 'FNoise', 'string', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_F1, FS, JSON.stringify({ [FLD_FTARGET]: 9, [FLD_FNOISE]: 'x' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_F2, FS, JSON.stringify({ [FLD_FTARGET]: 200 })])

    // second foreign sheet G: numeric value — feeds M's independent chain, never edited here
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_GVAL, GS, 'GVal', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_G1, GS, JSON.stringify({ [FLD_GVAL]: 7 })])

    // M: link -> FS, lookup(FTarget), formula = {lookup}+1 — seeded STALE (6)
    // PLUS an INDEPENDENT chain (F1 guard): link2 -> GS, lu2 = lookup(GVal), f2 = {lu2}+1 —
    // seeded CORRECT (7+1 = 8). Nothing in this file edits G, so f2 must remain 8 throughout.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_M_LINK, targetFieldId: FLD_FTARGET, foreignSheetId: FS }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_F, MS, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_M_LU}}+1` }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_LINK2, MS, 'Link G', 'link', JSON.stringify({ foreignSheetId: GS }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_LU2, MS, 'Lookup G', 'lookup', JSON.stringify({ linkFieldId: FLD_M_LINK2, targetFieldId: FLD_GVAL, foreignSheetId: GS }), 5])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_M_F2, MS, 'Formula G', 'formula', JSON.stringify({ expression: `={${FLD_M_LU2}}+1` }), 6])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_M1, MS, JSON.stringify({ [FLD_M_F]: 6, [FLD_M_F2]: 8 })])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_M_LINK, REC_M1, REC_F1])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_M_LINK2, REC_M1, REC_G1])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [MS, FLD_M_F, FLD_M_LU, MS])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [MS, FLD_M_F2, FLD_M_LU2, MS])

    // R: link -> FS, rollup sum(FTarget), formula = {rollup}+1 — seeded STALE (6)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_R_LINK, RS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_R_RU, RS, 'Rollup', 'rollup', JSON.stringify({ linkFieldId: FLD_R_LINK, targetFieldId: FLD_FTARGET, foreignSheetId: FS, aggregation: 'sum' }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_R_F, RS, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_R_RU}}+1` }), 3])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_R1, RS, JSON.stringify({ [FLD_R_F]: 6 })])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_R_LINK, REC_R1, REC_F1])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [RS, FLD_R_F, FLD_R_RU, RS])

    // N: link -> FS, lookup(FTarget), formula — seeded STALE (6); unreadable to USER_LIMITED
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_N_LINK, NS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_N_LU, NS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_N_LINK, targetFieldId: FLD_FTARGET, foreignSheetId: FS }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_N_F, NS, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_N_LU}}+1` }), 3])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_N1, NS, JSON.stringify({ [FLD_N_F]: 6 })])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_N_LINK, REC_N1, REC_F1])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [NS, FLD_N_F, FLD_N_LU, NS])

    // USER_LIMITED: sheet-scoped write on F (the edit) + M (the readable related sheet); no
    // grant on N/R and no global multitable perms → N and R are unreadable related sheets.
    await q('INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)',
      [FS, USER_LIMITED, 'user', USER_LIMITED, 'spreadsheet:write'])
    await q('INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)',
      [MS, USER_LIMITED, 'user', USER_LIMITED, 'spreadsheet:write'])

    // USER_MASKED: layer-3 field deny on M's formula field only.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [MS, FLD_M_F, 'user', USER_MASKED, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM formula_dependencies WHERE sheet_id = ANY($1::text[])', [[MS, RS, NS]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_M_LINK, FLD_M_LINK2, FLD_R_LINK, FLD_N_LINK]]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS, RS, NS, GS]]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS, RS, NS, GS]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[FS, MS, RS, NS, GS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[FS, MS, RS, NS, GS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[FS, MS, RS, NS, GS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('AF3: editing an UNRELATED foreign field does not rewrite related formulas (target-field-aware gate)', async () => {
    currentUser = { id: USER_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const res = await patchForeign(FLD_FNOISE, 'y')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // Stale seeds must survive untouched: a blind recompute would have produced 10 (9+1).
    expect(await readField(REC_M1, MS, FLD_M_F)).toBe(6)
    expect(await readField(REC_R1, RS, FLD_R_F)).toBe(6)
    expect(await readField(REC_N1, NS, FLD_N_F)).toBe(6)
    // The related echo always carries M for a full-perm actor; it must not carry a formula key.
    const m = related(res.body, MS, REC_M1)
    expect(m).toBeDefined()
    expect(m.data[FLD_M_F]).toBeUndefined()
  })

  test('AF4: readable related sheet recomputes, unreadable related sheets are skipped + unrelated formula untouched (F1 guard)', async () => {
    currentUser = { id: USER_LIMITED, roles: ['member'], perms: ['comments:write'] }
    const res = await patchForeign(FLD_FTARGET, 50)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // M is readable to USER_LIMITED → its formula recomputes: lookup [50] → 51.
    expect(await readField(REC_M1, MS, FLD_M_F)).toBe(51)
    // F1 guard (the exact review repro): USER_LIMITED cannot read G, so lu2 hydrates to [] for
    // this actor — but f2 does not depend on the affected lookup, so it must NOT be re-evaluated.
    // Pre-fix this clobbered the correct 8 to 1 (empty lookup → 0 → +1).
    expect(await readField(REC_M1, MS, FLD_M_F2)).toBe(8)
    // N and R are unreadable to USER_LIMITED → skipped under the related-recompute boundary:
    // formulas stay stale (6) and the sheets do not appear in the response at all.
    expect(await readField(REC_N1, NS, FLD_N_F)).toBe(6)
    expect(await readField(REC_R1, RS, FLD_R_F)).toBe(6)
    expect(related(res.body, NS, REC_N1)).toBeUndefined()
    expect(related(res.body, RS, REC_R1)).toBeUndefined()
  })

  test('AF1/AF2/AF5: foreign target edit materializes related formulas; echo is field-read masked', async () => {
    currentUser = { id: USER_MASKED, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const res = await patchForeign(FLD_FTARGET, 100)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    // AF1 (headline, flips A-min T4a): related lookup-backed formula materialized: [100] → 101.
    // Reader-agnostic: USER_MASKED cannot SEE FLD_M_F, but the DB recompute uses the full
    // hydrated row, not the actor's echo mask (design §3.2).
    expect(await readField(REC_M1, MS, FLD_M_F)).toBe(101)

    // AF5: rollup-backed formula recomputes from the hydrated rollup: sum(100)+1 → 101.
    expect(await readField(REC_R1, RS, FLD_R_F)).toBe(101)
    // N readable for this actor → catches up too.
    expect(await readField(REC_N1, NS, FLD_N_F)).toBe(101)

    // F1 guard (allowlist, not permission luck): USER_MASKED CAN read G, yet f2 still must not
    // be rewritten — it does not depend on the affected lookup, so the dependency gate excludes
    // it from recompute entirely.
    expect(await readField(REC_M1, MS, FLD_M_F2)).toBe(8)

    // AF2: the related echo for M carries the visible lookup but NOT the denied formula field.
    const m = related(res.body, MS, REC_M1)
    expect(m).toBeDefined()
    expect(m.data[FLD_M_LU]).toEqual([100])
    expect(m.data[FLD_M_F]).toBeUndefined()
    // The unrecomputed f2 must not ride along in the formula echo either.
    expect(m.data[FLD_M_F2]).toBeUndefined()

    // Positive echo control: R's formula field has no deny row → fresh value present in echo.
    const r = related(res.body, RS, REC_R1)
    expect(r).toBeDefined()
    expect(r.data[FLD_R_RU]).toBe(100)
    expect(r.data[FLD_R_F]).toBe(101)
  })

  test('AF6: A-min same-record regression — link edit on the related record still recomputes', async () => {
    currentUser = { id: USER_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const res = await request(app).post('/api/multitable/patch').send({
      sheetId: MS,
      changes: [{ recordId: REC_M1, fieldId: FLD_M_LINK, value: [REC_F2] }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // Same-record A-min path: lookup now [200] → formula 201, exactly as before A-full.
    expect(await readField(REC_M1, MS, FLD_M_F)).toBe(201)
    // F1 guard on the A-min path too: the link edit affects only lu1's chain; f2 stays put.
    expect(await readField(REC_M1, MS, FLD_M_F2)).toBe(8)
  })

  test('AF6b: A-min F1 guard is DISCRIMINATING — limited actor link edit cannot clobber the G-chain', async () => {
    // AF6 used USER_FULL, for whom a pre-fix all-formula recompute was value-idempotent (G readable
    // → f2 re-evaluates to the same 8). This variant is the airtight pin: USER_LIMITED (write on M,
    // NOTHING on G) edits M's link directly. Pre-fix, the A-min recompute would hydrate lu2 to []
    // for this actor and clobber f2 to 1; with the dependency allowlist f2 is not re-evaluated.
    currentUser = { id: USER_LIMITED, roles: ['member'], perms: ['comments:write'] }
    const res = await request(app).post('/api/multitable/patch').send({
      sheetId: MS,
      changes: [{ recordId: REC_M1, fieldId: FLD_M_LINK, value: [REC_F1] }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // Re-linked back to F1 (target = 100 since AF1) → f1 recomputes through A-min: [100] → 101.
    expect(await readField(REC_M1, MS, FLD_M_F)).toBe(101)
    // The independent G-chain survives a limited-actor same-record edit untouched.
    expect(await readField(REC_M1, MS, FLD_M_F2)).toBe(8)
  })
})
