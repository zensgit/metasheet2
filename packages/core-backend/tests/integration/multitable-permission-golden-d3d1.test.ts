/**
 * D3d-1 permission golden matrix — REAL DB (benchmark v2 #3 / Gap 7).
 *
 * Covers, against a real Postgres (seeded rows), asserted through the real export-xlsx route:
 *   - FIELD class × {granted, denied, inherited}
 *   - VIEW hidden-field projection × {granted (not hidden), denied (hidden)}
 *
 * NOTE on view scope: the export path applies `view.hidden_field_ids` (field projection) but
 * does NOT consult `meta_view_permissions` (view-access grants), so view-ACCESS tri-state
 * (granted/denied/INHERITED-from-sheet-scope) is NOT testable here and is deferred to D3d-2
 * (the view-data path). D3d-1's "view" coverage is hidden-field projection only.
 *
 * This is the golden-contract upgrade of the D3c mock-pool canaries (which stay as
 * fast guards in multitable-export-permission-canary.test.ts).
 *
 * RUNS ONLY with DATABASE_URL set (describeIfDatabase). It is wired into a dedicated
 * plugin-tests.yml step (env DATABASE_URL, after db:migrate). Without that step it
 * silently skips — see the sentinel test + the CI guard. Non-skip evidence is recorded
 * in docs/development/multitable-d3d1-permission-golden-verification-20260525.md.
 *
 * Scope (D3d-1): export + field + view only. sheet/record/action-guards = D3d-2.
 * Record read-deny is NOT exercised (grant-only model, no deny semantic — documented).
 * Export `denied` is N/A: canExport is fused to canRead (no independent export-deny
 * lever), so the only denial is the sheet-capability 403 — asserted once, labeled.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import type { XlsxModule } from '../../src/multitable/xlsx-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_d3d1_${TS}`
const SHEET_ID = `sheet_d3d1_${TS}`
const ROLE_ID = `role_d3d1_${TS}`
const USER_ID = `u_d3d1_${TS}`
const VIEW_ALL = `view_all_${TS}`
const VIEW_HIDDEN = `view_hidden_${TS}`
const FIELDS = [
  { id: `fld_name_${TS}`, name: 'Name', type: 'string', order: 1 },
  { id: `fld_amount_${TS}`, name: 'Amount', type: 'number', order: 2 },
  { id: `fld_secret_${TS}`, name: 'Secret', type: 'string', order: 3 },
]
const SECRET_FIELD = FIELDS[2].id
const RECORD_ID = `rec_d3d1_${TS}`

// ②b cross-base dimension — a SECOND base + a cross-base foreign sheet + a link/lookup/formula on
// SHEET_ID, so the export golden can assert the new §3.2 base-read coarse gate ON TOP of the existing
// FIELD × VIEW dimensions. The export path serializes only MATERIALIZED data, so (mirroring the proven
// multitable-lookup-foreign-field-mask-export pattern) the value surfaced is a FORMULA over the lookup:
// when Sink A masks the lookup, §2a.3 taints the formula → its column is dropped; otherwise it exports.
const XBASE_ID = `base_d3d1_xb_${TS}` // foreign base (no owner → base-read only via grant code)
const XFOREIGN_SHEET = `sheet_d3d1_xf_${TS}` // cross-base foreign sheet (in XBASE_ID)
const XFOREIGN_FIELD = `fld_d3d1_xf_${TS}` // foreign numeric field surfaced by the lookup
const XLINK_FIELD = `fld_d3d1_xlink_${TS}` // opted-in cross-base link on SHEET_ID
const XLOOKUP_FIELD = `fld_d3d1_xlu_${TS}` // lookup over the foreign field (Sink A consumer)
const XFORMULA_FIELD = `fld_d3d1_xf2_${TS}` // formula over the lookup (the materialized export carrier)
const XFOREIGN_RECORD = `rec_d3d1_xf_${TS}`
const XFOREIGN_NUM = 91 // the foreign numeric value (denied target)
const XFORMULA_VALUE = '92' // materialized = lookup(91)+1, asserted in the export CELLS (flat)

// Mutable so a single app can test both the authorized non-admin user and the no-read user.
let currentUser: { id: string; roles: string[]; perms: string[] } = {
  id: USER_ID,
  roles: ['member'], // non-admin → field/record scoping applies (access.ts:62 admin bypass avoided)
  perms: ['multitable:read'], // canRead (+canExport derives from canRead)
}

let app: Express
let xlsx: XlsxModule

async function q(sql: string, params?: unknown[]) {
  return poolManager.get().query(sql, params)
}

async function exportHeaderAndCells(viewId?: string): Promise<{ status: number; header: string[]; flat: string[] }> {
  const url = `/api/multitable/sheets/${SHEET_ID}/export-xlsx${viewId ? `?viewId=${viewId}` : ''}`
  const res = await request(app)
    .get(url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', (c) => chunks.push(Buffer.from(c)))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
  if (res.status !== 200) return { status: res.status, header: [], flat: [] }
  const parsed = xlsx.read(res.body, { type: 'buffer' })
  const rows = xlsx.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { header: 1, raw: false, defval: '' }) as string[][]
  return { status: res.status, header: rows[0] ?? [], flat: rows.flat() }
}

describeIfDatabase('multitable permission golden matrix — D3d-1 (field tri-state + view hidden-field projection, real DB)', () => {
  beforeAll(async () => {
    xlsx = (await import('xlsx')) as unknown as XlsxModule
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    // Seed: role + membership (for inherited), base/sheet/fields/record, two views.
    await q('INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [ROLE_ID, 'D3d1 Role'])
    await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [USER_ID, ROLE_ID])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'D3d1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'D3d1 Sheet'])
    for (const f of FIELDS) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [
        f.id, SHEET_ID, f.name, f.type, '{}', f.order,
      ])
    }
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)', [
      RECORD_ID, SHEET_ID, JSON.stringify({ [FIELDS[0].id]: 'Alpha', [FIELDS[1].id]: 12, [SECRET_FIELD]: 'topsecret' }),
    ])
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids) VALUES ($1, $2, $3, $4, $5::jsonb)', [
      VIEW_ALL, SHEET_ID, 'All', 'grid', '[]',
    ])
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids) VALUES ($1, $2, $3, $4, $5::jsonb)', [
      VIEW_HIDDEN, SHEET_ID, 'Hidden', 'grid', JSON.stringify([SECRET_FIELD]),
    ])

    // ②b cross-base dimension seed: a foreign base + cross-base foreign sheet with a numeric field, an
    // opted-in cross-base link (foreignBaseId == XBASE_ID), a lookup over the foreign field, and a
    // formula over the lookup on SHEET_ID. The formula value is MATERIALIZED (as the write path would
    // persist) = lookup(91)+1 = 92; the export reads it RAW, but §2a.3 taint drops it whenever the
    // lookup is masked (Sink A base gate OR field gate). The dependency edge is the taint edge.
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [XBASE_ID, 'D3d1 Cross Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [XFOREIGN_SHEET, XBASE_ID, 'D3d1 Cross Foreign'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [XFOREIGN_FIELD, XFOREIGN_SHEET, 'XForeign', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [XFOREIGN_RECORD, XFOREIGN_SHEET, JSON.stringify({ [XFOREIGN_FIELD]: XFOREIGN_NUM })])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [XLINK_FIELD, SHEET_ID, 'XLink', 'link', JSON.stringify({ foreignSheetId: XFOREIGN_SHEET, foreignBaseId: XBASE_ID }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [XLOOKUP_FIELD, SHEET_ID, 'XLookup', 'lookup', JSON.stringify({ linkFieldId: XLINK_FIELD, targetFieldId: XFOREIGN_FIELD, foreignSheetId: XFOREIGN_SHEET }), 5])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [XFORMULA_FIELD, SHEET_ID, 'XFormula', 'formula', JSON.stringify({ expression: `={${XLOOKUP_FIELD}}+1` }), 6])
    await q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1',
      [RECORD_ID, JSON.stringify({ [XLINK_FIELD]: [XFOREIGN_RECORD], [XFORMULA_FIELD]: Number(XFORMULA_VALUE) })])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
      [`lnk_d3d1_xb_${TS}`, XLINK_FIELD, RECORD_ID, XFOREIGN_RECORD])
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)',
      [SHEET_ID, XFORMULA_FIELD, XLOOKUP_FIELD, SHEET_ID])
  })

  afterEach(async () => {
    // reset per-test field permissions + the authorized user
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID])
    currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:read'] }
  })

  afterAll(async () => {
    // best-effort cleanup (FK cascade from sheet covers fields/records)
    // ②b cross-base dimension teardown first (links + deps + field_permissions + foreign sheet/base).
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [XLINK_FIELD]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [XFOREIGN_SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [XFOREIGN_SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [XBASE_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM user_roles WHERE role_id = $1', [ROLE_ID]).catch(() => {})
    await q('DELETE FROM roles WHERE id = $1', [ROLE_ID]).catch(() => {})
  })

  // Sentinel: defense against cargo-culting this suite without the DATABASE_URL CI step.
  test('sentinel: DATABASE_URL is set (suite actually executing against real DB)', () => {
    expect(process.env.DATABASE_URL, 'D3d-1 must run with DATABASE_URL via the dedicated CI step').toBeTruthy()
  })

  // ── FIELD class ──────────────────────────────────────────────────────────
  test('field/granted: explicit visible=true (direct user) → field exported', async () => {
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1, $2, $3, $4, $5, $6)',
      [SHEET_ID, SECRET_FIELD, 'user', USER_ID, true, false],
    )
    const { status, header, flat } = await exportHeaderAndCells()
    expect(status).toBe(200)
    expect(header).toContain('Secret')
    expect(flat).toContain('topsecret')
  })

  test('field/denied: visible=false (direct user) → masked in export header + cells', async () => {
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1, $2, $3, $4, $5, $6)',
      [SHEET_ID, SECRET_FIELD, 'user', USER_ID, false, false],
    )
    const { status, header, flat } = await exportHeaderAndCells()
    expect(status).toBe(200)
    expect(header).not.toContain('Secret')
    expect(flat).not.toContain('topsecret')
  })

  // role is the representative inherited path; member-group inheritance (same scope-map
  // branch + platform_member_group_members) is deferred to D3d-2 / final matrix.
  test('field/inherited: visible=false via role membership → masked in export', async () => {
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1, $2, $3, $4, $5, $6)',
      [SHEET_ID, SECRET_FIELD, 'role', ROLE_ID, false, false],
    )
    const { status, header, flat } = await exportHeaderAndCells()
    expect(status).toBe(200)
    expect(header).not.toContain('Secret')
    expect(flat).not.toContain('topsecret')
  })

  // ── VIEW hidden-field projection (NOT view-access perms; meta_view_permissions = D3d-2) ──
  test('view-projection/granted: field not in hidden_field_ids → exported', async () => {
    const { status, header } = await exportHeaderAndCells(VIEW_ALL)
    expect(status).toBe(200)
    expect(header).toContain('Secret')
  })

  test('view-projection/denied: field in view.hidden_field_ids → masked in export', async () => {
    const { status, header, flat } = await exportHeaderAndCells(VIEW_HIDDEN)
    expect(status).toBe(200)
    expect(header).not.toContain('Secret')
    expect(flat).not.toContain('topsecret')
  })

  // ── EXPORT capability ────────────────────────────────────────────────────
  // export `denied` is N/A: canExport is fused to canRead, there is no independent
  // export-deny lever. The only denial is the sheet-capability gate → 403.
  test('export/denied (N/A — fused to canRead): user without read capability → 403', async () => {
    currentUser = { id: USER_ID, roles: ['member'], perms: [] } // no multitable:read
    const { status } = await exportHeaderAndCells()
    expect(status).toBe(403)
  })

  // ── ②b CROSS-BASE dimension (NEW) — base-read coarse gate × field mask, layered on FIELD × VIEW ──
  // Asserts §3.4's three rows on the EXPORT cell (Sink A path, via the §2a.3 formula-taint that the
  // export sink reads). The Sink B summary + the /link-options 403 legs of §3.4's "denied" row are
  // locked separately by XB-2/2b/2c in multitable-cross-base-link-optin.test.ts (export only does Sink A).
  describe('cross-base × base-read (§3.4)', () => {
    test('cross-base + base-read GRANTED + foreign field readable → formula-over-lookup value EXPORTED', async () => {
      currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:read', 'multitable:base:read'] }
      const { status, header, flat } = await exportHeaderAndCells()
      expect(status).toBe(200)
      expect(header).toContain('XFormula')
      expect(flat).toContain(XFORMULA_VALUE)
    })

    test('cross-base + base-read DENIED → foreign sheet masked (Sink A) → formula tainted, value ABSENT', async () => {
      currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:read'] } // no base-read, not owner
      const { status, header, flat } = await exportHeaderAndCells()
      expect(status).toBe(200)
      expect(header).not.toContain('XFormula') // whole formula column dropped, fail-closed
      expect(flat).not.toContain(XFORMULA_VALUE)
    })

    test('cross-base + base-read GRANTED + foreign field FIELD-permission denied → still masked (double layer)', async () => {
      currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:read', 'multitable:base:read'] }
      // deny the foreign field at field level for this actor; base gate is open but §2a.3 still masks
      // (cross-base unconditional field mask → lookup masked → formula tainted).
      await q(
        'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1, $2, $3, $4, $5, $6)',
        [XFOREIGN_SHEET, XFOREIGN_FIELD, 'user', USER_ID, false, false],
      )
      const { status, header, flat } = await exportHeaderAndCells()
      expect(status).toBe(200)
      expect(header).not.toContain('XFormula')
      expect(flat).not.toContain(XFORMULA_VALUE)
      // teardown this extra grant (afterEach only clears SHEET_ID's field_permissions, not the foreign sheet's).
      await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2 AND subject_id = $3', [XFOREIGN_SHEET, XFOREIGN_FIELD, USER_ID])
    })
  })
})
