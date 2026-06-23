/**
 * Global History — BS-2: SCOPED (multi-record) restore batch-preview (real DB). A fan-out of the single-record
 * preview over a record SET; READ-ONLY. Identifies the RESTORABLE scope (visible ∧ non-empty diff ∧ non-drift),
 * mints a SCOPED identity (BS-1) binding hashScope over that set, and reports skipped records with a reason.
 *
 * Goldens: write-free · all-restorable scope · hidden-field mask · mixed/PARTIAL (restorable + no-change + denied,
 * no oracle) · identity binds the RESTORABLE set only (JWT decode) · empty scope → null identity (no hashScope([]))
 * · bounded (fail-closed) · per-field filter. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { hashPreviewChanges, hashScope } from '../../src/multitable/restore-preview-identity'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_bp_${TS}`
const SHEET = `sheet_bp_${TS}`
const NAME = `fld_bp_name_${TS}`
const SALARY = `fld_bp_salary_${TS}` // field_permissions-denied to the actor in the mask golden
const A = `rec_bp_a_${TS}`
const B = `rec_bp_b_${TS}`
const C = `rec_bp_c_${TS}`
const ACTOR = `user_bp_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curUser = ACTOR
let curRoles = ['member']
const batchPreview = (recordIds: string[], body: Record<string, unknown> = {}) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/restore-batch-preview`).send({ targetVersion: 1, recordIds, ...body })
const recordRow = async (recordId: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [recordId])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const denyField = (fieldId: string) => q(`INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false) ON CONFLICT DO NOTHING`, [SHEET, fieldId, ACTOR])
const clearFieldDeny = () => q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET])

// Each record: v2 current {NAME:'b', SALARY:200}; v1 snapshot {NAME:'a', SALARY:100} → restorable (NAME + SALARY change).
async function seedRecord(id: string): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [id, SHEET, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
  await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
           VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, id, NAME, SALARY, JSON.stringify({ [NAME]: 'a', [SALARY]: 100 })])
  await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
           VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, id, NAME, SALARY, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
}

describeIfDatabase('multitable scoped restore batch-preview — BS-2 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: curUser, roles: curRoles, perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'BP Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'BP Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })

  afterAll(async () => {
    for (const t of ['field_permissions', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  beforeEach(async () => {
    curUser = ACTOR; curRoles = ['member']
    await clearFieldDeny()
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = false, conditional_read_rules = '[]'::jsonb WHERE id = $1", [SHEET])
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    for (const id of [A, B, C]) await seedRecord(id)
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('write-free: a batch preview changes NOTHING (every record version + data unchanged)', async () => {
    const before = await Promise.all([A, B, C].map(recordRow))
    const res = await batchPreview([A, B, C])
    expect(res.status).toBe(200)
    const after = await Promise.all([A, B, C].map(recordRow))
    for (let i = 0; i < 3; i += 1) {
      expect(after[i]?.version).toBe(before[i]?.version)
      expect(after[i]?.data).toEqual(before[i]?.data)
    }
  })

  test('all-restorable: scope = the full set, count 3, an executable identity is minted', async () => {
    const res = await batchPreview([A, B, C])
    expect(res.status).toBe(200)
    expect(res.body?.data?.restorableCount).toBe(3)
    expect(res.body?.data?.scope).toEqual([A, B, C].sort())
    expect(res.body?.data?.previewIdentity).toBeTruthy()
    expect(res.body?.data?.records?.every((r: { status: string; affectedFieldCount: number }) => r.status === 'restorable' && r.affectedFieldCount === 2)).toBe(true)
  })

  test('mask: a field_permissions-denied field is ABSENT from every record diff', async () => {
    await denyField(SALARY)
    const res = await batchPreview([A, B, C])
    for (const r of res.body?.data?.records ?? []) {
      const ids = (r.changes ?? []).map((c: { fieldId: string }) => c.fieldId)
      expect(ids).toContain(NAME)
      expect(ids).not.toContain(SALARY)
      expect(r.affectedFieldCount).toBe(1)
    }
  })

  test('mixed/PARTIAL: restorable + no-change + row-denied → scope is the restorable set only, no oracle', async () => {
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [B, JSON.stringify({ [NAME]: 'a', [SALARY]: 100 })]) // B already AT v1 → nets zero
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [C, JSON.stringify({ [NAME]: 'secret_c', [SALARY]: 200 })])
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $2::jsonb WHERE id = $1", [SHEET, JSON.stringify([{ id: 'r1', fieldId: NAME, operator: 'eq', value: 'secret_c', effect: 'deny_read' }])])
    const res = await batchPreview([A, B, C])
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body?.data?.records ?? []).map((r: { recordId: string }) => [r.recordId, r]))
    expect(byId[A].status).toBe('restorable')
    expect(byId[B].skipReason).toBe('no_change')
    expect(byId[C].skipReason).toBe('unavailable') // denied + missing share one reason → no existence oracle
    expect(res.body?.data?.scope).toEqual([A]) // the identity binds A only
    expect(res.body?.data?.restorableCount).toBe(1)
    expect(res.body?.data?.previewIdentity).toBeTruthy()
  })

  test('identity binds the RESTORABLE set ONLY (scope.recordIds + scopeHash decode to A, not the requested A,B,C)', async () => {
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [B, JSON.stringify({ [NAME]: 'a', [SALARY]: 100 })]) // no-change
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [C, JSON.stringify({ [NAME]: 'a', [SALARY]: 100 })]) // no-change
    const res = await batchPreview([A, B, C]) // only A is restorable
    const payload = jwt.decode(res.body?.data?.previewIdentity as string) as { scope?: { recordIds?: string[] }; scopeHash?: string; type?: string }
    expect(payload?.type).toBe('restore-preview-scoped')
    expect(payload?.scope?.recordIds).toEqual([A]) // NOT [A,B,C] — the skipped records never enter the identity
    const aRow = (res.body?.data?.records ?? []).find((r: { recordId: string }) => r.recordId === A)
    expect(aRow?.previewVersion).toBe(2) // BS-2 returns each restorable record's preview-time version (the FE submits it back)
    // and the scopeHash is exactly hashScope over A's per-record diff + its preview version (write-set ≡ hashed-set + #2 version bind)
    const aChanges = aRow?.changes as Array<{ fieldId: string; op: 'set' | 'unset'; value: unknown }>
    expect(payload?.scopeHash).toBe(hashScope([{ recordId: A, changesHash: hashPreviewChanges(aChanges), version: 2 }]))
  })

  test('empty scope → null identity (all records net zero → never a hashScope([]) executable token)', async () => {
    for (const id of [A, B, C]) await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify({ [NAME]: 'a', [SALARY]: 100 })])
    const res = await batchPreview([A, B, C])
    expect(res.status).toBe(200)
    expect(res.body?.data?.restorableCount).toBe(0)
    expect(res.body?.data?.scope).toEqual([])
    expect(res.body?.data?.previewIdentity).toBeNull() // withheld — no executable identity over an empty scope
    expect((res.body?.data?.records ?? []).every((r: { skipReason: string }) => r.skipReason === 'no_change')).toBe(true)
  })

  test('bounded: a scope over the cap is fail-closed (400), never silently truncated', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `rec_overflow_${i}`)
    const res = await batchPreview(tooMany)
    expect(res.status).toBe(400)
  })

  test('per-field filter: fieldIds narrows each record diff (mask-then-filter)', async () => {
    const res = await batchPreview([A], { fieldIds: [NAME] })
    const a = (res.body?.data?.records ?? [])[0]
    expect(a.status).toBe('restorable')
    expect(a.changes.map((c: { fieldId: string }) => c.fieldId)).toEqual([NAME]) // SALARY filtered out
    expect(a.affectedFieldCount).toBe(1)
  })
})
