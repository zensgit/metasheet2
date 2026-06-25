/**
 * T9-R3 — config-history READ API (real DB). Proves the gate口径 + view payload redaction:
 *  - each endpoint returns only its entity_type/scope rows;
 *  - the read gate = the write-symmetric capability (write-user 403 on sheet-config + sheet-perm;
 *    read-only 403 on everything);
 *  - VIEW rows redact field-read-sensitive filter literals (a canManageViews + field-denied caller
 *    does NOT see the denied literal; a fully-allowed caller does) — #2052/R9 reused;
 *  - fail-closed: a malformed `permission` entity_id is returned by no endpoint;
 *  - deterministic pagination (created_at DESC, id DESC).
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_chr_${TS}`
const SHEET = `sheet_chr_${TS}`
const FLD_VISIBLE = `fld_chr_visible_${TS}`
const FLD_SECRET = `fld_chr_secret_${TS}`
const VIEW_ID = `view_chr_${TS}`
const SEED_ACTOR = `user_chr_actor_${TS}`
const SUBJECT = `user_chr_subject_${TS}`
// distinct, unambiguous literals for the leak canary
const VISIBLE_LIT = 'chr-visible-literal-keepme'
const SECRET_LIT = 'chr-secret-literal-do-not-leak'
// users (caps via base perms — deriveCapabilities: write→canManageFields/Views; share→canManageSheetAccess)
const U_FULL = `user_chr_full_${TS}`
const U_WRITE = `user_chr_write_${TS}`
const U_READ = `user_chr_read_${TS}`
const U_FIELDDENIED = `user_chr_fdenied_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const bodyStr = (res: { body: unknown }) => JSON.stringify(res.body)
let app: Express
let testUserId = U_FULL
let testPerms: string[] = ['multitable:read', 'multitable:write', 'multitable:share']
const as = (id: string, perms: string[]) => { testUserId = id; testPerms = perms }
const get = (path: string) => request(app).get(`/api/multitable${path}`)
const revisions = (res: { body: any }): Array<Record<string, any>> => (res.body?.data?.revisions ?? [])

const insertRev = (
  entityType: string, entityId: string, action: string,
  before: unknown, after: unknown, createdAt?: string,
) => q(
  `INSERT INTO meta_config_revisions
     (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id${createdAt ? ', created_at' : ''})
   VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::text[],$8,$9${createdAt ? ',$10' : ''})`,
  [SHEET, entityType, entityId, action, JSON.stringify(before ?? null), JSON.stringify(after ?? null), [], null, SEED_ACTOR, ...(createdAt ? [createdAt] : [])],
)
const permId = (scope: 'field' | 'sheet' | 'view', parts: string[]) => `${scope}:${JSON.stringify(parts)}`

describeIfDatabase('multitable config-history READ API — T9-R3 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: testUserId, roles: [], perms: testPerms }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'CHR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'CHR Sheet'])
    for (const [fid, name, order] of [[FLD_VISIBLE, 'Visible', 1], [FLD_SECRET, 'Secret', 2]] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET, name, 'string', '{}', order])
    }
    await q('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1,$2,$3,$4)', [VIEW_ID, SHEET, 'CHR View', 'grid'])
    for (const u of [U_FULL, U_WRITE, U_READ, U_FIELDDENIED, SEED_ACTOR, SUBJECT]) {
      await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
    }
    // FLD_SECRET denied to the field-denied user ONLY (layer-3); FULL keeps field read.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET, FLD_SECRET, 'user', U_FIELDDENIED, false, false])

    // Seed config-revision rows — one per entity type / permission subtype + a malformed permission row.
    await insertRev('field', FLD_VISIBLE, 'create', null, { name: 'Visible', type: 'string', order: 1 })
    await insertRev('sheet_config', SHEET, 'update', { rowLevelReadPermissionsEnabled: false }, { rowLevelReadPermissionsEnabled: true })
    await insertRev('permission', permId('sheet', ['user', SUBJECT]), 'create', null, { subjectType: 'user', subjectId: SUBJECT, accessLevel: 'read' })
    await insertRev('permission', permId('view', [VIEW_ID, 'user', SUBJECT]), 'create', null, { viewId: VIEW_ID, subjectType: 'user', subjectId: SUBJECT, permission: 'read' })
    await insertRev('permission', permId('field', [FLD_VISIBLE, 'user', SUBJECT]), 'create', null, { fieldId: FLD_VISIBLE, subjectType: 'user', subjectId: SUBJECT, visible: true, readOnly: false })
    // MALFORMED permission row (no scope prefix) — fail-closed: returned by NO endpoint.
    await insertRev('permission', 'garbage-no-scope-prefix', 'create', null, { x: 1 })
    // VIEW row whose after.filterInfo carries a literal on the SECRET field + the VISIBLE field.
    await insertRev('view', VIEW_ID, 'update', null, {
      filterInfo: { conjunction: 'and', conditions: [
        { fieldId: FLD_VISIBLE, operator: 'is', value: VISIBLE_LIT },
        { fieldId: FLD_SECRET, operator: 'is', value: SECRET_LIT },
      ] },
    })
  })

  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    for (const u of [U_FULL, U_WRITE, U_READ, U_FIELDDENIED, SEED_ACTOR, SUBJECT]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('FULL reads each surface; rows are scoped to the endpoint entity_type/scope', async () => {
    as(U_FULL, ['multitable:read', 'multitable:write', 'multitable:share'])
    const f = await get(`/sheets/${SHEET}/config-history/fields`)
    expect(f.status).toBe(200)
    expect(revisions(f).length).toBeGreaterThanOrEqual(1)
    expect(revisions(f).every((r) => r.entityType === 'field')).toBe(true)

    const sc = await get(`/sheets/${SHEET}/config-history/sheet-config`)
    expect(sc.status).toBe(200)
    expect(revisions(sc).every((r) => r.entityType === 'sheet_config')).toBe(true)

    const ps = await get(`/sheets/${SHEET}/config-history/permissions/sheet`)
    expect(ps.status).toBe(200)
    expect(revisions(ps).length).toBe(1)
    expect(revisions(ps).every((r) => r.entityType === 'permission' && String(r.entityId).startsWith('sheet:'))).toBe(true)

    const pv = await get(`/sheets/${SHEET}/config-history/permissions/view`)
    expect(revisions(pv).every((r) => String(r.entityId).startsWith('view:'))).toBe(true)
    const pf = await get(`/sheets/${SHEET}/config-history/permissions/field`)
    expect(revisions(pf).every((r) => String(r.entityId).startsWith('field:'))).toBe(true)
  })

  test('cross-cap: a WRITE-only user (no share) is 403 on sheet-config + permissions/sheet, 200 on fields/views/perm-view/perm-field', async () => {
    as(U_WRITE, ['multitable:read', 'multitable:write'])
    expect((await get(`/sheets/${SHEET}/config-history/sheet-config`)).status).toBe(403)
    expect((await get(`/sheets/${SHEET}/config-history/permissions/sheet`)).status).toBe(403)
    expect((await get(`/sheets/${SHEET}/config-history/fields`)).status).toBe(200)
    expect((await get(`/sheets/${SHEET}/config-history/views`)).status).toBe(200)
    expect((await get(`/sheets/${SHEET}/config-history/permissions/view`)).status).toBe(200)
    expect((await get(`/sheets/${SHEET}/config-history/permissions/field`)).status).toBe(200)
  })

  test('cross-cap: a READ-only user is 403 on every config-history endpoint', async () => {
    as(U_READ, ['multitable:read'])
    for (const p of ['fields', 'views', 'sheet-config', 'permissions/sheet', 'permissions/view', 'permissions/field']) {
      expect((await get(`/sheets/${SHEET}/config-history/${p}`)).status).toBe(403)
    }
  })

  test('VIEW redaction: FULL sees the SECRET filter literal; a field-denied view-manager does NOT (VISIBLE stays)', async () => {
    as(U_FULL, ['multitable:read', 'multitable:write', 'multitable:share'])
    const full = await get(`/sheets/${SHEET}/config-history/views`)
    expect(full.status).toBe(200)
    expect(bodyStr(full)).toContain(SECRET_LIT)
    expect(bodyStr(full)).toContain(VISIBLE_LIT)

    as(U_FIELDDENIED, ['multitable:read', 'multitable:write']) // canManageViews, but FLD_SECRET denied
    const denied = await get(`/sheets/${SHEET}/config-history/views`)
    expect(denied.status).toBe(200)
    expect(bodyStr(denied)).not.toContain(SECRET_LIT) // the keystone — no leak through history
    expect(bodyStr(denied)).toContain(VISIBLE_LIT) // no over-redaction
  })

  test('VIEW redaction END-TO-END (REAL recorder shape): a view filtered on a denied field is written via the route, recorded by R2, and the denied manager does NOT see the literal (non-filter config survives)', async () => {
    // Create + patch a view THROUGH the real routes so R2 records the actual shape (not a fixture).
    as(U_FULL, ['multitable:read', 'multitable:write', 'multitable:share'])
    const created = await request(app).post('/api/multitable/views').send({ sheetId: SHEET, name: 'E2E Redact View', type: 'grid' })
    expect(created.status).toBe(201)
    const e2eViewId = created.body?.data?.view?.id as string
    expect(e2eViewId).toBeTruthy()
    const patched = await request(app).patch(`/api/multitable/views/${e2eViewId}`).send({
      filterInfo: { conjunction: 'and', conditions: [
        { fieldId: FLD_VISIBLE, operator: 'is', value: VISIBLE_LIT },
        { fieldId: FLD_SECRET, operator: 'is', value: SECRET_LIT },
      ] },
    })
    expect(patched.status).toBe(200)

    // Sanity: the RAW recorded row holds the secret literal in the path the redactor must walk
    // (if this is absent, R2 stores a different shape and the redaction proof would be vacuous).
    const recorded = (await q(
      `SELECT after FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' AND entity_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [SHEET, e2eViewId],
    )).rows[0] as { after: any } | undefined
    expect(JSON.stringify(recorded?.after)).toContain(SECRET_LIT)

    // KEYSTONE: the field-denied view-manager reads it back through the API → literal redacted.
    as(U_FIELDDENIED, ['multitable:read', 'multitable:write'])
    const denied = await get(`/sheets/${SHEET}/config-history/views?limit=200`)
    expect(denied.status).toBe(200)
    const deniedRow = revisions(denied).find((r) => r.entityId === e2eViewId && r.action === 'update')
    expect(deniedRow).toBeTruthy()
    expect(JSON.stringify(deniedRow)).not.toContain(SECRET_LIT) // no leak through REAL-recorded history
    expect(JSON.stringify(deniedRow)).toContain(VISIBLE_LIT) // no over-redaction

    // Non-filter config survives redaction (the create revision's name round-trips, not stripped).
    as(U_FULL, ['multitable:read', 'multitable:write', 'multitable:share'])
    const all = await get(`/sheets/${SHEET}/config-history/views?limit=200`)
    const createRow = revisions(all).find((r) => r.entityId === e2eViewId && r.action === 'create')
    expect(JSON.stringify(createRow?.after)).toContain('E2E Redact View')
  })

  test('fail-closed: a malformed permission entity_id is returned by NO permission endpoint', async () => {
    as(U_FULL, ['multitable:read', 'multitable:write', 'multitable:share'])
    for (const sub of ['sheet', 'view', 'field']) {
      const r = await get(`/sheets/${SHEET}/config-history/permissions/${sub}`)
      expect(r.status).toBe(200)
      expect(bodyStr(r)).not.toContain('garbage-no-scope-prefix')
    }
  })

  test('pagination is deterministic (created_at DESC, id DESC)', async () => {
    const older = `fld_chr_pg_old_${TS}`
    const newer = `fld_chr_pg_new_${TS}`
    await insertRev('field', older, 'create', null, { name: 'old' }, '2026-01-01T00:00:00Z')
    await insertRev('field', newer, 'create', null, { name: 'new' }, '2026-01-02T00:00:00Z')
    as(U_FULL, ['multitable:read', 'multitable:write', 'multitable:share'])
    const r = await get(`/sheets/${SHEET}/config-history/fields?limit=200`)
    const ids = revisions(r).map((x) => x.entityId)
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older)) // newer first
  })
})
