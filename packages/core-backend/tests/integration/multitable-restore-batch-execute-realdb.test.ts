/**
 * Global History — BS-3: SCOPED (multi-record) restore batch-execute, the WRITE (real DB). Consumes the BS-1
 * scoped identity + BS-2 preview. Two-layer rejection (diff-level → whole-batch 409 re-preview; write-level →
 * PARTIAL skip+report). verify-before-any-2xx incl all-noop. Forward-only, source='restore'. PARTIAL only.
 *
 * Goldens: real preview→execute happy path (forward revisions, all rows written) · [P2] forged token over an
 * all-noop set → 4xx not 200 · diff-level data-changed → whole-batch 409, nothing written · write-level conflict
 * (edited-then-reverted = hash passes, CAS skips — the subtle case) → PARTIAL · write-level denied → PARTIAL ·
 * BS-7 keystone (execute a SUBSET of the token's scope → 409) · D6 (single-record token → 409) · actor binding ·
 * bounded. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_be_${TS}`
const SHEET = `sheet_be_${TS}`
const NAME = `fld_be_name_${TS}`
const SALARY = `fld_be_salary_${TS}`
const A = `rec_be_a_${TS}`
const B = `rec_be_b_${TS}`
const C = `rec_be_c_${TS}`
const ACTOR = `user_be_${TS}`
const OTHER = `user_be_other_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curUser = ACTOR
let curRoles = ['member']
const batchPreview = (recordIds: string[], body: Record<string, unknown> = {}) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/restore-batch-preview`).send({ targetVersion: 1, recordIds, ...body })
const batchExecute = (recordIds: string[], expectedVersions: Record<string, number>, previewIdentity: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/restore-batch-execute`).send({ targetVersion: 1, recordIds, expectedVersions, previewIdentity, ...body })
const singlePreview = (recordId: string) => request(app).post(`/api/multitable/sheets/${SHEET}/records/${recordId}/restore-preview`).send({ targetVersion: 1 })
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

describeIfDatabase('multitable scoped restore batch-execute — BS-3 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: curUser, roles: curRoles, perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'BE Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'BE Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    for (const u of [ACTOR, OTHER]) await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
  })

  afterAll(async () => {
    for (const t of ['field_permissions', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    for (const u of [ACTOR, OTHER]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
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

  test('happy path: a real preview→execute restores EVERY contributing record (forward revisions, all rows written)', async () => {
    const { token } = await freshIdentity([A, B, C])
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token)
    expect(res.status).toBe(200)
    expect(res.body?.data?.restoredCount).toBe(3)
    for (const id of [A, B, C]) {
      const row = await recordRow(id)
      expect(row?.data?.[NAME]).toBe('a') // restored to v1
      expect(row?.data?.[SALARY]).toBe(100)
      expect(row?.version).toBe(3) // FORWARD revision (v2 → v3), never a destructive rewind
    }
    // forward-only: a new 'restore' revision was appended for each record
    const restoreRevs = await q(`SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])
    expect((restoreRevs.rows[0] as { n: number }).n).toBe(3)
  })

  test('per-record ISOLATION: distinct snapshots → each record restores to ITS OWN v1 (no cross-record contamination)', async () => {
    // the shared-fixture goldens would pass even if the code applied ONE record's diff to all three. Distinct v1
    // snapshots make a recordId-mapping / contamination bug visible (the wire-vs-fixture-drift rule, record axis).
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    const seedDistinct = async (id: string, v1name: string, v1salary: number) => {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [id, SHEET, JSON.stringify({ [NAME]: 'current', [SALARY]: 999 })])
      await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at) VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, id, NAME, SALARY, JSON.stringify({ [NAME]: v1name, [SALARY]: v1salary })])
      await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at) VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', ARRAY[$3,$4]::text[], '{}'::jsonb, $5::jsonb, now())`, [SHEET, id, NAME, SALARY, JSON.stringify({ [NAME]: 'current', [SALARY]: 999 })])
    }
    await seedDistinct(A, 'alpha', 100); await seedDistinct(B, 'beta', 200); await seedDistinct(C, 'gamma', 300)
    const { token } = await freshIdentity([A, B, C])
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token)
    expect(res.status).toBe(200)
    expect(res.body?.data?.restoredCount).toBe(3)
    // each record landed on ITS OWN snapshot — not a shared one
    expect((await recordRow(A))?.data).toEqual({ [NAME]: 'alpha', [SALARY]: 100 })
    expect((await recordRow(B))?.data).toEqual({ [NAME]: 'beta', [SALARY]: 200 })
    expect((await recordRow(C))?.data).toEqual({ [NAME]: 'gamma', [SALARY]: 300 })
  })

  test('[P2] verify-before-write: a forged token over an all-noop set 4xxes, never a 200 noop short-circuit', async () => {
    // restore everything first → now all 3 are AT v1 (an execute targeting v1 nets zero for all → contributing empty)
    const { token } = await freshIdentity([A, B, C])
    await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token)
    // a garbage/foreign token over the now all-noop set MUST be rejected at the verify, not 200-noop'd through
    const res = await batchExecute([A, B, C], { [A]: 3, [B]: 3, [C]: 3 }, 'garbage.token.value')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.body?.ok).toBe(false)
  })

  test('diff-level: a record whose restorable diff changed since preview → WHOLE-BATCH 409, nothing written', async () => {
    const { token } = await freshIdentity([A, B, C]) // A's diff at preview = {NAME→a, SALARY→100}
    // A's SALARY edited to the restore TARGET (100) since preview → SALARY no longer needs restoring → A's diff
    // shrinks to {NAME→a} → its per-record changesHash changes → scopeHash diverges (a diff-level change).
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [A, JSON.stringify({ [NAME]: 'b', [SALARY]: 100 })])
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token)
    expect(res.status).toBe(409)
    // whole-batch reject: B and C (untouched) were NOT restored — still at v2
    expect((await recordRow(B))?.version).toBe(2)
    expect((await recordRow(C))?.version).toBe(2)
  })

  test('write-level conflict (edited-then-reverted = hash passes, CAS skips): PARTIAL — others restored', async () => {
    const { token } = await freshIdentity([A, B, C])
    // B edited THEN reverted: data identical to preview (diff unchanged → scopeHash still matches) but version moved
    await q('UPDATE meta_records SET data = $2::jsonb, version = 3 WHERE id = $1', [B, JSON.stringify({ [NAME]: 'x', [SALARY]: 1 })])
    await q('UPDATE meta_records SET data = $2::jsonb, version = 4 WHERE id = $1', [B, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })]) // reverted
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token) // B expected v2, now at v4
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body?.data?.records ?? []).map((r: { recordId: string }) => [r.recordId, r]))
    expect(byId[A].status).toBe('restored')
    expect(byId[C].status).toBe('restored')
    expect(byId[B].status).toBe('skipped')
    expect(byId[B].skipReason).toBe('conflict') // the in-transaction CAS caught the moved version
    expect((await recordRow(B))?.data?.[NAME]).toBe('b') // B untouched (still its current value, not rewound)
    // the survivors were actually WRITTEN to v1 (not merely reported 'restored')
    expect((await recordRow(A))?.data?.[NAME]).toBe('a')
    expect((await recordRow(C))?.data?.[NAME]).toBe('a')
  })

  test('write-level denied: ONE record row-denied since preview → PARTIAL skip(denied), the others restored', async () => {
    // give C a distinct value BEFORE preview so a rule can deny ONLY C (A,B keep NAME='b')
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [C, JSON.stringify({ [NAME]: 'c_marker', [SALARY]: 200 })])
    const { token } = await freshIdentity([A, B, C]) // minted while none denied (all in scope)
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $2::jsonb WHERE id = $1", [SHEET, JSON.stringify([{ id: 'r1', fieldId: NAME, operator: 'eq', value: 'c_marker', effect: 'deny_read' }])])
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token)
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body?.data?.records ?? []).map((r: { recordId: string }) => [r.recordId, r]))
    expect(byId[A].status).toBe('restored')
    expect(byId[B].status).toBe('restored')
    expect(byId[C].status).toBe('skipped')
    expect(byId[C].skipReason).toBe('denied') // skipped at the FRESH row-deny gate (the SR-2 fan-out surface)
    expect(res.body?.data?.restoredCount).toBe(2)
    expect((await recordRow(C))?.version).toBe(2) // C never written
    // the survivors A,B were actually WRITTEN to v1 (not merely reported 'restored')
    expect((await recordRow(A))?.data?.[NAME]).toBe('a')
    expect((await recordRow(B))?.data?.[NAME]).toBe('a')
  })

  test('#1 layer-3 write gate: a VISIBLE+readOnly field in a record diff → that record skipped(forbidden), others restored', async () => {
    // SALARY: visible=true, read_only=true for the actor (per-subject layer-3 write-deny — patchRecords does NOT
    // enforce this; only the route can). A is the only record whose diff still touches SALARY.
    await q(`INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,true,true) ON CONFLICT DO NOTHING`, [SHEET, SALARY, ACTOR])
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [B, JSON.stringify({ [NAME]: 'b', [SALARY]: 100 })]) // B,C already at v1 SALARY → only NAME changes (writable)
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [C, JSON.stringify({ [NAME]: 'b', [SALARY]: 100 })])
    const { token } = await freshIdentity([A, B, C]) // SALARY is VISIBLE so it is in A's previewed diff + the scopeHash
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token)
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body?.data?.records ?? []).map((r: { recordId: string }) => [r.recordId, r]))
    expect(byId[A].skipReason).toBe('forbidden') // A's diff hits the readOnly SALARY → WHOLE record skipped
    expect(byId[B].status).toBe('restored')
    expect(byId[C].status).toBe('restored')
    expect((await recordRow(A))?.data?.[SALARY]).toBe(200) // the readOnly field was NOT written
    expect((await recordRow(A))?.data?.[NAME]).toBe('b') // and A is NOT partially restored (whole-record skip)
  })

  test('#2 version-tamper: submitting the CURRENT version (not the preview version) to slip past the CAS → 409, no write', async () => {
    const { token } = await freshIdentity([A, B, C]) // preview binds B at version 2
    // B edited THEN reverted: data identical (diff unchanged → changesHash matches) but version moved to 4.
    await q('UPDATE meta_records SET data = $2::jsonb, version = 3 WHERE id = $1', [B, JSON.stringify({ [NAME]: 'x', [SALARY]: 1 })])
    await q('UPDATE meta_records SET data = $2::jsonb, version = 4 WHERE id = $1', [B, JSON.stringify({ [NAME]: 'b', [SALARY]: 200 })])
    // a tampering client submits B's CURRENT version (4) to make the CAS pass — but the version is FOLDED into the
    // scopeHash, so submitted {B:4} ≠ the bound {B:2} → hash diverges → whole-batch 409 (the bypass is closed).
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 4, [C]: 2 }, token)
    expect(res.status).toBe(409)
    expect((await recordRow(A))?.version).toBe(2) // nothing written
    expect((await recordRow(C))?.version).toBe(2)
  })

  test('BS-7 keystone: executing a SUBSET of the token scope → 409 (the scopeHash binds the exact set)', async () => {
    const { token, scope } = await freshIdentity([A, B, C])
    expect(scope).toEqual([A, B, C].sort())
    const res = await batchExecute([A, B], { [A]: 2, [B]: 2 }, token) // submit fewer than the token authorized
    expect(res.status).toBe(409)
    expect((await recordRow(A))?.version).toBe(2) // nothing written
  })

  test('D6: a single-record preview token cannot drive a batch execute (wrong_type → 409)', async () => {
    const single = (await singlePreview(A)).body?.data?.previewIdentity as string
    expect(single).toBeTruthy()
    const res = await batchExecute([A], { [A]: 2 }, single)
    expect(res.status).toBe(409)
  })

  test('actor binding: a token minted for ACTOR cannot be executed by OTHER (mismatch_actorId → 409)', async () => {
    const { token } = await freshIdentity([A, B, C])
    curUser = OTHER
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2, [C]: 2 }, token)
    expect(res.status).toBe(409)
    curUser = ACTOR
  })

  test('bounded: a scope over the cap is fail-closed (400)', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `rec_of_${i}`)
    const ev: Record<string, number> = {}; for (const id of tooMany) ev[id] = 1
    const res = await batchExecute(tooMany, ev, 'x.y.z')
    expect(res.status).toBe(400)
  })

  test('expectedVersions fail-closed: a missing per-record expectedVersion → 400', async () => {
    const { token } = await freshIdentity([A, B, C])
    const res = await batchExecute([A, B, C], { [A]: 2, [B]: 2 }, token) // C omitted
    expect(res.status).toBe(400)
  })
})
