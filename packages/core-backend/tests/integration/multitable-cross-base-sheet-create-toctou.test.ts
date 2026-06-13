/**
 * ②a wall — §2a.4-c sheet-create TOCTOU close (real DB).
 *
 * The §2a.2 wall (`validateLinkFieldConfig`) only compares bases when BOTH sheets exist. When a link
 * field is created pointing at a foreign sheet id that does NOT exist yet, the wall returns null (the
 * Lane-1 review flagged this deferred-binding hole, `validateLinkFieldConfig` line ~1061). An attacker
 * can then materialize the silently-cross-base link from the OTHER side:
 *
 *   1. POST /fields a link in SHEET_A (base A) whose foreignSheetId = a not-yet-existent sheet id → 201
 *      (the wall no-ops: foreign sheet absent).
 *   2. POST /sheets with that exact caller-chosen id but baseId = base B → the link is now cross-base,
 *      and it never hit the wall.
 *
 * This lane closes the second step: POST /sheets (the caller-chosen-id + caller-chosen-baseId route,
 * univer-meta.ts ~6682) rejects (4xx) when creating this sheet would retroactively make an EXISTING
 * link field cross-base — i.e. some live link field's foreignSheetId equals the new sheet's id while
 * that field's source sheet is in a DIFFERENT base than the new sheet's baseId. Symmetric to the wall,
 * applied at sheet-create. Mirrors the wall's null-aware base compare (strict !==, null-vs-set counts)
 * and alias coverage (foreignSheetId / foreignDatasheetId / datasheetId via parseLinkFieldConfig).
 *
 * Status code mirrors the wall = 400 VALIDATION_ERROR (NOT the route's ValidationError→403 path).
 *
 * Real DB (describeIfDatabase). Drives the actual POST /api/multitable/fields + POST /api/multitable/sheets
 * wires (not hand-built helper calls — see the wire-vs-fixture rule).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_toctou_${TS}`

const BASE_A = `base_toctou_a_${TS}`
const BASE_B = `base_toctou_b_${TS}`
const SHEET_A = `sheet_toctou_a_${TS}` // source sheet, BASE_A

// Future (not-yet-existent) foreign target ids referenced by link fields created BEFORE the sheet exists.
const FUTURE_CROSS = `sheet_toctou_future_cross_${TS}` // will be created in BASE_B → cross-base
const FUTURE_SAME = `sheet_toctou_future_same_${TS}` // will be created in BASE_A → same-base
const FUTURE_NULL = `sheet_toctou_future_null_${TS}` // created with null base → cross-base vs set-base source
const FUTURE_ALIAS = `sheet_toctou_future_alias_${TS}` // referenced via the datasheetId alias

const FLD_CROSS = `fld_toctou_cross_${TS}`
const FLD_SAME = `fld_toctou_same_${TS}`
const FLD_NULL = `fld_toctou_null_${TS}`
const FLD_ALIAS = `fld_toctou_alias_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as { user?: unknown }).user = {
      id: userId,
      roles: ['member', 'admin'],
      perms: ['multitable:read', 'multitable:write'],
      permissions: ['multitable:read', 'multitable:write'],
      isAdmin: true,
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

const sheetExists = async (sheetId: string): Promise<boolean> => {
  const r = await q('SELECT id FROM meta_sheets WHERE id = $1', [sheetId])
  return (r.rows as unknown[]).length > 0
}

describeIfDatabase('②a wall — sheet-create TOCTOU close (§2a.4-c, real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'TOCTOU Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'TOCTOU Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Source A'])

    // Seed link fields whose foreignSheetId points at sheets that do NOT exist yet. These are created
    // directly via SQL: they model links written through the deferred-binding hole (the wall no-ops when
    // the foreign sheet is absent, so even via the route these would be accepted at 201).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_CROSS, SHEET_A, 'Link Future Cross', 'link', JSON.stringify({ foreignSheetId: FUTURE_CROSS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_SAME, SHEET_A, 'Link Future Same', 'link', JSON.stringify({ foreignSheetId: FUTURE_SAME }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NULL, SHEET_A, 'Link Future Null', 'link', JSON.stringify({ foreignSheetId: FUTURE_NULL }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_ALIAS, SHEET_A, 'Link Future Alias', 'link', JSON.stringify({ datasheetId: FUTURE_ALIAS }), 4])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_A]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, FUTURE_CROSS, FUTURE_SAME, FUTURE_NULL, FUTURE_ALIAS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // §2a.4-c (core): creating the future sheet in a DIFFERENT base than the existing link's source sheet
  // would materialize a silently-cross-base link → 4xx, sheet NOT created.
  test('TOCTOU: create future sheet in a DIFFERENT base (retroactive cross-base link) is rejected (4xx)', async () => {
    const res = await request(buildApp(USER)).post('/api/multitable/sheets').send({
      id: FUTURE_CROSS,
      baseId: BASE_B,
      name: 'Retroactive Cross Target',
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await sheetExists(FUTURE_CROSS)).toBe(false)
  })

  // §2a.4-c (omitted-baseId / legacy base): POST /sheets never assigns base_id = NULL — an omitted
  // baseId resolves to the fixed legacy base (ensureLegacyBase, DEFAULT_BASE_ID), which differs from
  // BASE_A. So FLD_NULL's source (BASE_A) vs the new sheet's legacy base = cross-base → reject. (The
  // pure null-base detection is covered in the helper unit test, since the wire can't create a
  // null-base sheet.)
  test('TOCTOU (omitted baseId → legacy base): retroactive cross-base via legacy base is rejected (4xx)', async () => {
    const res = await request(buildApp(USER)).post('/api/multitable/sheets').send({
      id: FUTURE_NULL,
      // No baseId → ensureLegacyBase assigns the legacy base, which is NOT BASE_A → cross-base for FLD_NULL.
      name: 'Legacy Base Target',
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await sheetExists(FUTURE_NULL)).toBe(false)
  })

  // §2a.4-c (alias): the guard must also fire when the existing link stored its target under an alias
  // (datasheetId / foreignDatasheetId) — a foreignSheetId-only scan would be trivially bypassable.
  test('TOCTOU (alias): create future sheet that retroactively crosses an aliased link is rejected (4xx)', async () => {
    const res = await request(buildApp(USER)).post('/api/multitable/sheets').send({
      id: FUTURE_ALIAS,
      baseId: BASE_B,
      name: 'Aliased Cross Target',
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await sheetExists(FUTURE_ALIAS)).toBe(false)
  })

  // §2a.4-c (compat): creating the future sheet in the SAME base as the link's source sheet is fine —
  // the guard must not over-reject a legitimate same-base deferred binding.
  test('TOCTOU compat: create future sheet in the SAME base succeeds (200)', async () => {
    const res = await request(buildApp(USER)).post('/api/multitable/sheets').send({
      id: FUTURE_SAME,
      baseId: BASE_A,
      name: 'Same Base Target',
    })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(await sheetExists(FUTURE_SAME)).toBe(true)
  })
})
