/**
 * Global History — BS-3.1: SCOPED (multi-record) restore batch-execute, the ALL-OR-NOTHING opt-in (real DB).
 * Per the SR-5 / D2 design-lock: `allOrNothing: true` makes any single denied/forbidden/conflicted record in scope
 * block the ENTIRE batch (one transaction, ZERO writes) → 409 BATCH_RESTORE_BLOCKED; default (false) is the
 * back-compat PARTIAL skip+report. Same per-record preflight gates as PARTIAL, re-applied before the atomic write.
 *
 * Goldens: (a) all-permitted → applies ALL (every row written, versions bumped) · (b) one row-DENIED → 409,
 * NOTHING written (every version unchanged — preflight blocks before any write) · (c) one CONFLICT (version moved
 * since preview) → 409, NOTHING written (the TRANSACTION-ROLLBACK keystone: the write phase started but rolled the
 * whole batch back) · (d)/(e) default & explicit-false stay PARTIAL skip-and-apply-the-rest (back-compat) · (f) one
 * FORBIDDEN field (layer-3 read_only) → 409, NOTHING written (the third blocker reason, distinct from denied/conflict).
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_aon_${TS}`
const SHEET = `sheet_aon_${TS}`
const NAME = `fld_aon_name_${TS}`
const SALARY = `fld_aon_salary_${TS}`
const A = `rec_aon_a_${TS}`
const B = `rec_aon_b_${TS}`
const C = `rec_aon_c_${TS}`
const ACTOR = `user_aon_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curUser = ACTOR
let curRoles = ['member']
const batchPreview = (recordIds: string[], body: Record<string, unknown> = {}) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/restore-batch-preview`).send({ targetVersion: 1, recordIds, ...body })
const batchExecute = (recordIds: string[], expectedVersions: Record<string, number>, previewIdentity: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/restore-batch-execute`).send({ targetVersion: 1, recordIds, expectedVersions, previewIdentity, ...body })
const recordRow = async (recordId: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [recordId])).rows[0] as { data: Record<string, unknown>; version: number } | undefined

async function seedRecord(id: string): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [id, SHEET, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
  await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
           VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, id, NAME, SALARY, JSON.stringify({ [NAME]: 'a', [SALARY]: 100 })])
  await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
           VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, id, NAME, SALARY, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
}
// mint a real identity through the actual preview route (no hand-built tokens — the real drift guard)
async function freshIdentity(recordIds: string[]): Promise<{ token: string; scope: string[] }> {
  const pv = await batchPreview(recordIds)
  return { token: pv.body?.data?.previewIdentity as string, scope: pv.body?.data?.scope as string[] }
}

describeIfDatabase('multitable scoped restore batch-execute — BS-3.1 all-or-nothing (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: curUser, roles: curRoles, perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'AON Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'AON Sheet'])
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
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET])
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = false, conditional_read_rules = '[]'::jsonb WHERE id = $1", [SHEET])
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    for (const id of [A, B, C]) await seedRecord(id)
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) all-permitted → applies ALL atomically (every row restored, versions bumped, restoredCount=N, skipped=0)', async () => {
    const { token } = await freshIdentity([A, B, C])
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token, { allOrNothing: true })
    expect(res.status).toBe(200)
    expect(res.body?.data?.restoredCount).toBe(3)
    expect(res.body?.data?.skippedCount).toBe(0)
    for (const id of [A, B, C]) {
      const row = await recordRow(id)
      expect(row?.data?.[NAME]).toBe('a') // restored to v1
      expect(row?.data?.[SALARY]).toBe(100)
      expect(row?.version).toBe(3) // FORWARD revision (v2 → v3)
    }
    // every record marked restored (no skipped outcome in all-or-nothing success)
    const byId = Object.fromEntries((res.body?.data?.records ?? []).map((r: { recordId: string }) => [r.recordId, r]))
    for (const id of [A, B, C]) expect(byId[id].status).toBe('restored')
  })

  test('(b) one row-DENIED → 409 BATCH_RESTORE_BLOCKED, NOTHING written (every version unchanged at v2)', async () => {
    // give C a distinct value BEFORE preview so a rule can deny ONLY C (A,B keep NAME='b')
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [C, JSON.stringify({ [NAME]: 'c_marker', [SALARY]: 200 })])
    const { token } = await freshIdentity([A, B, C]) // minted while none denied (all in scope, same scopeHash)
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $2::jsonb WHERE id = $1", [SHEET, JSON.stringify([{ id: 'r1', fieldId: NAME, operator: 'eq', value: 'c_marker', effect: 'deny_read' }])])
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token, { allOrNothing: true })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('BATCH_RESTORE_BLOCKED')
    // the blocker list names C with reason denied (and ONLY C)
    const blockers = (res.body?.error?.blockers ?? []) as Array<{ recordId: string; reason: string }>
    expect(blockers).toEqual([{ recordId: C, reason: 'denied' }])
    // ATOMIC: NOTHING written — A and B (which WOULD have been permitted) are still at v2, unchanged
    for (const id of [A, B]) {
      const row = await recordRow(id)
      expect(row?.version).toBe(2)
      expect(row?.data?.[NAME]).toBe('b') // not rewound to v1
    }
    expect((await recordRow(C))?.version).toBe(2)
    // and zero forward 'restore' revisions were appended
    const restoreRevs = await q(`SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])
    expect((restoreRevs.rows[0] as { n: number }).n).toBe(0)
  })

  test('(c) TRANSACTION ROLLBACK keystone: one CONFLICT (version moved since preview) → 409, NOTHING written (A NOT partially applied)', async () => {
    // This is the dangerous-slice test: the write phase STARTS (preflight passes — no deny/forbidden), then the
    // in-transaction CAS throws on B's moved version. Only a true single-transaction write rolls A back; a
    // best-effort fan-out would have already written A. We assert A is UNCHANGED → proves atomic rollback.
    const { token } = await freshIdentity([A, B, C]) // preview binds B at version 2
    // B edited THEN reverted: data identical to preview (diff unchanged → scopeHash still matches) but version moved
    await q('UPDATE meta_records SET data = $2::jsonb, version = 3 WHERE id = $1', [B, JSON.stringify({ [NAME]: 'x', [SALARY]: 1 })])
    await q('UPDATE meta_records SET data = $2::jsonb, version = 4 WHERE id = $1', [B, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })]) // reverted
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token, { allOrNothing: true }) // B expected v2, now at v4
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('BATCH_RESTORE_BLOCKED')
    const blockers = (res.body?.error?.blockers ?? []) as Array<{ recordId: string; reason: string }>
    expect(blockers).toEqual([{ recordId: B, reason: 'conflict' }]) // the CAS named B
    // ATOMIC ROLLBACK: A and C were NOT written — A is still v2 with its CURRENT value (never rewound to v1)
    expect((await recordRow(A))?.version).toBe(2)
    expect((await recordRow(A))?.data?.[NAME]).toBe('b')
    expect((await recordRow(C))?.version).toBe(2)
    expect((await recordRow(C))?.data?.[NAME]).toBe('b')
    expect((await recordRow(B))?.data?.[NAME]).toBe('b') // B untouched
    // zero forward 'restore' revisions (the whole transaction rolled back)
    const restoreRevs = await q(`SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])
    expect((restoreRevs.rows[0] as { n: number }).n).toBe(0)
  })

  test('(d) BACK-COMPAT: default (no flag) is still PARTIAL — one conflict skips, the others apply', async () => {
    const { token } = await freshIdentity([A, B, C])
    // B edited THEN reverted: data identical (diff unchanged → scopeHash matches) but version moved → CAS skips B only
    await q('UPDATE meta_records SET data = $2::jsonb, version = 3 WHERE id = $1', [B, JSON.stringify({ [NAME]: 'x', [SALARY]: 1 })])
    await q('UPDATE meta_records SET data = $2::jsonb, version = 4 WHERE id = $1', [B, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token) // NO allOrNothing → default false
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body?.data?.records ?? []).map((r: { recordId: string }) => [r.recordId, r]))
    expect(byId[A].status).toBe('restored')
    expect(byId[C].status).toBe('restored')
    expect(byId[B].status).toBe('skipped')
    expect(byId[B].skipReason).toBe('conflict')
    expect(res.body?.data?.restoredCount).toBe(2)
    expect(res.body?.data?.skippedCount).toBe(1)
    // the survivors A,C WERE written to v1; B left at its current value (partial = skip-and-apply-rest)
    expect((await recordRow(A))?.data?.[NAME]).toBe('a')
    expect((await recordRow(C))?.data?.[NAME]).toBe('a')
    expect((await recordRow(B))?.data?.[NAME]).toBe('b')
  })

  test('(e) explicit allOrNothing:false is identical to default PARTIAL (the flag is genuinely opt-in)', async () => {
    const { token } = await freshIdentity([A, B, C])
    await q('UPDATE meta_records SET data = $2::jsonb, version = 4 WHERE id = $1', [B, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })]) // B version moved
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token, { allOrNothing: false })
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body?.data?.records ?? []).map((r: { recordId: string }) => [r.recordId, r]))
    expect(byId[B].skipReason).toBe('conflict')
    expect(res.body?.data?.restoredCount).toBe(2) // A,C applied; B skipped
  })

  test('(f) one FORBIDDEN field (layer-3 read_only) → 409 BATCH_RESTORE_BLOCKED reason=forbidden, NOTHING written', async () => {
    // Pins the THIRD blocker reason distinctly from denied (b) and conflict (c): the in-route `recordIsForbidden`
    // preflight (a field hidden / definition-readOnly / layer-3 readOnly|invisible in the restore diff). Mint clean,
    // then make SALARY layer-3 read-only AFTER preview — the restore diff touches SALARY (data-based, so the scopeHash
    // still matches → identity valid), so the block can only come from the forbidden preflight, before any write.
    const { token } = await freshIdentity([A, B, C])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET, SALARY, 'user', ACTOR, true, true])
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token, { allOrNothing: true })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('BATCH_RESTORE_BLOCKED')
    const blockers = (res.body?.error?.blockers ?? []) as Array<{ recordId: string; reason: string }>
    expect(blockers.length).toBeGreaterThanOrEqual(1)
    expect(blockers.every((b) => b.reason === 'forbidden')).toBe(true) // the forbidden preflight reason, not denied/conflict
    // ATOMIC: NOTHING written — all unchanged at v2, zero forward 'restore' revisions
    for (const id of [A, B, C]) { const r = await recordRow(id); expect(r?.version).toBe(2); expect(r?.data?.[NAME]).toBe('b') }
    const restoreRevs = await q(`SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])
    expect((restoreRevs.rows[0] as { n: number }).n).toBe(0)
  })
})
