/**
 * Global History — T5-2: record-version restore PREVIEW (real DB). Read-only diff of what a Layer-1 restore
 * WOULD apply, masked to the actor's allowed fields, write-free.
 *
 * Goldens (advisor order): PV-1 write-free · PV-2 hidden-field masked (+ mutation) · preview→restore consistency
 * (the dup-helper guard) · denied-record → 404 no-oracle.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_rp_${TS}`
const SHEET = `sheet_rp_${TS}`
const NAME = `fld_rp_name_${TS}`
const SALARY = `fld_rp_salary_${TS}` // field_permissions-denied to VIEWER (PV-2)
const REC = `rec_rp_${TS}`
const REC_DENIED = `rec_rp_denied_${TS}`
const VIEWER = `user_rp_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curUser = VIEWER
let curRoles = ['member']
const preview = (recordId: string, body: Record<string, unknown>) => request(app).post(`/api/multitable/sheets/${SHEET}/records/${recordId}/restore-preview`).send(body)
const restore = (recordId: string, body: Record<string, unknown>) => request(app).post(`/api/multitable/sheets/${SHEET}/records/${recordId}/restore`).send(body)
const recordRow = async (recordId: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [recordId])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const denyField = (fieldId: string) => q(`INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false) ON CONFLICT DO NOTHING`, [SHEET, fieldId, VIEWER])
const clearFieldDeny = () => q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET])

describeIfDatabase('multitable record-version restore preview — T5-2 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: curUser, roles: curRoles, perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RP Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'RP Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [VIEWER])
  })

  afterAll(async () => {
    for (const t of ['field_permissions', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [VIEWER]).catch(() => {})
  })

  // Fresh record at v2 {NAME:'b', SALARY:200}; v1 snapshot was {NAME:'a', SALARY:100}.
  beforeEach(async () => {
    curUser = VIEWER; curRoles = ['member']
    await clearFieldDeny()
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = false, conditional_read_rules = '[]'::jsonb WHERE id = $1", [SHEET])
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [REC, SHEET, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
    await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
             VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, REC, NAME, SALARY, JSON.stringify({ [NAME]: 'a', [SALARY]: 100 })])
    await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
             VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, REC, NAME, SALARY, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('PV-1 write-free: preview changes NOTHING (record version + data unchanged after)', async () => {
    const before = await recordRow(REC)
    const res = await preview(REC, { targetVersion: 1 })
    expect(res.status).toBe(200)
    expect(res.body?.data?.changes?.length).toBe(2) // NAME + SALARY would change
    const after = await recordRow(REC)
    expect(after?.version).toBe(before?.version) // version unchanged
    expect(after?.data).toEqual(before?.data) // data unchanged — the whole read-only claim
  })

  test('PV-2 mask: a field_permissions-denied field is ABSENT from the preview diff', async () => {
    await denyField(SALARY)
    const res = await preview(REC, { targetVersion: 1 })
    const ids = (res.body?.data?.changes ?? []).map((c: { fieldId: string }) => c.fieldId)
    expect(ids).toContain(NAME) // visible field present
    expect(ids).not.toContain(SALARY) // hidden field's change masked out of the preview
    expect(res.body?.data?.visibleAffectedFieldCount).toBe(1)
  })

  test('preview→restore consistency: the previewed changes are exactly what a restore writes', async () => {
    const pv = await preview(REC, { targetVersion: 1 })
    const changes = pv.body?.data?.changes as Array<{ fieldId: string; value: unknown }>
    const r = await restore(REC, { targetVersion: 1, expectedVersion: 2 })
    expect(r.status).toBe(200)
    const after = await recordRow(REC)
    // every previewed change landed with the previewed value; nothing the preview omitted changed away from v1.
    for (const c of changes) expect(after?.data?.[c.fieldId]).toEqual(c.value)
    expect(after?.data?.[NAME]).toBe('a') // restored to v1
    expect(after?.data?.[SALARY]).toBe(100)
  })

  test('no-oracle: a row-denied record previews as 404 (same shape as missing — no existence oracle)', async () => {
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_DENIED, SHEET, JSON.stringify({ [NAME]: 'secret' })])
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $2::jsonb WHERE id = $1", [SHEET, JSON.stringify([{ id: 'r1', fieldId: NAME, operator: 'eq', value: 'secret', effect: 'deny_read' }])])
    const res = await preview(REC_DENIED, { targetVersion: 1 })
    expect(res.status).toBe(404) // denied → not-found shape, no oracle
    await q('DELETE FROM meta_records WHERE id = $1', [REC_DENIED])
  })

  test('validation: a missing / invalid targetVersion is a 400; a nonexistent version is 404', async () => {
    expect((await preview(REC, {})).status).toBe(400)
    expect((await preview(REC, { targetVersion: 999 })).status).toBe(404)
  })
})
