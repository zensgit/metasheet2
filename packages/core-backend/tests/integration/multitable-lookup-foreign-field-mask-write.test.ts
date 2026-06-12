/**
 * §2a.3 write-sink (B1 review BLOCKER) — "denied write must not corrupt shared materialized
 * formula value".
 *
 * `applyLookupRollup` is reused on the WRITE path to hydrate the row the formula recompute
 * (Step 4c) evaluates against. The §2a.3 read-sink masks a lookup over an UNREADABLE foreign
 * field to `[]` — but on the WRITE path that masked `[]` flows into the formula recompute and
 * `recalculateRecordFromData` PERSISTS the permission-degraded value into shared
 * `meta_records.data`, which every privileged reader then sees.
 *
 * Invariant under test: a foreign-field-DENIED actor's write must NEVER change a materialized
 * formula value away from what an AUTHORIZED actor's identical write would produce. The fix is
 * write-side taint skip-recompute — formulas whose deps reach a masked lookup for the WRITING
 * actor are dropped from the recompute set, leaving the authorized stored value intact.
 *
 * Real DB (describeIfDatabase). Drives the actual POST /api/multitable/patch wire.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const DENY_USER = `u_fwd_${TS}` // denied on the cross-base foreign target field
const ALLOW_USER = `u_fwa_${TS}` // no field denial → authorized truth

const BASE_A = `base_fw_a_${TS}`
const BASE_B = `base_fw_b_${TS}`
const FS_X = `sheet_fw_fx_${TS}` // cross-base foreign sheet (BASE_B)
const MS = `sheet_fw_main_${TS}` // main source sheet (BASE_A)

const FLD_XTARGET = `fld_fw_xt_${TS}` // cross-base foreign target (denied for DENY_USER)
const FLD_LINK = `fld_fw_lk_${TS}`
const FLD_LU = `fld_fw_lu_${TS}` // lookup over the cross-base target
const FLD_F = `fld_fw_f_${TS}` // formula = {lookup}+1
const FLD_PLAIN = `fld_fw_p_${TS}` // a plain readable column (write that DOESN'T touch the link)

const REC_FX = `rec_fw_fx_${TS}` // XTARGET = 5
const REC_FY = `rec_fw_fy_${TS}` // XTARGET = 9

let app: Express
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = {
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

const readFormula = async (recordId: string) => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, MS])
  const data = (r.rows as any[])[0]?.data
  const parsed = typeof data === 'string' ? JSON.parse(data) : data
  return parsed?.[FLD_F]
}
const readVersion = async (recordId: string) => {
  const r = await q('SELECT version FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, MS])
  return Number((r.rows as any[])[0]?.version ?? 0)
}

// Fresh main record per case so each patch starts from a clean, identical seed.
async function seedMainRecord(recordId: string, seededFormula: number) {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    recordId,
    MS,
    JSON.stringify({ [FLD_LINK]: [REC_FX], [FLD_F]: seededFormula, [FLD_PLAIN]: 'p0' }),
  ])
  await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [
    `lnk_fw_${recordId}`,
    FLD_LINK,
    recordId,
    REC_FX,
  ])
}

describeIfDatabase('multitable formula-over-lookup foreign-field mask — write corruption (B1, real DB)', () => {
  beforeAll(async () => {
    app = buildApp(ALLOW_USER)

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'FW Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'FW Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS_X, BASE_B, 'Cross Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_A, 'Main Sheet'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_XTARGET, FS_X, 'XTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FX, FS_X, JSON.stringify({ [FLD_XTARGET]: 5 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FY, FS_X, JSON.stringify({ [FLD_XTARGET]: 9 })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS_X }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_F, MS, 'FormulaCol', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PLAIN, MS, 'PlainCol', 'string', '{}', 4])

    // formula depends on the lookup field (same sheet) — the taint edge.
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [MS, FLD_F, FLD_LU, MS])

    // field-level DENY for DENY_USER on the cross-base foreign target only.
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS_X, FLD_XTARGET, 'user', DENY_USER, false, false],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS_X, MS]]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // The control: an AUTHORIZED actor re-points the link FX(5)→FY(9). The formula MUST recompute
  // against the real lookup value 9 → 10. This is the "authorized truth" the denied actor must
  // not diverge from, AND it proves the write-side taint skip does NOT over-broadly suppress an
  // authorized recompute.
  test('control: AUTHORIZED actor link edit recomputes the formula to authorized truth (10)', async () => {
    const REC = `rec_fw_ctrl_${TS}`
    await seedMainRecord(REC, 6)
    const res = await request(buildApp(ALLOW_USER)).post('/api/multitable/patch').send({
      sheetId: MS,
      changes: [{ recordId: REC, fieldId: FLD_LINK, value: [REC_FY], expectedVersion: 1 }],
    })
    expect(res.status).toBe(200)
    expect(await readFormula(REC)).toBe(10) // authorized truth (lookup 9 + 1)
  })

  // B1 BLOCKER: the DENIED actor issues the IDENTICAL link edit FX(5)→FY(9). Pre-fix the masked
  // lookup []→{}+1 = 1 was persisted (DIVERGES from the authorized 10). The invariant: the denied
  // write must leave the materialized formula at the AUTHORIZED value (here: unchanged seed, since
  // the denied actor cannot legitimately recompute the foreign-derived formula).
  test('B1: DENIED actor link edit does NOT degrade the shared materialized formula value', async () => {
    const REC = `rec_fw_deny_${TS}`
    const SEED = 10 // = the authorized truth for an FY link, pre-materialized
    await seedMainRecord(REC, SEED)
    const res = await request(buildApp(DENY_USER)).post('/api/multitable/patch').send({
      sheetId: MS,
      changes: [{ recordId: REC, fieldId: FLD_LINK, value: [REC_FY], expectedVersion: 1 }],
    })
    expect(res.status).toBe(200)
    // The denied actor must NOT have overwritten the shared formula with the masked value (1).
    expect(await readFormula(REC)).not.toBe(1)
    // Invariant: the materialized value stays the authorized truth.
    expect(await readFormula(REC)).toBe(SEED)
  })

  // Even when the denied actor's edit does not touch the link at all (writes only the plain
  // column), the formula must not be recomputed against a masked lookup. (The link is unchanged,
  // so the authorized value is unchanged — a degraded recompute here would be pure corruption.)
  test('B1: DENIED actor non-link edit leaves the materialized formula untouched', async () => {
    const REC = `rec_fw_deny2_${TS}`
    const SEED = 6
    await seedMainRecord(REC, SEED)
    const res = await request(buildApp(DENY_USER)).post('/api/multitable/patch').send({
      sheetId: MS,
      changes: [{ recordId: REC, fieldId: FLD_PLAIN, value: 'p1', expectedVersion: 1 }],
    })
    expect(res.status).toBe(200)
    expect(await readFormula(REC)).toBe(SEED) // unchanged
    expect(await readVersion(REC)).toBeGreaterThan(0)
  })
})
