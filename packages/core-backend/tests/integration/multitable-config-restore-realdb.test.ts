/**
 * T9-W — config-restore (write half) — real DB. Verifies: preview is write-free; a safe revert restores the prior
 * config AND records a source=restore revision (L1); the per-entity gate (L3); gated ops refused (L6); drift (L5) +
 * stale-preview (L4) + idempotency rejected; and atomicity (L7 — a failed restore-revision insert rolls the config
 * write back). Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_cw_${TS}`
const SHEET = `sheet_cw_${TS}`
const FIELD = `fld_cw_${TS}`
const VIEW = `view_cw_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let currentActor: { id: string; roles: string[]; perms: string[] }
const ADMIN = { id: `u_admin_${TS}`, roles: ['admin'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
const READER = { id: `u_reader_${TS}`, roles: ['member'], perms: ['multitable:read'] }

const preview = (as: typeof ADMIN, revisionId: string) => { currentActor = as; return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-preview`).send({ revisionId }) }
const execute = (as: typeof ADMIN, body: Record<string, unknown>) => { currentActor = as; return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-execute`).send(body) }
const fieldName = async () => String(((await q('SELECT name FROM meta_fields WHERE id = $1', [FIELD])).rows[0] as { name: string }).name)
const insertRev = async (entityType: string, entityId: string, before: unknown, after: unknown, changedKeys: string[]) =>
  String(((await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, actor_id)
     VALUES ($1,$2,$3,'update',$4::jsonb,$5::jsonb,$6::text[],$7) RETURNING id`,
    [SHEET, entityType, entityId, JSON.stringify(before), JSON.stringify(after), changedKeys, ADMIN.id],
  )).rows[0] as { id: string }).id)

let REV_FIELD = '' // a recorded field rename Old→New
let REV_VIEW = '' // a recorded view filter change
let REV_GATED = '' // a recorded field RETYPE (gated in this slice)

describeIfDatabase('multitable config-restore — T9-W (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentActor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'CW Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'CW Sheet'])
    // field currently named 'New' (post-rename); the revision records Old→New
    await q(`INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,'New','string','{}'::jsonb,0)`, [FIELD, SHEET])
    REV_FIELD = await insertRev('field', FIELD, { name: 'Old' }, { name: 'New' }, ['name'])
    // view currently filtered {q:'new'}; the revision records {q:'old'}→{q:'new'}
    await q(`INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
             VALUES ($1,$2,'V','grid','{"q":"new"}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb)`, [VIEW, SHEET])
    REV_VIEW = await insertRev('view', VIEW, { filterInfo: { q: 'old' } }, { filterInfo: { q: 'new' } }, ['filterInfo'])
    REV_GATED = await insertRev('field', FIELD, { type: 'string' }, { type: 'number' }, ['type'])
  })
  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('preview is WRITE-FREE and shows the revert target + safe classification', async () => {
    const before = await fieldName()
    const res = await preview(ADMIN, REV_FIELD)
    expect(res.status).toBe(200)
    expect(res.body?.data?.preview).toMatchObject({ entityType: 'field', entityId: FIELD, opKind: 'safe', driftConflict: false })
    expect(res.body.data.preview.current).toMatchObject({ name: 'New' })
    expect(res.body.data.preview.target).toMatchObject({ name: 'Old' })
    expect(res.body.data.preview.baselineHash).toBeTruthy()
    expect(await fieldName()).toBe(before) // nothing written
  })

  test('execute reverts the field rename AND records a source=restore revision (L1)', async () => {
    const pv = await preview(ADMIN, REV_FIELD)
    const res = await execute(ADMIN, { revisionId: REV_FIELD, previewToken: pv.body.data.previewToken })
    expect(res.status).toBe(200)
    expect(await fieldName()).toBe('Old') // reverted
    const restoreRevs = await q(`SELECT before, after, source, restored_from_id FROM meta_config_revisions WHERE source = 'restore' AND restored_from_id = $1`, [REV_FIELD])
    expect(restoreRevs.rows.length).toBe(1)
    expect(restoreRevs.rows[0]).toMatchObject({ source: 'restore', restored_from_id: REV_FIELD })
    expect((restoreRevs.rows[0] as any).after).toMatchObject({ name: 'Old' }) // the restore moved New→Old
    // reset for later tests
    await q(`UPDATE meta_fields SET name = 'New' WHERE id = $1`, [FIELD])
    await q(`DELETE FROM meta_config_revisions WHERE source = 'restore'`, [])
  })

  test('a non-manager (canManageFields=false) is FORBIDDEN to preview or execute (L3)', async () => {
    expect((await preview(READER, REV_FIELD)).status).toBe(403)
    expect((await execute(READER, { revisionId: REV_FIELD, previewToken: 'x' })).status).toBe(403)
  })

  test('a gated op (field RETYPE) is refused 422, not partially attempted (L6)', async () => {
    const before = await fieldName()
    const res = await execute(ADMIN, { revisionId: REV_GATED, previewToken: 'whatever' })
    expect(res.status).toBe(422)
    expect(res.body?.error?.code).toBe('RESTORE_NOT_SUPPORTED')
    expect(await fieldName()).toBe(before) // untouched
  })

  test('execute REQUIRES a server-minted preview identity — a client-computed hash cannot skip preview (L4/D5)', async () => {
    const pv = await preview(ADMIN, REV_FIELD)
    // no token → 400 (cannot execute without previewing)
    expect((await execute(ADMIN, { revisionId: REV_FIELD })).status).toBe(400)
    // a forged / non-server token → 401 (signature fails)
    const forged = await execute(ADMIN, { revisionId: REV_FIELD, previewToken: 'not.a.valid.jwt' })
    expect(forged.status).toBe(401)
    expect(forged.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')
    // the load-bearing golden: knowing the correct (client-computable) baselineHash is NOT enough — without the
    // server-minted token, execute still fails. Preview-first cannot be bypassed.
    const hashOnly = await execute(ADMIN, { revisionId: REV_FIELD, baselineHash: pv.body.data.preview.baselineHash } as Record<string, unknown>)
    expect(hashOnly.status).toBe(400)
    expect(await fieldName()).toBe('New') // nothing reverted by any of the rejected attempts
    // the genuine server token works
    expect((await execute(ADMIN, { revisionId: REV_FIELD, previewToken: pv.body.data.previewToken })).status).toBe(200)
    await q(`UPDATE meta_fields SET name = 'New' WHERE id = $1`, [FIELD])
    await q(`DELETE FROM meta_config_revisions WHERE source = 'restore'`, [])
  })

  test('drift + idempotency: after a revert, replaying the same revision is rejected (L5/L7)', async () => {
    const pv = await preview(ADMIN, REV_FIELD)
    expect((await execute(ADMIN, { revisionId: REV_FIELD, previewToken: pv.body.data.previewToken })).status).toBe(200)
    expect(await fieldName()).toBe('Old')
    // replay with the SAME (now-stale) hash → stale
    expect((await execute(ADMIN, { revisionId: REV_FIELD, previewToken: pv.body.data.previewToken })).status).toBe(409)
    // a FRESH preview now flags drift (current 'Old' != the revision's after 'New') → execute rejected CONFIG_DRIFT
    const pv2 = await preview(ADMIN, REV_FIELD)
    expect(pv2.body.data.preview.driftConflict).toBe(true)
    const res = await execute(ADMIN, { revisionId: REV_FIELD, previewToken: pv2.body.data.previewToken })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('CONFIG_DRIFT')
    await q(`UPDATE meta_fields SET name = 'New' WHERE id = $1`, [FIELD])
    await q(`DELETE FROM meta_config_revisions WHERE source = 'restore'`, [])
  })

  test('view config revert restores the prior filter', async () => {
    const pv = await preview(ADMIN, REV_VIEW)
    expect(pv.body.data.preview.opKind).toBe('safe')
    expect((await execute(ADMIN, { revisionId: REV_VIEW, previewToken: pv.body.data.previewToken })).status).toBe(200)
    const filter = (await q('SELECT filter_info FROM meta_views WHERE id = $1', [VIEW])).rows[0] as { filter_info: unknown }
    expect(JSON.stringify(filter.filter_info)).toBe(JSON.stringify({ q: 'old' }))
    await q(`UPDATE meta_views SET filter_info = '{"q":"new"}'::jsonb WHERE id = $1`, [VIEW])
    await q(`DELETE FROM meta_config_revisions WHERE source = 'restore'`, [])
  })

  test('ATOMICITY (L7): a failing restore-revision insert rolls the config write back', async () => {
    await q(`CREATE OR REPLACE FUNCTION _t9w_fail() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 't9w injected'; END; $f$ LANGUAGE plpgsql`, [])
    await q('CREATE TRIGGER _t9w_fail_trg BEFORE INSERT ON meta_config_revisions FOR EACH ROW EXECUTE FUNCTION _t9w_fail()', [])
    try {
      const pv = await preview(ADMIN, REV_FIELD)
      const res = await execute(ADMIN, { revisionId: REV_FIELD, previewToken: pv.body.data.previewToken })
      expect(res.status).not.toBe(200) // the recording threw → whole txn rolled back
      expect(await fieldName()).toBe('New') // the field name did NOT revert — config write rolled back with it
    } finally {
      await q('DROP TRIGGER IF EXISTS _t9w_fail_trg ON meta_config_revisions', [])
      await q('DROP FUNCTION IF EXISTS _t9w_fail()', [])
    }
  })
})
