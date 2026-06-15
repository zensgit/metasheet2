/**
 * §2a.3 export sink — "formula-over-lookup foreign-field-level over-read" (GA-T2b).
 *
 * Formula values ARE materialized into meta_records.data (record-write-service). The
 * export-xlsx path reads those materialized values WITHOUT calling applyLookupRollup, so
 * a formula referencing a cross-base lookup of an UNREADABLE foreign field exports the
 * value — the read-sink fix (which only runs on the computed-on-read path) does not cover
 * export.
 *
 * Contract (design §2a.3, export consistent with read): when a formula field DEPENDS on a
 * lookup/rollup whose foreign target field is masked for the exporting actor (cross-base
 * unconditional / same-base default unless opt-out), the WHOLE formula column is removed
 * from the export (fail-closed, consistent with existing field-level export masking).
 *
 * Real DB (describeIfDatabase). Asserts through the actual export-xlsx wire.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import * as XLSX from 'xlsx'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const DENY_USER = `u_fexd_${TS}` // denied on the foreign target
const ALLOW_USER = `u_fexa_${TS}` // no field denial → sees the formula column

const BASE_A = `base_fex_a_${TS}`
const BASE_B = `base_fex_b_${TS}`
const FS_X = `sheet_fex_fx_${TS}` // cross-base foreign sheet (BASE_B)
const MS = `sheet_fex_main_${TS}` // main source sheet (BASE_A)

const FLD_XTARGET = `fld_fex_xt_${TS}` // cross-base foreign target (denied for DENY_USER)
const FLD_LINK = `fld_fex_lk_${TS}`
const FLD_LU = `fld_fex_lu_${TS}` // lookup over the cross-base target
const FLD_F = `fld_fex_f_${TS}` // formula = {lookup}+1, materialized to 8
const FLD_PLAIN = `fld_fex_p_${TS}` // a plain readable column (export control)

const REC_FX = `rec_fex_fx_${TS}` // XTARGET = 7
const REC_M = `rec_fex_m_${TS}` // formula materialized = 8, plain = 'visible'

let app: Express
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    // ②b: this suite's foreign sheet is cross-base; grant `multitable:base:read` so the actor clears
    // the new §3.2 coarse base-read gate and these tests keep isolating FIELD-level masking (the DENY
    // cases stay masked by the field gate, non-vacuously). The base-gate axis is covered by the
    // dedicated XB-2* canaries in multitable-cross-base-link-optin.test.ts.
    ;(req as any).user = { id: userId, roles: ['member'], perms: ['multitable:read', 'multitable:base:read'], permissions: ['multitable:read', 'multitable:base:read'] }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

async function exportGrid(targetApp: Express, fieldIds?: string): Promise<string[][]> {
  const url = `/api/multitable/sheets/${MS}/export-xlsx${fieldIds !== undefined ? `?fieldIds=${encodeURIComponent(fieldIds)}` : ''}`
  const res = await request(targetApp)
    .get(url)
    .buffer(true)
    .parse((r, callback) => {
      const chunks: Buffer[] = []
      r.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      r.on('end', () => callback(null, Buffer.concat(chunks)))
    })
    .expect(200)
  const parsed = XLSX.read(res.body as Buffer, { type: 'buffer' })
  return XLSX.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { header: 1, raw: false, defval: '' }) as string[][]
}

describeIfDatabase('multitable formula-over-lookup foreign-field mask — export (GA-T2b, real DB)', () => {
  beforeAll(async () => {
    app = buildApp(DENY_USER)

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'FEX Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'FEX Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS_X, BASE_B, 'Cross Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE_A, 'Main Sheet'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_XTARGET, FS_X, 'XTarget', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FX, FS_X, JSON.stringify({ [FLD_XTARGET]: 7 })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS_X }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LU, MS, 'Lookup', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_XTARGET, foreignSheetId: FS_X }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_F, MS, 'FormulaCol', 'formula', JSON.stringify({ expression: `={${FLD_LU}}+1` }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_PLAIN, MS, 'PlainCol', 'string', '{}', 4])

    // The formula value is MATERIALIZED (as the write path would persist it) = lookup(7)+1 = 8.
    // The leak: export reads this raw, no applyLookupRollup, so the denied foreign value (via the
    // formula) escapes.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_M, MS, JSON.stringify({ [FLD_LINK]: [REC_FX], [FLD_F]: 8, [FLD_PLAIN]: 'visible' })])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
      [`lnk_fex_${TS}`, FLD_LINK, REC_M, REC_FX])
    // formula depends on the lookup field (same sheet) — the taint edge the export-sink reads.
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
    await q('DELETE FROM meta_links WHERE record_id = $1', [REC_M]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS_X]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('DENY actor: formula column over a denied cross-base lookup is ABSENT from the export (header + cells)', async () => {
    const rows = await exportGrid(buildApp(DENY_USER))
    const header = rows[0] ?? []
    const flat = rows.flat()
    expect(header).not.toContain('FormulaCol') // whole column masked, fail-closed
    expect(flat).not.toContain('8') // the materialized leak value is gone
    // sanity: a plain readable column still exports
    expect(header).toContain('PlainCol')
    expect(flat).toContain('visible')
  })

  test('ALLOW actor (no field denial): the formula column exports normally', async () => {
    const rows = await exportGrid(buildApp(ALLOW_USER))
    const header = rows[0] ?? []
    const flat = rows.flat()
    expect(header).toContain('FormulaCol')
    expect(flat).toContain('8')
  })

  // Column-selection invariant against the TAINT leg (the part the mocked-pool canary cannot
  // reach — no formula_dependencies there): a DENY actor who EXPLICITLY requests the tainted
  // formula column via fieldIds must STILL be denied it. Selection intersects ON TOP of the
  // §2a.3 chokepoint mask; it can only narrow, never widen.
  test('SECURITY: DENY actor requesting the tainted formula column via fieldIds is STILL refused it; the plain column they also request exports', async () => {
    const rows = await exportGrid(buildApp(DENY_USER), `${FLD_F},${FLD_PLAIN}`)
    const header = rows[0] ?? []
    const flat = rows.flat()
    // tainted column stays masked even though explicitly requested
    expect(header).not.toContain('FormulaCol')
    expect(flat).not.toContain('8')
    // the permitted requested column is the only one exported (selection narrowed to it)
    expect(header).toEqual(['PlainCol'])
    expect(flat).toContain('visible')
  })

  test('ALLOW actor: fieldIds selection of the tainted formula column DOES export it (no denial → intersection keeps it)', async () => {
    const rows = await exportGrid(buildApp(ALLOW_USER), `${FLD_F},${FLD_PLAIN}`)
    const header = rows[0] ?? []
    const flat = rows.flat()
    expect(header).toEqual(['FormulaCol', 'PlainCol'])
    expect(flat).toContain('8')
  })
})
