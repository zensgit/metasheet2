/**
 * T9-W U-1a — sheet_config conditionalReadRules literal redaction on the /config-history read (real DB).
 *
 * Pre-existing leak (advisor 2026-06-26): the single /config-history endpoint redacted only VIEW rows
 * (filterInfo); sheet_config rows carry `conditionalReadRules[].value` literals that are equally
 * field-read-sensitive (#2052/R9), and `canManageSheetAccess` does NOT imply field-read. So a
 * share-capable but field-denied reader saw a denied field's rule literal through history — the
 * sheet_config twin of the R3.1 view fix. This proves the fix against the REAL recorded shape: rules
 * are authored through PUT /conditional-rules (so the recorder writes the real payload), then a
 * field-denied reader does NOT see the denied literal while a fully-allowed reader does. Runs only with
 * DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_chsc_${TS}`
const SHEET = `sheet_chsc_${TS}`
const FLD_VISIBLE = `fld_chsc_visible_${TS}`
const FLD_SECRET = `fld_chsc_secret_${TS}`
const VISIBLE_LIT = 'chsc-visible-literal-keepme'
const SECRET_LIT = 'chsc-secret-literal-do-not-leak'
const U_FULL = `u_chsc_full_${TS}`
const U_SHAREDENIED = `u_chsc_sdenied_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let actor: { id: string; roles: string[]; perms: string[] }
// FULL: read+write+share, no field deny → authors the rules AND is the control reader.
const FULL = { id: U_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
// SHARE-but-field-denied: canManageSheetAccess (via share) so it CAN read sheet_config history, but
// FLD_SECRET is denied → must NOT see the secret rule literal.
const SHAREDENIED = { id: U_SHAREDENIED, roles: ['member'], perms: ['multitable:read', 'multitable:share'] }
const listSheetConfig = (as: typeof FULL) => { actor = as; return request(app).get(`/api/multitable/sheets/${SHEET}/config-history?entityType=sheet_config`) }

describeIfDatabase('multitable config-history — sheet_config conditionalReadRules literal redaction (T9-W U-1a, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'CHSC Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'CHSC Sheet'])
    for (const [fid, name, order] of [[FLD_VISIBLE, 'Visible', 1], [FLD_SECRET, 'Secret', 2]] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET, name, 'string', '{}', order])
    }
    for (const u of [U_FULL, U_SHAREDENIED]) await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
    // FLD_SECRET denied to the share-denied user (layer-3); FULL keeps field read.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET, FLD_SECRET, 'user', U_SHAREDENIED, false, false])
    // Author conditional read-deny rules on BOTH fields THROUGH the route → the recorder writes the real shape.
    actor = FULL
    const put = await request(app).put(`/api/multitable/sheets/${SHEET}/conditional-rules`).send({ rules: [
      { id: 'r_visible', fieldId: FLD_VISIBLE, operator: 'eq', value: VISIBLE_LIT, effect: 'deny_read' },
      { id: 'r_secret', fieldId: FLD_SECRET, operator: 'eq', value: SECRET_LIT, effect: 'deny_read' },
    ] })
    if (put.status !== 200) throw new Error(`conditional-rules setup failed: ${put.status} ${JSON.stringify(put.body)}`)
  })
  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    for (const u of [U_FULL, U_SHAREDENIED]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('the recorder wrote the secret rule literal (sanity, pre-redaction)', async () => {
    const rec = (await q(
      `SELECT after FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='sheet_config' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [SHEET],
    )).rows[0] as { after: any } | undefined
    expect(JSON.stringify(rec?.after)).toContain(SECRET_LIT)
    expect(JSON.stringify(rec?.after)).toContain(VISIBLE_LIT)
  })

  test('field-denied canManageSheetAccess reader does NOT see the secret rule literal; fully-allowed DOES (VISIBLE stays)', async () => {
    const denied = await listSheetConfig(SHAREDENIED)
    expect(denied.status).toBe(200)
    expect(JSON.stringify(denied.body)).not.toContain(SECRET_LIT) // pre-existing leak CLOSED
    expect(JSON.stringify(denied.body)).toContain(VISIBLE_LIT) // no over-redaction (readable field's literal kept)

    const full = await listSheetConfig(FULL)
    expect(full.status).toBe(200)
    expect(JSON.stringify(full.body)).toContain(SECRET_LIT) // fully-allowed sees it
    expect(JSON.stringify(full.body)).toContain(VISIBLE_LIT)
  })
})
