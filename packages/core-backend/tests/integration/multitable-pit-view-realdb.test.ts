/**
 * Global History — T7: point-in-time read-only view (real DB).
 *
 * The view is "the table as of T", restricted to records that CURRENTLY EXIST. The load-bearing security claim
 * is the ORACLE-NEGATIVE: a record that was readable at T but is DENIED now (current row-deny) must NOT appear —
 * otherwise the PIT view is an oracle to read a currently-forbidden record's historical contents. Row-deny is
 * the SAME loadDeniedRecordIds seam as the history surfaces (grant-deny ∪ 2b conditional read-deny), evaluated
 * against CURRENT data (current-deny, never as-of-T). field-mask reuses the history allowed-field chain.
 * deleted-since-T records are OUT of v1 (product scope, not a safety deny).
 *
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_pit_${TS}`
const SHEET = `sheet_pit_${TS}`
const STATUS = `fld_pit_status_${TS}`
const SALARY = `fld_pit_salary_${TS}` // field_permissions-denied to VIEWER
const REC_PUBLIC = `rec_pit_public_${TS}` // readable now + at T
const REC_ORACLE = `rec_pit_oracle_${TS}` // PUBLIC at T, but DENIED now (the oracle test)
const REC_DELETED = `rec_pit_deleted_${TS}` // existed at T, deleted since (out of v1)
const VIEWER = `user_pit_viewer_${TS}`
const T1 = '2026-06-01T00:00:00Z' // the as-of point (records public here)
const T2 = '2026-06-02T00:00:00Z' // later: oracle goes secret, deleted record is deleted
const AS_OF = '2026-06-01T12:00:00Z' // between T1 and T2

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curUser = VIEWER
let curRoles = ['member']
const asUser = (id: string, roles: string[]) => { curUser = id; curRoles = roles }

const rev = (recordId: string, version: number, action: 'create' | 'update' | 'delete', data: Record<string, unknown>, createdAt: string) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'rest', ARRAY[$5]::text[], '{}'::jsonb, $6::jsonb, $7)`,
    [SHEET, recordId, version, action, STATUS, JSON.stringify(data), createdAt],
  )
const setRules = (rules: unknown[]) => q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET, JSON.stringify(rules)])
const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET, on])
const pit = (query: Record<string, unknown> = {}) => request(app).get(`/api/multitable/sheets/${SHEET}/point-in-time`).query({ asOf: AS_OF, ...query })
const recordIds = (res: { body?: { data?: { records?: Array<{ recordId: string }> } } }) => (res.body?.data?.records ?? []).map((r) => r.recordId)

describeIfDatabase('multitable point-in-time read-only view — T7 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: curUser, roles: curRoles, perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'PIT Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'PIT Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET, 'Status', 'select', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [VIEWER])
    // CURRENT live records (meta_records): REC_PUBLIC + REC_ORACLE exist now; REC_DELETED does NOT.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [REC_PUBLIC, SHEET, JSON.stringify({ [STATUS]: 'public', [SALARY]: 100 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [REC_ORACLE, SHEET, JSON.stringify({ [STATUS]: 'secret', [SALARY]: 200 })]) // DENIED now
    // Revisions: each record was PUBLIC at T1; the oracle went secret at T2; the deleted record was deleted at T2.
    await rev(REC_PUBLIC, 1, 'create', { [STATUS]: 'public', [SALARY]: 100 }, T1)
    await rev(REC_ORACLE, 1, 'create', { [STATUS]: 'public', [SALARY]: 200 }, T1) // PUBLIC at T1
    await rev(REC_ORACLE, 2, 'update', { [STATUS]: 'secret', [SALARY]: 200 }, T2) // secret since T2
    await rev(REC_DELETED, 1, 'create', { [STATUS]: 'public' }, T1) // existed at T1
    await rev(REC_DELETED, 2, 'delete', { [STATUS]: 'public' }, T2) // deleted since T2
    // field_permissions: deny SALARY to VIEWER. conditional_read_rules: deny status='secret'.
    await q(`INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false)`, [SHEET, SALARY, VIEWER])
    await setRules([{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }])
    await setFlag(true)
  })

  afterAll(async () => {
    for (const t of ['field_permissions', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [VIEWER]).catch(() => {})
  })

  beforeEach(() => { asUser(VIEWER, ['member']) })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('ORACLE-NEGATIVE: a record public-at-T but DENIED-now is ABSENT (not in records, not in total)', async () => {
    const res = await pit()
    expect(res.status).toBe(200)
    expect(recordIds(res)).not.toContain(REC_ORACLE) // current-deny: never shows a currently-denied record's T-state
    expect(recordIds(res)).toContain(REC_PUBLIC) // non-vacuous: the genuinely-readable record IS present
    expect(res.body?.data?.total).toBe(1) // total counts only the visible record (oracle + deleted excluded)
  })

  test('positive: a currently-readable record shows its AS-OF-T state', async () => {
    const c = (await pit()).body?.data?.records?.find((r: { recordId: string }) => r.recordId === REC_PUBLIC) as { data: Record<string, unknown> } | undefined
    expect(c?.data?.[STATUS]).toBe('public') // T-state
  })

  test('field-mask: a field_permissions-denied field is absent from the as-of-T record', async () => {
    const c = (await pit()).body?.data?.records?.find((r: { recordId: string }) => r.recordId === REC_PUBLIC) as { data: Record<string, unknown> } | undefined
    expect(c?.data?.[SALARY]).toBeUndefined() // SALARY denied to VIEWER → masked even in the PIT view
    expect(c?.data?.[STATUS]).toBe('public') // visible field still present (surgical mask)
  })

  test('deleted-since-T is OUT of v1 (product scope): a record that existed at T but is deleted now is absent', async () => {
    expect(recordIds(await pit())).not.toContain(REC_DELETED)
  })

  test('admin bypass: an admin sees the now-denied record (parity with the other history surfaces)', async () => {
    asUser('admin_pit', ['admin'])
    expect(recordIds(await pit())).toContain(REC_ORACLE) // admin bypasses row-deny
  })

  test('validation: a missing / invalid asOf is a 400', async () => {
    expect((await request(app).get(`/api/multitable/sheets/${SHEET}/point-in-time`)).status).toBe(400)
    expect((await pit({ asOf: 'not-a-date' })).status).toBe(400)
  })
})
