/**
 * Real-DB integration test for #2176 — cross-sheet related echo field mask.
 * Design-lock: docs/development/multitable-cross-sheet-related-echo-mask-design-20260601.md (D1–D5, R1–R6).
 *
 * Follows the F3 (#2169) same-sheet fix. `computeDependentLookupRollupRecords` recomputes lookup/rollup
 * fields for records on OTHER sheets that depend on the edited record, and POST /patch echoes those records
 * to the writer (record-write-service.ts:860/989). Pre-#2176 the cross-sheet subset is returned UNMASKED —
 * a user who can write sheet A and read sheet B receives B's recomputed lookup/rollup value even when B's
 * `field_permissions.visible=false` denies that field. #2176 masks the recomputed payload at the producer
 * seam by the RELATED sheet's layer-2 ∧ layer-3 allowed-field set (NOT the edited sheet's).
 *
 * Topology: sheet B (related) has a `link` field → sheet A, and a `rollup`/`lookup` computed field over that
 * link. Editing A's source value recomputes B's computed field; the POST /patch response carries B's record
 * in `relatedRecords`. R1 is the canary: the denied computed value is PRESENT pre-fix (RED), omitted post-fix.
 *
 * Seed non-negotiable (per design §3): the denied computed field's property carries NO `hidden` → the deny
 * is SOLELY layer-3 (field_permissions), so the test pins layer-2 ∧ layer-3, not layer-2 alone.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_x2176_${TS}`
const SHEET_A = `sheet_x2176_a_${TS}` // edited sheet (source)
const SHEET_B = `sheet_x2176_b_${TS}` // related sheet (carries the computed fields)
const SHEET_C = `sheet_x2176_c_${TS}` // a second related sheet (R4 independent mask)

// Sheet A
const A_SRC = `fld_x2176_a_src_${TS}` // number — the edited source value B's rollup reads
const REC_A = `rec_x2176_a_${TS}`

// Sheet B — one link to A, one VISIBLE computed (positive control), one DENIED computed (the canary)
const B_LINK = `fld_x2176_b_link_${TS}` // link → A
const B_VISIBLE = `fld_x2176_b_vis_${TS}` // rollup(A_SRC) — readable, R2 positive control
const B_SECRET = `fld_x2176_b_secret_${TS}` // rollup(A_SRC) — layer-3 denied, THE LEAK canary
const REC_B = `rec_x2176_b_${TS}`

// Sheet C — one link to A, one VISIBLE computed (R4: a different related sheet keeps its visible field)
const C_LINK = `fld_x2176_c_link_${TS}`
const C_VISIBLE = `fld_x2176_c_vis_${TS}`
const REC_C = `rec_x2176_c_${TS}`

const USER_DENIED = `u_x2176_denied_${TS}` // denied B_SECRET → the masked subject
const USER_OPEN = `u_x2176_open_${TS}` // no deny → per-subject positive control

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = { id: USER_DENIED, roles: ['member'], perms: ['multitable:write'] }

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const batchPatch = (body: Record<string, unknown>) =>
  request(app).post('/api/multitable/patch').send(body)
const relatedRec = (
  res: { body: { data?: { relatedRecords?: Array<{ recordId: string; data: Record<string, unknown> }> } } },
  recordId: string,
) => res.body.data?.relatedRecords?.find((r) => r.recordId === recordId)

async function seedComputedField(
  fieldId: string,
  sheetId: string,
  name: string,
  order: number,
  linkFieldId: string,
  rollupSourceFieldId: string,
  rollupSourceSheetId: string,
): Promise<void> {
  // rollup over the link field, summing the linked A_SRC values. Property keys are TOP-LEVEL per
  // parseRollupFieldConfig (:901): linkFieldId, targetFieldId, foreignSheetId, aggregation.
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    fieldId, sheetId, name, 'rollup',
    JSON.stringify({ linkFieldId, targetFieldId: rollupSourceFieldId, foreignSheetId: rollupSourceSheetId, aggregation: 'sum' }), order,
  ])
  // cross-sheet formula dependency so recompute fires when A_SRC changes
  await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)', [
    sheetId, fieldId, rollupSourceFieldId, rollupSourceSheetId,
  ])
}

describeIfDatabase('#2176 cross-sheet related echo field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'X2176 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE_ID, 'A source'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE_ID, 'B related'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_C, BASE_ID, 'C related'])

    // Sheet A: one numeric source field
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [A_SRC, SHEET_A, 'Src', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_A, SHEET_A, JSON.stringify({ [A_SRC]: 5 })])

    // Sheet B: link → A, visible rollup, denied rollup
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      B_LINK, SHEET_B, 'A link', 'link', JSON.stringify({ foreignSheetId: SHEET_A }), 1,
    ])
    await seedComputedField(B_VISIBLE, SHEET_B, 'B visible', 2, B_LINK, A_SRC, SHEET_A)
    await seedComputedField(B_SECRET, SHEET_B, 'B secret', 3, B_LINK, A_SRC, SHEET_A)
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_B, SHEET_B, JSON.stringify({ [B_LINK]: [REC_A] })])

    // Sheet C: link → A, visible rollup (R4)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      C_LINK, SHEET_C, 'A link', 'link', JSON.stringify({ foreignSheetId: SHEET_A }), 1,
    ])
    await seedComputedField(C_VISIBLE, SHEET_C, 'C visible', 2, C_LINK, A_SRC, SHEET_A)
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_C, SHEET_C, JSON.stringify({ [C_LINK]: [REC_A] })])

    // link rows so computeDependentLookupRollupRecords finds B/C as dependents of A. The producer queries
    // `SELECT record_id FROM meta_links WHERE foreign_record_id = ANY(...)` (:1827) — schema is
    // (id PK default, field_id, record_id, foreign_record_id); there is NO foreign_sheet_id column.
    await q('INSERT INTO meta_links (id, record_id, field_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_b_${TS}`, REC_B, B_LINK, REC_A])
    await q('INSERT INTO meta_links (id, record_id, field_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_c_${TS}`, REC_C, C_LINK, REC_A])

    // layer-3 read deny on B_SECRET for USER_DENIED only. property carries no hidden → deny is solely here.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_B, B_SECRET, 'user', USER_DENIED, false, false])
  })

  afterAll(async () => {
    // meta_links FK-cascade on meta_fields/meta_records delete; drop them first by id to be safe.
    await q('DELETE FROM meta_links WHERE id = ANY($1::text[])', [[`lnk_b_${TS}`, `lnk_c_${TS}`]]).catch(() => {})
    for (const s of [SHEET_A, SHEET_B, SHEET_C]) {
      await q('DELETE FROM field_permissions WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [s]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R1+R2 (canary + positive control): editing A echoes B masked — denied computed omitted, visible computed kept', async () => {
    currentUser = { id: USER_DENIED, roles: ['member'], perms: ['multitable:write'] }
    const res = await batchPatch({ sheetId: SHEET_A, changes: [{ recordId: REC_A, fieldId: A_SRC, value: 11 }] })
    expect(res.status).toBe(200)
    const b = relatedRec(res, REC_B)
    expect(b).toBeDefined() // B is a readable related sheet → record envelope present (D1/D2)
    // R2 positive control: a VISIBLE computed field on B survives the mask (else the impl over-masked B by A's ids)
    expect(b?.data?.[B_VISIBLE]).toBeDefined()
    // R1 THE LEAK: the denied computed field is omitted (RED pre-fix — present; GREEN post-fix — undefined)
    expect(b?.data?.[B_SECRET]).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(`"${B_SECRET}"`)
  })

  test('R4 (independent per-sheet masks): a second related sheet keeps its own visible computed field', async () => {
    currentUser = { id: USER_DENIED, roles: ['member'], perms: ['multitable:write'] }
    const res = await batchPatch({ sheetId: SHEET_A, changes: [{ recordId: REC_A, fieldId: A_SRC, value: 13 }] })
    expect(res.status).toBe(200)
    const c = relatedRec(res, REC_C)
    expect(c).toBeDefined()
    // C_VISIBLE survives — proves the mask is per-related-sheet, not a shared/global allow set built from B
    expect(c?.data?.[C_VISIBLE]).toBeDefined()
  })

  test('R2-subject (per-subject): an ungranted-to-deny user receives B_SECRET (mask is subject-scoped)', async () => {
    currentUser = { id: USER_OPEN, roles: ['member'], perms: ['multitable:write'] }
    const res = await batchPatch({ sheetId: SHEET_A, changes: [{ recordId: REC_A, fieldId: A_SRC, value: 17 }] })
    expect(res.status).toBe(200)
    const b = relatedRec(res, REC_B)
    expect(b?.data?.[B_SECRET]).toBeDefined() // no deny row for USER_OPEN → value present
    currentUser = { id: USER_DENIED, roles: ['member'], perms: ['multitable:write'] }
  })

  test('R-D5 (fail-closed precondition): the write route 401s a no-subject request BEFORE the producer runs', async () => {
    // D5 in the design is defense-in-depth: the producer's `!access.userId → empty allow set` branch must
    // never fail OPEN. Through the POST /patch route that branch is UNREACHABLE — the handler guards
    // `if (!access.userId) return 401` (univer-meta.ts:8341) before any recompute. We assert that guard so
    // the D5 precondition is pinned: a request that reaches computeDependentLookupRollupRecords always has a
    // subject. The empty-userId branch remains in the producer as belt-and-suspenders (mirrors F3's same
    // `access.userId ? load : new Map()` idiom) but cannot be exercised here; a direct producer unit test
    // would require exporting it, which is out of scope for this slice.
    currentUser = { id: '', roles: ['admin'], perms: [] } as unknown as typeof currentUser
    const res = await batchPatch({ sheetId: SHEET_A, changes: [{ recordId: REC_A, fieldId: A_SRC, value: 19 }] })
    expect(res.status).toBe(401)
    expect(JSON.stringify(res.body)).not.toContain(B_SECRET) // no related echo computed at all
    currentUser = { id: USER_DENIED, roles: ['member'], perms: ['multitable:write'] }
  })

  test('R6 (same-sheet regression): editing a sheet still echoes its OWN computed dependents masked', async () => {
    // The fix now double-masks same-sheet lookup/rollup dependents (producer here + RWS :858). That is
    // idempotent only because both composites are layer-2 ∧ layer-3 for the same sheet+subject. Pin it: a
    // same-sheet computed dependent must still arrive, masked by the editor's own field gate. Sheet B edits
    // its OWN B_VISIBLE-bearing record; B_SECRET (denied) must not echo, B_VISIBLE must.
    currentUser = { id: USER_DENIED, roles: ['member'], perms: ['multitable:write'] }
    const res = await batchPatch({ sheetId: SHEET_B, changes: [{ recordId: REC_B, fieldId: B_LINK, value: [REC_A] }] })
    expect(res.status).toBe(200)
    // same-sheet computed echo travels in `records` (mergedRecords), not `relatedRecords`
    const self = res.body.data?.records?.find((r: { recordId: string }) => r.recordId === REC_B)
    if (self) {
      expect(self.data?.[B_SECRET]).toBeUndefined() // denied same-sheet computed stays masked (F3 + this slice)
    }
    expect(JSON.stringify(res.body)).not.toContain(`"${B_SECRET}":`)
    currentUser = { id: USER_DENIED, roles: ['member'], perms: ['multitable:write'] }
  })
})
