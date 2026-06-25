/**
 * T9-R3.1 — VIEW filter-literal redaction on the SINGLE /config-history endpoint (real DB).
 *
 * Shipped-path security fix: the single endpoint (#3153) returned view `before`/`after` raw, so a
 * view's `filterInfo.conditions[].value` literals — which are field-read-sensitive (#2052/R9) —
 * leaked through config-history to a `canManageViews`-but-field-denied reader (`canManageViews`
 * does NOT imply field-read). This proves the redaction against R2's REAL recorded shape: a view
 * filtered on a denied field is written through the route (so R2 records it), then a field-denied
 * reader does NOT see the denied literal while a fully-allowed reader does. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_chvr_${TS}`
const SHEET = `sheet_chvr_${TS}`
const FLD_VISIBLE = `fld_chvr_visible_${TS}`
const FLD_SECRET = `fld_chvr_secret_${TS}`
const VISIBLE_LIT = 'chvr-visible-literal-keepme'
const SECRET_LIT = 'chvr-secret-literal-do-not-leak'
const U_FULL = `u_chvr_full_${TS}`
const U_FIELDDENIED = `u_chvr_fdenied_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let actor: { id: string; roles: string[]; perms: string[] }
const FULL = { id: U_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
// canManageViews (via write) but FLD_SECRET denied → must NOT see the secret filter literal.
const FIELDDENIED = { id: U_FIELDDENIED, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const listViews = (as: typeof FULL) => { actor = as; return request(app).get(`/api/multitable/sheets/${SHEET}/config-history?entityType=view`) }

describeIfDatabase('multitable config-history — VIEW filter-literal redaction on the single endpoint (T9-R3.1, real DB)', () => {
  let e2eViewId = ''
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'CHVR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'CHVR Sheet'])
    for (const [fid, name, order] of [[FLD_VISIBLE, 'Visible', 1], [FLD_SECRET, 'Secret', 2]] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET, name, 'string', '{}', order])
    }
    for (const u of [U_FULL, U_FIELDDENIED]) await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
    // FLD_SECRET denied to the field-denied user (layer-3); FULL keeps field read.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET, FLD_SECRET, 'user', U_FIELDDENIED, false, false])
    // Create + patch a view filtered on the denied field THROUGH the route → R2 records the real shape.
    actor = FULL
    const created = await request(app).post('/api/multitable/views').send({ sheetId: SHEET, name: 'CHVR View', type: 'grid' })
    e2eViewId = created.body?.data?.view?.id
    const patched = await request(app).patch(`/api/multitable/views/${e2eViewId}`).send({
      filterInfo: { conjunction: 'and', conditions: [
        { fieldId: FLD_VISIBLE, operator: 'is', value: VISIBLE_LIT },
        { fieldId: FLD_SECRET, operator: 'is', value: SECRET_LIT },
      ] },
    })
    if (!e2eViewId || patched.status !== 200) throw new Error(`view setup failed: create=${created.status} patch=${patched.status}`)
  })
  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    for (const u of [U_FULL, U_FIELDDENIED]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R2 recorded the view filter literal in the redactor path (sanity, pre-redaction)', async () => {
    const rec = (await q(
      `SELECT after FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' AND entity_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [SHEET, e2eViewId],
    )).rows[0] as { after: any } | undefined
    expect(JSON.stringify(rec?.after)).toContain(SECRET_LIT)
  })

  test('field-denied canManageViews reader does NOT see the secret filter literal; fully-allowed DOES (VISIBLE stays)', async () => {
    const denied = await listViews(FIELDDENIED)
    expect(denied.status).toBe(200)
    expect(JSON.stringify(denied.body)).not.toContain(SECRET_LIT) // shipped-path leak CLOSED
    expect(JSON.stringify(denied.body)).toContain(VISIBLE_LIT) // no over-redaction

    const full = await listViews(FULL)
    expect(full.status).toBe(200)
    expect(JSON.stringify(full.body)).toContain(SECRET_LIT) // fully-allowed sees it
    expect(JSON.stringify(full.body)).toContain(VISIBLE_LIT)
  })

  // T9-W preview path (same leak class via config-restore-preview): the view revert preview's
  // current/target carries filterInfo — must be redacted for a field-denied canManageViews caller.
  test('config-restore-preview redaction: field-denied canManageViews does NOT see the secret literal in current/target; fully-allowed DOES', async () => {
    const rev = (await q(
      `SELECT id FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' AND entity_id=$2 AND action='update' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [SHEET, e2eViewId],
    )).rows[0] as { id: string } | undefined
    expect(rev?.id).toBeTruthy()

    actor = FIELDDENIED
    const denied = await request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-preview`).send({ revisionId: rev!.id })
    expect(denied.status).toBe(200)
    expect(JSON.stringify(denied.body)).not.toContain(SECRET_LIT) // preview leak CLOSED
    expect(JSON.stringify(denied.body)).toContain(VISIBLE_LIT) // no over-redaction

    actor = FULL
    const full = await request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-preview`).send({ revisionId: rev!.id })
    expect(full.status).toBe(200)
    expect(JSON.stringify(full.body)).toContain(SECRET_LIT) // fully-allowed sees it in the preview
  })
})
