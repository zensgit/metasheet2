/**
 * D3d-2 permission golden matrix — REAL DB (benchmark v2 #3 / Gap 7).
 * Scope locked in docs/development/multitable-d3d2-scope-lock-20260525.md (final).
 *
 * Asserts the multitable model's REAL deny-gates, and locks the non-gates as contract:
 *   - field / inherited-via-member-group  → export masks (real gate; completes D3d-1)
 *   - sheet / write-intersection          → inherited 200, granted 200, read-only-row → PATCH 403
 *   - record / write-own                  → own 200, not-own 403
 *   - view-access (NON-GATE, live)        → canAccess===true AND data returned
 *
 * Systemic finding (see scope-lock §0): the model is annotation-rich / enforcement-thin —
 * grant-additive at read, denial only via field-projection or write-intersection. sheet-read
 * and record-read have NO deny semantic (documented, not asserted). A non-gate returning data
 * is the EXPECTED contract, never a leak. Only a real gate returning 200 (or a masked field
 * appearing) is RED → stop + separate fix PR (per scope-lock §3).
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the dedicated plugin-tests.yml step.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import type { XlsxModule } from '../../src/multitable/xlsx-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_d3d2_${TS}`
const OTHER = `o_d3d2_${TS}`
const GROUP_ID = `d3d20000-0000-4000-8000-${String(TS).slice(-12).padStart(12, '0')}` // valid uuid
const BASE_ID = `base_d3d2_${TS}`
const SHEET_ID = `sheet_d3d2_${TS}`
const VIEW_ID = `view_d3d2_${TS}`
const FLD_NAME = `fld_name_${TS}`
const FLD_SECRET = `fld_secret_${TS}`
const REC_OWN = `rec_own_${TS}`
const REC_OTHER = `rec_other_${TS}`

let currentUser: { id: string; roles: string[]; perms: string[] } = { id: USER, roles: ['member'], perms: ['multitable:read'] }
let app: Express
let xlsx: XlsxModule

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

async function exportFlat(): Promise<{ status: number; header: string[]; flat: string[] }> {
  const res = await request(app)
    .get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx`)
    .buffer(true)
    .parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d) => c.push(Buffer.from(d))); r.on('end', () => cb(null, Buffer.concat(c))) })
  if (res.status !== 200) return { status: res.status, header: [], flat: [] }
  const parsed = xlsx.read(res.body, { type: 'buffer' })
  const rows = xlsx.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { header: 1, raw: false, defval: '' }) as string[][]
  return { status: res.status, header: rows[0] ?? [], flat: rows.flat() }
}

async function patchRecord(recordId: string): Promise<number> {
  const res = await request(app)
    .patch(`/api/multitable/records/${recordId}`)
    .send({ sheetId: SHEET_ID, data: { [FLD_NAME]: 'updated' } })
  return res.status
}

async function getView(): Promise<{ status: number; canAccess: unknown; rowCount: number }> {
  const res = await request(app).get(`/api/multitable/view?sheetId=${SHEET_ID}&viewId=${VIEW_ID}`)
  const vp = res.body?.data?.meta?.permissions?.viewPermissions?.[VIEW_ID]
  const rows = res.body?.data?.rows
  return { status: res.status, canAccess: vp?.canAccess, rowCount: Array.isArray(rows) ? rows.length : -1 }
}

describeIfDatabase('multitable permission golden matrix — D3d-2 (real gates + non-gate contract, real DB)', () => {
  beforeAll(async () => {
    xlsx = (await import('xlsx')) as unknown as XlsxModule
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    // users (FK target for platform_member_group_members.user_id)
    await q('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [USER, `${USER}@t.local`, 'D3d2 User', 'x'])
    await q('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [OTHER, `${OTHER}@t.local`, 'D3d2 Other', 'x'])
    // member group + membership (for field inherited-via-member-group)
    await q('INSERT INTO platform_member_groups (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [GROUP_ID, 'D3d2 Group'])
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [GROUP_ID, USER])
    // base / sheet / fields
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'D3d2 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'D3d2 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_NAME, SHEET_ID, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 2])
    // records: one owned by USER, one by OTHER (for write-own)
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [REC_OWN, SHEET_ID, JSON.stringify({ [FLD_NAME]: 'Alpha', [FLD_SECRET]: 'topsecret' }), USER])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [REC_OTHER, SHEET_ID, JSON.stringify({ [FLD_NAME]: 'Beta', [FLD_SECRET]: 'topsecret' }), OTHER])
    await q('INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids) VALUES ($1,$2,$3,$4,$5::jsonb)', [VIEW_ID, SHEET_ID, 'V', 'grid', '[]'])
  })

  afterEach(async () => {
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_view_permissions WHERE view_id = $1', [VIEW_ID]).catch(() => {})
    currentUser = { id: USER, roles: ['member'], perms: ['multitable:read'] }
  })

  afterAll(async () => {
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_view_permissions WHERE view_id = $1', [VIEW_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM platform_member_group_members WHERE group_id = $1', [GROUP_ID]).catch(() => {})
    await q('DELETE FROM platform_member_groups WHERE id = $1', [GROUP_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[USER, OTHER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set (real DB run, not skipped)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── REAL GATE: field masking via member-group inheritance ──────────────────
  test('field/inherited-via-member-group: visible=false via group → masked in export', async () => {
    currentUser = { id: USER, roles: ['member'], perms: ['multitable:read'] }
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'member-group', GROUP_ID, false, false])
    const { status, header, flat } = await exportFlat()
    expect(status).toBe(200)
    expect(header).not.toContain('Secret')
    expect(flat).not.toContain('topsecret')
  })

  // ── REAL GATE: sheet write-intersection ────────────────────────────────────
  test('sheet/inherited (control): no sheet row + base write → PATCH 200', async () => {
    currentUser = { id: USER, roles: ['member'], perms: ['multitable:write'] }
    expect(await patchRecord(REC_OWN)).toBe(200)
  })

  test('sheet/granted (control): sheet row spreadsheet:write → PATCH 200', async () => {
    currentUser = { id: USER, roles: ['member'], perms: ['multitable:write'] }
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [SHEET_ID, 'user', USER, 'spreadsheet:write'])
    expect(await patchRecord(REC_OWN)).toBe(200)
  })

  test('sheet/write-downgraded (GATE): base write + sheet row spreadsheet:read only → PATCH 403', async () => {
    currentUser = { id: USER, roles: ['member'], perms: ['multitable:write'] }
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [SHEET_ID, 'user', USER, 'spreadsheet:read'])
    expect(await patchRecord(REC_OWN)).toBe(403)
  })

  // ── REAL GATE: record write-own ────────────────────────────────────────────
  test('record/write-own — own: write-own scope + creator → PATCH 200', async () => {
    currentUser = { id: USER, roles: ['member'], perms: ['multitable:write'] }
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [SHEET_ID, 'user', USER, 'spreadsheet:write-own'])
    expect(await patchRecord(REC_OWN)).toBe(200)
  })

  test('record/write-own — not-own (GATE): write-own scope + non-creator → PATCH 403', async () => {
    currentUser = { id: USER, roles: ['member'], perms: ['multitable:write'] }
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [SHEET_ID, 'user', USER, 'spreadsheet:write-own'])
    expect(await patchRecord(REC_OTHER)).toBe(403)
  })

  // ── NON-GATE (live contract): view-access is annotation, never blocks data ──
  // Locks "annotation, not gate": even with a view perm row for ANOTHER user, our user
  // (per-user scope → none) still gets canAccess===true AND the data rows. Guards against a
  // future implicit 403 or a reviewer misreading this as a leak.
  test('view-access NON-GATE: canAccess===true AND data still returned', async () => {
    currentUser = { id: USER, roles: ['member'], perms: ['multitable:read'] }
    await q('INSERT INTO meta_view_permissions (view_id, subject_type, subject_id, permission) VALUES ($1,$2,$3,$4)', [VIEW_ID, 'user', OTHER, 'admin'])
    const { status, canAccess, rowCount } = await getView()
    expect(status).toBe(200)
    expect(canAccess).toBe(true)
    expect(rowCount).toBeGreaterThanOrEqual(1)
  })
})
