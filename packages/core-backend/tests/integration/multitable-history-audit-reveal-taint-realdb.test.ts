/**
 * A2 D6 — History field-audit reveal does NOT lift formula-taint (real DB).
 *
 * Design-lock: docs/development/multitable-history-field-audit-permission-design-lock-20260620.md (#2973).
 * The reveal lifts the per-subject `field_permissions` scope ONLY. A formula column whose cross-base lookup
 * input is denied to the actor is "tainted" — masked by `maskStoredRecordFieldIds`, NOT by a local
 * field_permission. D6 requires that masking to SURVIVE a reveal (else a reveal-holder could read a
 * materialized foreign-derived value they are denied). This was previously asserted structurally (the taint
 * resolver derives foreign-denial independently via resolveForeignFieldReadability); this golden pins it on
 * the wire. Fixture models multitable-lookup-foreign-field-mask-sibling-reads.test.ts.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_A = `base_rvt_a_${TS}` // history base
const BASE_B = `base_rvt_b_${TS}` // cross-base foreign
const FS_X = `sheet_rvt_fx_${TS}` // foreign sheet (BASE_B)
const MS = `sheet_rvt_main_${TS}` // history sheet (BASE_A)
const FLD_XTARGET = `fld_rvt_xt_${TS}` // foreign target, denied to DENY_VIEWER
const FLD_LINK = `fld_rvt_lk_${TS}`
const FLD_LU = `fld_rvt_lu_${TS}` // lookup over the foreign target
const FLD_F = `fld_rvt_f_${TS}` // formula = {lookup}+1, materialized = 8 (TAINTED for DENY_VIEWER)
const FLD_STATUS = `fld_rvt_st_${TS}` // plain visible column (control)
const REC_FX = `rec_rvt_fx_${TS}`
const REC_M1 = `rec_rvt_m1_${TS}`
const TAINT_BATCH = `batch_rvt_${TS}` // a revision touching FLD_F + FLD_STATUS
const DENY_VIEWER = `user_rvt_deny_${TS}` // denied the foreign target → FLD_F tainted
const ALLOW_VIEWER = `user_rvt_allow_${TS}` // no denial → sees FLD_F (non-vacuous control)
const ISSUER = `user_rvt_issuer_${TS}`
const FORMULA_VALUE = 8

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)

function appAs(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:base:read'] }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}
const detail = (app: Express, batchId: string, query: Record<string, unknown> = {}) =>
  request(app).get(`/api/multitable/bases/${BASE_A}/history/events/${batchId}`).query(query)
type Change = { recordId: string; changedFieldIds: string[]; after: Record<string, unknown> | null }
const changeFor = (res: { body?: { data?: { changes?: Change[] } } }) =>
  (res.body?.data?.changes ?? []).find((c) => c.recordId === REC_M1)

describeIfDatabase('history field-audit reveal — D6: taint is NOT lifted by reveal (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_A, 'RVT A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_B, 'RVT B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FS_X, BASE_B, 'RVT Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [MS, BASE_A, 'RVT Main'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_XTARGET, FS_X, 'XTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_FX, FS_X, JSON.stringify({ [FLD_XTARGET]: 7 })])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS_X }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_F, MS, 'FormulaCol', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_STATUS, MS, 'Status', 'string', '{}', 4])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_M1, MS, JSON.stringify({ [FLD_LINK]: [REC_FX], [FLD_F]: FORMULA_VALUE, [FLD_STATUS]: 'public' })])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_rvt_${TS}`, FLD_LINK, REC_M1, REC_FX])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)', [MS, FLD_F, FLD_LU, MS])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [FS_X, FLD_XTARGET, 'user', DENY_VIEWER, false, false])
    for (const uid of [DENY_VIEWER, ALLOW_VIEWER, ISSUER]) {
      await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [uid])
    }
    // A revision on REC_M1 touching the formula column + the plain column.
    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
       VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', $3, ARRAY[$4,$5]::text[], '{}'::jsonb, $6::jsonb, $7)`,
      [MS, REC_M1, ISSUER, FLD_F, FLD_STATUS, JSON.stringify({ [FLD_F]: FORMULA_VALUE, [FLD_STATUS]: 'public' }), TAINT_BATCH],
    )
    // A valid field-audit grant for DENY_VIEWER on BASE_A, issued by ISSUER (granted_by != viewer).
    await q(
      `INSERT INTO meta_history_audit_grants (base_id, subject_type, subject_id, granted_by, reason, expires_at, is_standing)
       VALUES ($1,'user',$2,$3,'seed', $4, false)`,
      [BASE_A, DENY_VIEWER, ISSUER, new Date(TS + 30 * 86400000).toISOString()],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM meta_history_audit_grants WHERE base_id = $1', [BASE_A]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS_X, MS]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[DENY_VIEWER, ALLOW_VIEWER, ISSUER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('control (non-vacuous): a viewer NOT denied the foreign field sees the formula column in history', async () => {
    const d = await detail(appAs(ALLOW_VIEWER), TAINT_BATCH)
    expect(d.status).toBe(200)
    const c = changeFor(d)
    expect(c?.changedFieldIds).toContain(FLD_F) // formula genuinely changed + visible when not tainted
    expect(c?.after?.[FLD_F]).toBe(FORMULA_VALUE)
  })

  test('taint baseline (no reveal): the denied viewer sees the formula column MASKED (taint)', async () => {
    const d = await detail(appAs(DENY_VIEWER), TAINT_BATCH)
    expect(d.status).toBe(200)
    const c = changeFor(d)
    expect(c?.changedFieldIds).not.toContain(FLD_F) // tainted (its lookup reads a denied foreign field)
    expect(c?.after?.[FLD_F]).toBeUndefined()
    expect(c?.changedFieldIds).toContain(FLD_STATUS) // plain column still visible
  })

  test('D6: reveal does NOT lift the formula-taint — the tainted column stays masked even under ?reveal=1', async () => {
    const d = await detail(appAs(DENY_VIEWER), TAINT_BATCH, { reveal: '1', reason: 'taint-audit' })
    expect(d.status).toBe(200)
    const c = changeFor(d)
    // reveal lifts the per-subject field_permissions scope, NOT the cross-sheet formula-taint:
    expect(c?.changedFieldIds).not.toContain(FLD_F) // STILL masked under reveal
    expect(c?.after?.[FLD_F]).toBeUndefined() // the foreign-derived value never leaks
    expect(c?.changedFieldIds).toContain(FLD_STATUS) // and the plain column is still there (reveal didn't break the read)
  })
})
