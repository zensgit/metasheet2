/**
 * ②a wall — §2a.2 link-base validation (real DB).
 *
 * A peer multitable enforces *base* as a real governance boundary: a link field cannot silently
 * span two bases. Today the backend accepts ANY `foreignSheetId` regardless of base ("no cross-base"
 * is only a UI convention). §2a.3 (merged) closed the over-READ leak. This lane closes the STRUCTURAL
 * hole: you can't even CREATE a silently-cross-base link.
 *
 * The wall (`validateLinkFieldConfig`) fires at the two field-DEFINITION chokepoints — POST /fields
 * (create) and PATCH /fields/:fieldId (update) — that already host validateLookupRollupConfig. When a
 * link field's payload explicitly carries a foreign-sheet key (foreignSheetId / foreignDatasheetId /
 * datasheetId — the parseLinkFieldConfig aliases), it loads the SOURCE sheet's base_id and the FOREIGN
 * sheet's base_id and rejects with a 4xx (VALIDATION_ERROR) when they differ — INCLUDING null-vs-set
 * (strict ===). Zero opt-out: the explicit `foreignBaseId` cross-base path is ②b, a later lane.
 *
 * Compat (GA-T4b): validation fires ONLY when the payload carries a foreign-sheet key — a rename-only
 * PATCH on a pre-existing (possibly legacy cross-base) link field must NOT be retroactively rejected.
 *
 * Real DB (describeIfDatabase). Drives the actual POST /api/multitable/fields +
 * PATCH /api/multitable/fields/:fieldId wires (not hand-built helper calls — see the wire-vs-fixture rule).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_xbw_${TS}`

const BASE_A = `base_xbw_a_${TS}`
const BASE_B = `base_xbw_b_${TS}`
const SHEET_A = `sheet_xbw_a_${TS}` // source sheet, BASE_A
const SHEET_A2 = `sheet_xbw_a2_${TS}` // same-base foreign target, BASE_A
const SHEET_B = `sheet_xbw_b_${TS}` // cross-base foreign target, BASE_B
const SHEET_NULL = `sheet_xbw_null_${TS}` // null base_id (legacy-style), no base

const FLD_PRE = `fld_xbw_pre_${TS}` // pre-existing cross-base link (seeded via SQL, bypasses the wall)

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as { user?: unknown }).user = {
      id: userId,
      roles: ['member'],
      perms: ['multitable:read', 'multitable:write'],
      permissions: ['multitable:read', 'multitable:write'],
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

const fieldExists = async (fieldId: string): Promise<boolean> => {
  const r = await q('SELECT id FROM meta_fields WHERE id = $1', [fieldId])
  return (r.rows as unknown[]).length > 0
}

describeIfDatabase('②a wall — cross-base link validation (§2a.2, real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'XBW Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'XBW Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Source A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A2, BASE_A, 'Foreign A2'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_B, BASE_B, 'Foreign B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, NULL, $2)', [SHEET_NULL, 'Foreign Null'])

    // A pre-existing cross-base link field, seeded directly via SQL (bypasses the wall) — models a
    // legacy field created before the wall landed. GA-T4b PATCHes it WITHOUT a foreign key.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PRE, SHEET_A, 'Legacy Cross Link', 'link', JSON.stringify({ foreignSheetId: SHEET_B }), 1])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_A2, SHEET_B, SHEET_NULL]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_A2, SHEET_B, SHEET_NULL]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // GA-T1: create a link field whose foreignSheetId is a sheet in a DIFFERENT base → 4xx, NOT created.
  test('GA-T1: CREATE a cross-base link field is rejected (4xx) and the field is not created', async () => {
    const fieldId = `fld_xbw_t1_${TS}`
    const res = await request(buildApp(USER)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Cross Link',
      type: 'link',
      property: { foreignSheetId: SHEET_B },
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await fieldExists(fieldId)).toBe(false)
  })

  // GA-T1 (null-vs-set): a SET-base source linking to a NULL-base foreign sheet is also cross-base.
  test('GA-T1 (null-vs-set): CREATE a link to a null-base foreign sheet is rejected (4xx)', async () => {
    const fieldId = `fld_xbw_t1null_${TS}`
    const res = await request(buildApp(USER)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Null Base Link',
      type: 'link',
      property: { foreignSheetId: SHEET_NULL },
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await fieldExists(fieldId)).toBe(false)
  })

  // GA-T1b: PATCH a link field config with a cross-base foreignSheetId in the payload → 4xx.
  test('GA-T1b: PATCH a link config to a cross-base foreignSheetId is rejected (4xx)', async () => {
    // Seed a same-base link field, then PATCH it to point cross-base.
    const fieldId = `fld_xbw_t1b_${TS}`
    await request(buildApp(USER)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Same Link',
      type: 'link',
      property: { foreignSheetId: SHEET_A2 },
    }).expect(201)

    const res = await request(buildApp(USER))
      .patch(`/api/multitable/fields/${fieldId}`)
      .send({ property: { foreignSheetId: SHEET_B } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    // The stored config must NOT have been mutated to the cross-base target.
    const r = await q('SELECT property FROM meta_fields WHERE id = $1', [fieldId])
    const property = (r.rows as Array<{ property: unknown }>)[0]?.property
    const parsed = typeof property === 'string' ? JSON.parse(property) : property
    expect(parsed?.foreignSheetId).toBe(SHEET_A2)
  })

  // GA-T1b (alias): the wall must also fire when the cross-base target is sent under a foreign-sheet
  // ALIAS (foreignDatasheetId / datasheetId) — a presence gate that only checked `foreignSheetId`
  // would be trivially bypassable.
  test('GA-T1b (alias): CREATE a cross-base link via the datasheetId alias is rejected (4xx)', async () => {
    const fieldId = `fld_xbw_t1balias_${TS}`
    const res = await request(buildApp(USER)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Alias Cross Link',
      type: 'link',
      property: { datasheetId: SHEET_B },
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await fieldExists(fieldId)).toBe(false)
  })

  // GA-T4 (regression): a same-base link field succeeds (no over-rejection).
  test('GA-T4: CREATE a same-base link field succeeds (201)', async () => {
    const fieldId = `fld_xbw_t4_${TS}`
    const res = await request(buildApp(USER)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Same Base Link',
      type: 'link',
      property: { foreignSheetId: SHEET_A2 },
    })

    expect(res.status).toBe(201)
    expect(await fieldExists(fieldId)).toBe(true)
  })

  // GA-T4b (compat): a rename-only PATCH on a PRE-EXISTING (legacy cross-base) link field — the
  // payload carries NO foreign-sheet key — must NOT be retroactively rejected.
  test('GA-T4b: rename-only PATCH on a pre-existing cross-base link field succeeds (200)', async () => {
    const res = await request(buildApp(USER))
      .patch(`/api/multitable/fields/${FLD_PRE}`)
      .send({ name: 'Renamed Legacy Link' })

    expect(res.status).toBe(200)
    const r = await q('SELECT name, property FROM meta_fields WHERE id = $1', [FLD_PRE])
    const row = (r.rows as Array<{ name: string; property: unknown }>)[0]
    expect(row?.name).toBe('Renamed Legacy Link')
    // The legacy cross-base config is preserved, not coerced.
    const parsed = typeof row?.property === 'string' ? JSON.parse(row.property) : row?.property
    expect(parsed?.foreignSheetId).toBe(SHEET_B)
  })

  // GA-T1c (type-conversion bypass): the wall must fire on a non-link → link conversion even when the
  // PATCH carries NO foreign key. POST a `string` field with a cross-base foreignSheetId stashed in its
  // property (the wall no-ops for non-link), then PATCH `{type:'link'}` with no property — `nextProperty`
  // falls back to the stored cross-base target. Without the conversion clause this materialized a
  // silently-cross-base link that never hit the wall.
  test('GA-T1c: converting a string field (with a stashed cross-base target) to link is rejected (4xx)', async () => {
    const fieldId = `fld_xbw_t1c_${TS}`
    // Step 1: a string field can carry an arbitrary property; the wall no-ops for non-link types.
    await request(buildApp(USER)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Stashed Cross Target',
      type: 'string',
      property: { foreignSheetId: SHEET_B },
    }).expect(201)

    // Step 2: convert to link with NO property in the payload — the gate must still fire on the conversion.
    const res = await request(buildApp(USER))
      .patch(`/api/multitable/fields/${fieldId}`)
      .send({ type: 'link' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    // The field must NOT have been converted into a cross-base link.
    const r = await q('SELECT type FROM meta_fields WHERE id = $1', [fieldId])
    expect((r.rows as Array<{ type: string }>)[0]?.type).toBe('string')
  })

  // GA-T4c (conversion compat): a non-link → link conversion whose effective target is SAME-base must
  // still succeed — the conversion clause must not over-reject legitimate conversions.
  test('GA-T4c: converting a string field (same-base stashed target) to link succeeds (200)', async () => {
    const fieldId = `fld_xbw_t4c_${TS}`
    await request(buildApp(USER)).post('/api/multitable/fields').send({
      sheetId: SHEET_A,
      id: fieldId,
      name: 'Stashed Same Target',
      type: 'string',
      property: { foreignSheetId: SHEET_A2 },
    }).expect(201)

    const res = await request(buildApp(USER))
      .patch(`/api/multitable/fields/${fieldId}`)
      .send({ type: 'link' })

    expect(res.status).toBe(200)
    const r = await q('SELECT type FROM meta_fields WHERE id = $1', [fieldId])
    expect((r.rows as Array<{ type: string }>)[0]?.type).toBe('link')
  })
})
