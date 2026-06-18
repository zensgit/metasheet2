/**
 * #16/P1 ROUTE-LEVEL parity — the restrictToMemberGroupIds person guard must enforce on the REAL
 * write routes, not just RecordWriteService. The prior #2833 test hit the service directly and missed
 * that POST /records + PATCH /records/:id + POST /views/:viewId/submit go through RecordService.
 * Also covers the two P2s: admin-bypass on GET /form-context + GET /sheets/:sheetId/trash, and the
 * multiSelect-person /patch guard (property carried so it is not wrongly rejected as single).
 * Real-DB only (sentinel skips without DATABASE_URL).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_prp_${TS}`
const SHEET_ID = `sheet_prp_${TS}`
const VIEW_ID = `view_prp_${TS}`
const REC_GF = `rec_prp_gf_${TS}`
const REC_SECRET = `rec_prp_secret_${TS}`
const ACTOR = `u_prp_actor_${TS}`
const ADMIN = `u_prp_admin_${TS}`
const G_ALLOW = '31111111-1111-4111-8111-111111111111'
const G_OTHER = '32222222-2222-4222-8222-222222222222'
const U_IN = `u_prp_in_${TS}`
const U_OUT = `u_prp_out_${TS}`
const F_PERSON = 'fld_prp_person'
const F_PERSON_MULTI = 'fld_prp_person_multi'
const F_STR = 'fld_prp_str'

function buildApp(userId: string, perms: string[], roles: string[] = ['member']): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as Record<string, unknown>).user = { id: userId, roles, perms, permissions: perms }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}
const actorApp = () => buildApp(ACTOR, ['multitable:read', 'multitable:write'])
const adminApp = () => buildApp(ADMIN, ['multitable:read', 'multitable:write'], ['admin'])

const recData = async (recId: string): Promise<Record<string, unknown>> => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recId])
  return (r.rows[0] as { data?: Record<string, unknown> } | undefined)?.data ?? {}
}

describeIfDatabase('#16/P1 person restrict route parity + P2 admin-bypass/multiSelect (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'PRP Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'PRP Sheet'])
    await q('INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (id) DO NOTHING',
      [VIEW_ID, SHEET_ID, 'Form', 'form', JSON.stringify({})]).catch(() => {})
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_PERSON, SHEET_ID, 'Owner', 'person', JSON.stringify({ restrictToMemberGroupIds: [G_ALLOW] }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_PERSON_MULTI, SHEET_ID, 'Owners', 'person', JSON.stringify({ limitSingleRecord: false }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_STR, SHEET_ID, 'Note', 'string', '{}', 3])
    for (const uid of [ACTOR, ADMIN, U_IN, U_OUT]) {
      await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin) VALUES ($1,$2,$3,'x','user','[]'::jsonb,TRUE,FALSE) ON CONFLICT (id) DO NOTHING`, [uid, `${uid}@t.local`, uid])
      await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'multitable:read') ON CONFLICT DO NOTHING`, [uid])
    }
    await q('INSERT INTO platform_member_groups (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [G_ALLOW, 'Allowed'])
    await q('INSERT INTO platform_member_groups (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [G_OTHER, 'Other'])
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [G_ALLOW, U_IN])
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [G_OTHER, U_OUT])
  })
  beforeEach(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    // grandfather row: pre-existing OUT-of-scope person value, inserted directly (bypasses validation)
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_GF, SHEET_ID, JSON.stringify({ [F_PERSON]: [U_OUT], [F_STR]: 'orig' })])
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false, conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, '[]']).catch(() => {})
  })
  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM platform_member_group_members WHERE group_id = ANY($1)', [[G_ALLOW, G_OTHER]]).catch(() => {})
    await q('DELETE FROM platform_member_groups WHERE id = ANY($1)', [[G_ALLOW, G_OTHER]]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1)', [[ACTOR, ADMIN, U_IN, U_OUT]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1)', [[ACTOR, ADMIN, U_IN, U_OUT]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ---- P1: route-level enforcement ----
  test('POST /records — in-group user accepted, out-of-group REJECTED', async () => {
    const ok = await request(actorApp()).post('/api/multitable/records').send({ sheetId: SHEET_ID, data: { [F_PERSON]: [U_IN] } })
    expect(ok.status).toBe(200)
    const bad = await request(actorApp()).post('/api/multitable/records').send({ sheetId: SHEET_ID, data: { [F_PERSON]: [U_OUT] } })
    expect(bad.status).toBeGreaterThanOrEqual(400)
    expect(bad.status).toBeLessThan(500)
  })

  test('PATCH /records/:id — out-of-group REJECTED, in-group accepted', async () => {
    const created = await request(actorApp()).post('/api/multitable/records').send({ sheetId: SHEET_ID, data: { [F_STR]: 'x' } })
    const recId = (created.body?.data?.record?.id) as string
    expect(recId).toBeTruthy()
    const bad = await request(actorApp()).patch(`/api/multitable/records/${recId}`).send({ sheetId: SHEET_ID, data: { [F_PERSON]: [U_OUT] } })
    expect(bad.status).toBeGreaterThanOrEqual(400)
    expect(bad.status).toBeLessThan(500)
    const ok = await request(actorApp()).patch(`/api/multitable/records/${recId}`).send({ sheetId: SHEET_ID, data: { [F_PERSON]: [U_IN] } })
    expect(ok.status).toBe(200)
  })

  test('grandfather — pre-existing out-of-scope person value still reads back', async () => {
    const data = await recData(REC_GF)
    expect(data[F_PERSON]).toEqual([U_OUT])
  })

  test('POST /views/:viewId/submit — out-of-group person REJECTED (form path)', async () => {
    const bad = await request(actorApp()).post(`/api/multitable/views/${VIEW_ID}/submit`).send({ data: { [F_PERSON]: [U_OUT], [F_STR]: 'viaform' } })
    expect(bad.status).toBeGreaterThanOrEqual(400)
    expect(bad.status).toBeLessThan(500)
  })

  // ---- P2: multiSelect person guard (property carried) ----
  test('POST /patch — multiSelect person accepts an array (not rejected as single)', async () => {
    const created = await request(actorApp()).post('/api/multitable/records').send({ sheetId: SHEET_ID, data: { [F_STR]: 'm' } })
    const recId = (created.body?.data?.record?.id) as string
    const res = await request(actorApp()).post('/api/multitable/patch').send({ sheetId: SHEET_ID, changes: [{ recordId: recId, fieldId: F_PERSON_MULTI, value: [U_IN, U_OUT] }] })
    expect(res.status).toBe(200)
    expect((await recData(recId))[F_PERSON_MULTI]).toEqual([U_IN, U_OUT])
  })

  // ---- P2: admin bypass on form-context + trash under a conditional deny rule ----
  test('admin bypass — GET /form-context + GET /trash see a rule-denied record', async () => {
    const created = await request(actorApp()).post('/api/multitable/records').send({ sheetId: SHEET_ID, data: { [F_STR]: 'secret' } })
    const recId = (created.body?.data?.record?.id) as string
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $2::jsonb WHERE id = $1',
      [SHEET_ID, JSON.stringify([{ id: 'r1', fieldId: F_STR, operator: 'eq', value: 'secret', effect: 'deny_read' }])])
    // non-admin: denied at single GET
    const nonAdmin = await request(actorApp()).get(`/api/multitable/records/${recId}`).query({ sheetId: SHEET_ID })
    expect([403, 404]).toContain(nonAdmin.status)
    // admin: form-context still resolves the record (bypass)
    const fc = await request(adminApp()).get('/api/multitable/form-context').query({ sheetId: SHEET_ID, recordId: recId })
    expect(fc.status).toBe(200)
    // delete + admin trash list still shows it (bypass)
    await request(adminApp()).delete(`/api/multitable/records/${recId}`).send({ sheetId: SHEET_ID })
    const trash = await request(adminApp()).get(`/api/multitable/sheets/${SHEET_ID}/trash`)
    expect(trash.status).toBe(200)
    const ids = (trash.body?.data?.records ?? []).map((r: { recordId: string }) => r.recordId)
    expect(ids).toContain(recId)
  })
})
