/**
 * §2a.3 read/JSON sink — "lookup foreign-field-level over-read" (GA-T2a).
 *
 * applyLookupRollup gated only whether the FOREIGN SHEET was readable, then read
 * data[targetFieldId] RAW — no foreign-FIELD-level permission check. A lookup column
 * therefore leaked a foreign field the actor is explicitly DENIED at field level.
 *
 * Ratified contract (design §2a.3): for a lookup whose foreign target field the actor
 * cannot read —
 *   - cross-base (foreign base_id ≠ source base_id): MASK UNCONDITIONALLY.
 *   - same-base: MASK BY DEFAULT, unless the lookup config carries skipForeignFieldMasking.
 *   - readable foreign field: value flows normally (no change).
 * "MASK" = the lookup value never reaches data[fieldId] (empty), so it's absent from JSON.
 *
 * Real DB (describeIfDatabase): the field-permission scope-map load hits several real
 * tables (field_permissions, user_roles, platform_member_group_members). Asserts the bug
 * through the actual /view grid read wire.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_ffm_${TS}` // non-admin member with multitable:read

// Two bases to exercise cross-base vs same-base.
const BASE_A = `base_ffm_a_${TS}`
const BASE_B = `base_ffm_b_${TS}`

// CROSS-BASE foreign sheet (in BASE_B) + a same-base foreign sheet (in BASE_A).
const FS_X = `sheet_ffm_fx_${TS}` // cross-base foreign sheet (BASE_B)
const FS_S = `sheet_ffm_fs_${TS}` // same-base foreign sheet (BASE_A)
const MS = `sheet_ffm_main_${TS}` // main source sheet (BASE_A) carrying lookups

// foreign target fields (denied for USER)
const FLD_XTARGET = `fld_ffm_xt_${TS}` // cross-base denied target
const FLD_STARGET = `fld_ffm_st_${TS}` // same-base denied target
const FLD_SOK = `fld_ffm_sok_${TS}` // same-base READABLE target (regression baseline)

// main sheet fields
const FLD_LINK_X = `fld_ffm_lx_${TS}`
const FLD_LINK_S = `fld_ffm_ls_${TS}`
const FLD_LU_X = `fld_ffm_lux_${TS}` // lookup over cross-base denied target
const FLD_LU_S_DEFAULT = `fld_ffm_lusd_${TS}` // lookup over same-base denied target (default → mask)
const FLD_LU_S_OPTOUT = `fld_ffm_luso_${TS}` // lookup over same-base denied target WITH opt-out
const FLD_LU_OK = `fld_ffm_luok_${TS}` // lookup over readable same-base target (must stay present)
const FLD_ROLL_X_COUNT = `fld_ffm_rxc_${TS}` // count rollup over cross-base denied target
const FLD_ROLL_OK_COUNT = `fld_ffm_rok_${TS}` // count rollup over readable same-base target

const REC_FX = `rec_ffm_fx_${TS}` // cross-base foreign record (XTARGET = 7)
const REC_FS = `rec_ffm_fs_${TS}` // same-base foreign record (STARGET = 11, SOK = 13)
const REC_M = `rec_ffm_m_${TS}` // main record linking to both
const REC_M_EMPTY = `rec_ffm_me_${TS}` // main record with no links; readable count rollup must be 0

let app: Express
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const readRowData = async (): Promise<Record<string, unknown>> => {
  const res = await request(app).get('/api/multitable/view').query({ sheetId: MS })
  expect(res.status).toBe(200)
  const rows = res.body?.data?.rows as Array<{ id: string; data: Record<string, unknown> }>
  const row = rows.find((r) => r.id === REC_M)
  expect(row).toBeDefined()
  return row!.data
}

const readEmptyRowData = async (): Promise<Record<string, unknown>> => {
  // Read only the empty-link row so another row in the same response cannot prime the foreign-sheet
  // readability set. A readable count rollup with no links must still be a concrete 0.
  const res = await request(app).get(`/api/multitable/records/${REC_M_EMPTY}`).query({ sheetId: MS })
  expect(res.status).toBe(200)
  const row = res.body?.data?.record as { id: string; data: Record<string, unknown> } | undefined
  expect(row).toBeDefined()
  expect(row!.id).toBe(REC_M_EMPTY)
  return row!.data
}

describeIfDatabase('multitable lookup foreign-field mask — read/JSON (GA-T2a, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = { id: USER, roles: ['member'], perms: ['multitable:read'], permissions: ['multitable:read'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'FFM Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'FFM Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS_X, BASE_B, 'Cross Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS_S, BASE_A, 'Same Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_A, 'Main Sheet'])

    // cross-base foreign sheet: one numeric target (denied for USER)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_XTARGET, FS_X, 'XTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FX, FS_X, JSON.stringify({ [FLD_XTARGET]: 7 })])

    // same-base foreign sheet: denied target + readable target
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_STARGET, FS_S, 'STarget', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_SOK, FS_S, 'SOk', 'number', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FS, FS_S, JSON.stringify({ [FLD_STARGET]: 11, [FLD_SOK]: 13 })])

    // main sheet: two link fields + four lookups
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK_X, MS, 'LinkX', 'link', JSON.stringify({ foreignSheetId: FS_X }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK_S, MS, 'LinkS', 'link', JSON.stringify({ foreignSheetId: FS_S }), 2])
    // cross-base lookup over a denied target → MUST mask unconditionally
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU_X, MS, 'LookupX', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK_X, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X }), 3])
    // same-base lookup over a denied target, DEFAULT → MUST mask
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU_S_DEFAULT, MS, 'LookupSDefault', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK_S, targetFieldId: FLD_STARGET, foreignSheetId: FS_S }), 4])
    // same-base lookup over a denied target, OPT-OUT → value present
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU_S_OPTOUT, MS, 'LookupSOptout', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK_S, targetFieldId: FLD_STARGET, foreignSheetId: FS_S, skipForeignFieldMasking: true }), 5])
    // same-base lookup over a READABLE target → value present (no regression)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU_OK, MS, 'LookupOk', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK_S, targetFieldId: FLD_SOK, foreignSheetId: FS_S }), 6])
    // count rollup over a denied target must not emit a concrete 0: null means masked/no visible value.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_ROLL_X_COUNT, MS, 'RollupXCount', 'rollup', JSON.stringify({ linkFieldId: FLD_LINK_X, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X, aggregation: 'count' }), 7])
    // count rollup over a readable target remains a concrete count.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_ROLL_OK_COUNT, MS, 'RollupOkCount', 'rollup', JSON.stringify({ linkFieldId: FLD_LINK_S, targetFieldId: FLD_SOK, foreignSheetId: FS_S, aggregation: 'count' }), 8])

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_M, MS, JSON.stringify({ [FLD_LINK_X]: [REC_FX], [FLD_LINK_S]: [REC_FS] })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_M_EMPTY, MS, JSON.stringify({})])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
      [`lnk_x_${TS}`, FLD_LINK_X, REC_M, REC_FX])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
      [`lnk_s_${TS}`, FLD_LINK_S, REC_M, REC_FS])

    // USER carries multitable:read as a token claim → base canRead is true GLOBALLY, so every
    // sheet (incl. the foreign sheets) is sheet-level readable without explicit grants. The bug
    // requires exactly this: the foreign SHEET readable but the foreign FIELD denied.

    // field-level DENY for USER on the two denied targets (cross-base + same-base).
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS_X, FLD_XTARGET, 'user', USER, false, false],
    )
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS_S, FLD_STARGET, 'user', USER, false, false],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS_X, FS_S, MS]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE record_id = $1', [REC_M]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS_X, FS_S]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS_X, FS_S]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS_X, FS_S]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('cross-base lookup of a DENIED foreign field is MASKED (absent/empty) in the read JSON', async () => {
    const data = await readRowData()
    // value 7 must never surface; masked lookup → empty.
    const v = data[FLD_LU_X]
    expect(Array.isArray(v) ? v : [v].filter((x) => x !== null && x !== undefined)).toEqual([])
  })

  test('same-base lookup of a DENIED foreign field is MASKED BY DEFAULT', async () => {
    const data = await readRowData()
    const v = data[FLD_LU_S_DEFAULT]
    expect(Array.isArray(v) ? v : [v].filter((x) => x !== null && x !== undefined)).toEqual([])
  })

  test('same-base lookup with skipForeignFieldMasking opt-out PRESERVES the denied value (deliberate projection)', async () => {
    const data = await readRowData()
    expect(data[FLD_LU_S_OPTOUT]).toEqual([11])
  })

  test('lookup of a READABLE foreign field is unaffected (no regression)', async () => {
    const data = await readRowData()
    expect(data[FLD_LU_OK]).toEqual([13])
  })

  test('count rollup over a DENIED foreign field is masked as null, not a concrete zero', async () => {
    const data = await readRowData()
    expect(data[FLD_ROLL_X_COUNT]).toBeNull()
  })

  test('count rollup over a READABLE foreign field still returns a concrete count', async () => {
    const data = await readRowData()
    expect(data[FLD_ROLL_OK_COUNT]).toBe(1)
  })

  test('count rollup over a READABLE foreign field with no links returns concrete zero', async () => {
    const data = await readEmptyRowData()
    expect(data[FLD_ROLL_OK_COUNT]).toBe(0)
  })
})
