/**
 * Real-DB integration test for view-config filter-literal redaction (priority-#2 (b), design #2052:
 * docs/development/multitable-viewconfig-filter-literal-redaction-design-20260529.md).
 *
 * A saved view's filterInfo.conditions[].value (the comparison LITERAL) is echoed verbatim wherever a
 * view config is serialized, leaking a field-denied user that field's filter literal. (b) redacts the
 * literal (value-only / omit the `value` key, fieldId+operator kept) for fields the REQUESTER can't read,
 * at every view-config serializer, via a shared field-permission-aware helper.
 *
 * Fail-first (design §5): R1-R5/R8/R9 + cross-user demonstrated RED on origin/main (literal present),
 * GREEN after. Fences three fail-open vectors: layer-2 property.hidden (R8), authed base-only /context
 * (R1 ?baseId=), anonymous /form-context (R5 fail-closed). R7 pins layer-1 (view-hidden) stays.
 * Seed non-negotiable: FLD_SECRET denied SOLELY via layer-3 (property.hidden UNSET).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_vcr_${TS}`
const SHEET_ID = `sheet_vcr_${TS}`
const FLD_VISIBLE = `fld_vcr_visible_${TS}`
const FLD_SECRET = `fld_vcr_secret_${TS}` // denied via layer-3 field_permissions (property.hidden UNSET)
const FLD_STATIC_HIDDEN = `fld_vcr_statichidden_${TS}` // layer-2 property.hidden=true
const FLD_VIEWHIDDEN = `fld_vcr_viewhidden_${TS}` // layer-1: in view.hidden_field_ids, but readable
const REC_ID = `rec_vcr_${TS}`
const VIEW_ID = `view_vcr_${TS}`
const PUBLIC_TOKEN = `tok_vcr_${TS}`
const USER_ID = `u_vcr_${TS}` // FLD_SECRET denied
const USER_ID_2 = `u_vcr_other_${TS}` // no deny — cross-user / readable control
// Distinct literals so the whole-body canary scan is unambiguous:
const VISIBLE_LIT = 'visible-literal-keepme'
const SECRET_LIT = 'secret-literal-do-not-leak' // layer-3 → must be redacted
const STATIC_HIDDEN_LIT = 'statichidden-literal-do-not-leak' // layer-2 → must be redacted
const VIEWHIDDEN_LIT = 'viewhidden-literal-keepme' // layer-1 → must STAY (readable field)

let app: Express
let testUserId: string = USER_ID
let testPerms: string[] = ['multitable:read']
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const body = (res: { body: unknown }) => JSON.stringify(res.body)

describeIfDatabase('multitable view-config filter-literal redaction (#2052, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'VCR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'VCR Sheet'])
    for (const [fid, name, order, prop] of [
      [FLD_VISIBLE, 'Visible', 1, '{}'],
      [FLD_SECRET, 'Secret', 2, '{}'], // property.hidden UNSET — deny is solely layer-3
      [FLD_STATIC_HIDDEN, 'StaticHidden', 3, '{"hidden":true}'],
      [FLD_VIEWHIDDEN, 'ViewHidden', 4, '{}'],
    ] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET_ID, name, 'string', prop, order])
    }
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify({ [FLD_VISIBLE]: 'v', [FLD_SECRET]: 's' })])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID, false, false])
    // The view: a filter condition (with a literal) on EACH field + view-hidden FLD_VIEWHIDDEN + a public form.
    const filterInfo = { conjunction: 'and', conditions: [
      { fieldId: FLD_VISIBLE, operator: 'is', value: VISIBLE_LIT },
      { fieldId: FLD_SECRET, operator: 'is', value: SECRET_LIT },
      { fieldId: FLD_STATIC_HIDDEN, operator: 'is', value: STATIC_HIDDEN_LIT },
      { fieldId: FLD_VIEWHIDDEN, operator: 'is', value: VIEWHIDDEN_LIT },
    ] }
    const config = { publicForm: { enabled: true, publicToken: PUBLIC_TOKEN, accessMode: 'public' } }
    await q('INSERT INTO meta_views (id, sheet_id, name, type, filter_info, hidden_field_ids, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
      [VIEW_ID, SHEET_ID, 'VCR View', 'grid', JSON.stringify(filterInfo), JSON.stringify([FLD_VIEWHIDDEN]), JSON.stringify(config)])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // For each authed canRead readback: layer-3 (secret) + layer-2 (static-hidden) literals ABSENT;
  // readable (visible) + view-hidden-but-readable (layer-1) literals PRESENT.
  const assertAuthedReadback = (res: { status: number; body: unknown }) => {
    expect(res.status).toBe(200)
    const b = body(res)
    expect(b).not.toContain(SECRET_LIT) // R-layer3
    expect(b).not.toContain(STATIC_HIDDEN_LIT) // R8 layer-2 composite
    expect(b).toContain(VISIBLE_LIT) // no over-redaction
    expect(b).toContain(VIEWHIDDEN_LIT) // R7 layer-1 stays
  }

  test('R1 (req): GET /context?baseId=... (authed, BASE-ONLY) redacts the denied literal (effectiveSheetId binding)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    assertAuthedReadback(await request(app).get('/api/multitable/context').query({ baseId: BASE_ID }))
  })

  test('R2 (req): GET /views (authed) redacts the denied literal (list-path parallel-hole guard)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    assertAuthedReadback(await request(app).get('/api/multitable/views').query({ sheetId: SHEET_ID }))
  })

  test('R3: GET /view (authed) redacts the denied literal on the active-view echo', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    assertAuthedReadback(await request(app).get('/api/multitable/view').query({ sheetId: SHEET_ID, viewId: VIEW_ID }))
  })

  test('R4: GET /records/:recordId (authed) redacts the denied literal on the echoed view', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    assertAuthedReadback(await request(app).get(`/api/multitable/records/${REC_ID}`).query({ sheetId: SHEET_ID, viewId: VIEW_ID }))
  })

  test('R5 (req): GET /form-context ANONYMOUS → fail-closed (ALL filter literals absent), view still returned', async () => {
    testUserId = '' // anonymous
    const res = await request(app).get('/api/multitable/form-context').query({ viewId: VIEW_ID, publicToken: PUBLIC_TOKEN })
    expect(res.status).toBe(200) // positive control: the public form actually resolved (not 401/403/404)
    expect(res.body.data.fields?.length).toBeGreaterThan(0) // ...and returned the view payload
    const b = body(res)
    // fail-closed: no subject ⇒ nothing allowed ⇒ EVERY filter literal redacted (incl the readable ones)
    expect(b).not.toContain(SECRET_LIT)
    expect(b).not.toContain(STATIC_HIDDEN_LIT)
    expect(b).not.toContain(VISIBLE_LIT)
    expect(b).not.toContain(VIEWHIDDEN_LIT)
    testUserId = USER_ID
  })

  test('R6 (cross-user / pure-helper): denied user then readable user on the SAME view — no cache corruption', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read']
    const denied = await request(app).get('/api/multitable/view').query({ sheetId: SHEET_ID, viewId: VIEW_ID })
    expect(body(denied)).not.toContain(SECRET_LIT) // denied user: redacted
    testUserId = USER_ID_2; testPerms = ['multitable:read'] // no deny row for this subject
    const readable = await request(app).get('/api/multitable/view').query({ sheetId: SHEET_ID, viewId: VIEW_ID })
    expect(body(readable)).toContain(SECRET_LIT) // readable user STILL sees the literal (helper is pure — no shared-object mutation)
    testUserId = USER_ID
  })

  test('R7: an ungranted-to-deny user sees the denied literal (per-subject; redaction follows the requester)', async () => {
    testUserId = USER_ID_2; testPerms = ['multitable:read']
    expect(body(await request(app).get('/api/multitable/view').query({ sheetId: SHEET_ID, viewId: VIEW_ID }))).toContain(SECRET_LIT)
    testUserId = USER_ID
  })

  test('R9: a canManageViews-but-field-denied user also gets the denied literal redacted (field-perm-aware, not gate-dependent)', async () => {
    testUserId = USER_ID; testPerms = ['multitable:read', 'multitable:write'] // manage views, but FLD_SECRET still denied via field_permissions
    const res = await request(app).patch(`/api/multitable/views/${VIEW_ID}`).send({ name: 'VCR View Renamed' })
    expect(res.status).toBe(200) // positive control: the update succeeded (canManageViews)
    expect(body(res)).not.toContain(SECRET_LIT) // the returned view redacts the denied literal
    testUserId = USER_ID; testPerms = ['multitable:read']
  })
})
