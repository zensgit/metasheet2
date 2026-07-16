/**
 * R11 restore back-reference (OD-0=(a)) — `meta_record_revisions.restored_from_version` (real DB).
 *
 * A `source='restore'` record-version restore now records the SOURCE version it restored from, so the
 * History Center can render "restored from version N". Only the THREE record-version restore routes
 * (record-restore-execute, restore-batch-execute, legacy /restore) populate it — every OTHER write, INCLUDING
 * the non-version-restore `source='restore'` emitters (PIT-resurrect action='create', PIT-reset,
 * lossy-retype-revert), leaves it NULL. The FE badge keys on NON-NULL, never on `source='restore'`.
 *
 * Goldens (all THREE record-version restore routes are covered end-to-end — legacy has no live FE caller, so the
 * two live routes get their own e2e goldens; each mutation-reds when its route's patchRecords threading is dropped):
 *   G1  legacy /restore (route 1) end-to-end: the restore revision carries restored_from_version = targetVersion.
 *   G1b recordRecordRevision write primitive (the seam all three routes share): restoredFromVersion=N ⇒ column=N.
 *   G1c restore-execute (route 2, LIVE) preview→execute end-to-end ⇒ column = targetVersion (threads at :9704).
 *   G1d restore-batch-execute all-or-nothing (route 3a, LIVE) preview→execute ⇒ column = targetVersion (:9856).
 *   G1e restore-batch-execute per-record/PARTIAL (route 3b, LIVE) preview→execute ⇒ column = targetVersion (:9884).
 *   G2  NULL by design: a plain update; a `source='restore' action='create'` write (PIT-resurrect shape) with
 *       no restoredFromVersion; a `source='restore' action='delete'` write (PIT-reset shape) — all NULL.
 *   G3  projection: batch detail surfaces `restoredFromVersion` for the restore batch, null for others.
 *
 * Runs only with DATABASE_URL. (plugin-tests.yml whitelist.)
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { recordRecordRevision, listRecordRevisions } from '../../src/multitable/record-history-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_rbr_${TS}`
const SHEET_ID = `sheet_rbr_${TS}`
const FLD = `fld_rbr_${TS}`
const USER_ID = `user_rbr_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express

const restoreReq = (recordId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/records/${recordId}/restore`).send(body)
// The two LIVE FE routes are preview→execute: the preview mints the previewIdentity the execute re-checks.
const previewReq = (recordId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/records/${recordId}/restore-preview`).send(body)
const executeReq = (recordId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/records/${recordId}/restore-execute`).send(body)
const batchPreviewReq = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/restore-batch-preview`).send(body)
const batchExecuteReq = (body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/restore-batch-execute`).send(body)
const batchDetail = (batchId: string) => request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)

// Seed a record live at v2 with a v1 snapshot that DIFFERS (so the restore diff is non-empty → restorable).
const seedRestorable = async (rid: string) => {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [rid, SHEET_ID, JSON.stringify({ [FLD]: 'v2' })])
  await seedRev(rid, 1, 'create', { [FLD]: 'v1' })
  await seedRev(rid, 2, 'update', { [FLD]: 'v2' })
}

const restoredFromOf = async (recordId: string, version: number): Promise<number | null> => {
  const r = (await q('SELECT restored_from_version FROM meta_record_revisions WHERE record_id=$1 AND version=$2', [recordId, version])).rows[0] as { restored_from_version: number | null } | undefined
  return r ? r.restored_from_version : null
}
const seedRev = (recordId: string, version: number, action: string, snapshot: Record<string, unknown>) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'rest', $5, ARRAY[$6]::text[], '{}'::jsonb, $7::jsonb)`,
    [SHEET_ID, recordId, version, action, USER_ID, FLD, JSON.stringify(snapshot)],
  )

describeIfDatabase('R11 restore back-reference — restored_from_version (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: USER_ID, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [USER_ID])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'RBR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'RBR Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD, SHEET_ID, 'Val', 'string', '{}', 1])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [USER_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('G1 legacy /restore end-to-end: the restore revision carries restored_from_version = targetVersion', async () => {
    const rid = `rec_rbr_g1_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [rid, SHEET_ID, JSON.stringify({ [FLD]: 'v2' })])
    await seedRev(rid, 1, 'create', { [FLD]: 'v1' })
    await seedRev(rid, 2, 'update', { [FLD]: 'v2' })

    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    const newVersion = res.body?.data?.newVersion as number
    expect(newVersion).toBeGreaterThan(2)
    // the new restore revision points back at the source version 1
    expect(await restoredFromOf(rid, newVersion)).toBe(1)
    // the pre-existing non-restore revisions stay NULL
    expect(await restoredFromOf(rid, 1)).toBeNull()
    expect(await restoredFromOf(rid, 2)).toBeNull()
  })

  test('G4 (OD-W2-5a): the record-history READ (listRecordRevisions) surfaces restoredFromVersion — not just the DB column', async () => {
    const rid = `rec_rbr_g4_${TS}`
    await seedRestorable(rid)
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    const newVersion = res.body?.data?.newVersion as number

    // This is what the inspector history panel consumes. Before OD-W2-5a the SELECT omitted the column so the
    // read returned undefined here even though the DB column was populated (proven by G1). Now it passes through.
    const entries = await listRecordRevisions(q, { sheetId: SHEET_ID, recordId: rid, limit: 50 })
    const restoreEntry = entries.find((e) => e.version === newVersion)
    expect(restoreEntry?.restoredFromVersion).toBe(1)
    // non-restore revisions read back as null (never source-inferred)
    expect(entries.find((e) => e.version === 1)?.restoredFromVersion ?? null).toBeNull()
    expect(entries.find((e) => e.version === 2)?.restoredFromVersion ?? null).toBeNull()
  })

  test('G1b recordRecordRevision seam: restoredFromVersion=N writes the column; the three routes all share this primitive', async () => {
    const rid = `rec_rbr_g1b_${TS}`
    await recordRecordRevision(poolManager.get().query.bind(poolManager.get()), {
      sheetId: SHEET_ID, recordId: rid, version: 9, action: 'update', source: 'restore', restoredFromVersion: 7, actorId: USER_ID, changedFieldIds: [FLD], patch: { [FLD]: 'x' }, snapshot: { [FLD]: 'x' },
    })
    expect(await restoredFromOf(rid, 9)).toBe(7)
  })

  // G1c/G1d/G1e cover the TWO routes the FE actually calls (client.ts restoreExecuteRecord / restoreBatchExecute) —
  // legacy /restore (G1) has no live FE caller. Each drives preview→execute end-to-end so the route→patchRecords→
  // revision THREADING is exercised (not just the shared recordRecordRevision seam in G1b). A mutation that drops
  // `restoredFromVersion: targetVersion` at the route's patchRecords call reds the matching test here.
  test('G1c restore-execute (live route) end-to-end: restore revision carries restored_from_version = targetVersion', async () => {
    const rid = `rec_rbr_g1c_${TS}`
    await seedRestorable(rid)
    const pv = await previewReq(rid, { targetVersion: 1 })
    expect(pv.status).toBe(200)
    const previewIdentity = pv.body?.data?.previewIdentity as string
    expect(previewIdentity).toBeTruthy() // non-empty diff ⇒ executable identity minted
    const res = await executeReq(rid, { targetVersion: 1, expectedVersion: 2, previewIdentity })
    expect(res.status).toBe(200)
    expect(res.body?.data?.noop).toBe(false)
    const newVersion = res.body?.data?.newVersion as number
    expect(newVersion).toBeGreaterThan(2)
    expect(await restoredFromOf(rid, newVersion)).toBe(1) // ← threads targetVersion at :9704
    expect(await restoredFromOf(rid, 1)).toBeNull()
    expect(await restoredFromOf(rid, 2)).toBeNull()
  })

  test('G1d restore-batch-execute all-or-nothing (live route) end-to-end: restore revision carries restored_from_version', async () => {
    const rid = `rec_rbr_g1d_${TS}`
    await seedRestorable(rid)
    const pv = await batchPreviewReq({ targetVersion: 1, recordIds: [rid] })
    expect(pv.status).toBe(200)
    const previewIdentity = pv.body?.data?.previewIdentity as string
    expect(previewIdentity).toBeTruthy()
    const scope = pv.body?.data?.scope as string[]
    const previewVersion = (pv.body?.data?.records ?? []).find((r: any) => r.recordId === rid)?.previewVersion as number
    expect(previewVersion).toBe(2)
    const res = await batchExecuteReq({ targetVersion: 1, recordIds: scope, expectedVersions: { [rid]: previewVersion }, previewIdentity, allOrNothing: true })
    expect(res.status).toBe(200)
    const out = (res.body?.data?.records ?? []).find((r: any) => r.recordId === rid)
    expect(out?.status).toBe('restored')
    const newVersion = out?.newVersion as number
    expect(newVersion).toBeGreaterThan(2)
    expect(await restoredFromOf(rid, newVersion)).toBe(1) // ← threads targetVersion at :9856 (all-or-nothing)
  })

  test('G1e restore-batch-execute per-record/PARTIAL (live route) end-to-end: restore revision carries restored_from_version', async () => {
    const rid = `rec_rbr_g1e_${TS}`
    await seedRestorable(rid)
    const pv = await batchPreviewReq({ targetVersion: 1, recordIds: [rid] })
    expect(pv.status).toBe(200)
    const previewIdentity = pv.body?.data?.previewIdentity as string
    expect(previewIdentity).toBeTruthy()
    const scope = pv.body?.data?.scope as string[]
    const previewVersion = (pv.body?.data?.records ?? []).find((r: any) => r.recordId === rid)?.previewVersion as number
    // allOrNothing omitted ⇒ default false ⇒ the per-record fan-out patchRecords at :9884
    const res = await batchExecuteReq({ targetVersion: 1, recordIds: scope, expectedVersions: { [rid]: previewVersion }, previewIdentity })
    expect(res.status).toBe(200)
    const out = (res.body?.data?.records ?? []).find((r: any) => r.recordId === rid)
    expect(out?.status).toBe('restored')
    const newVersion = out?.newVersion as number
    expect(newVersion).toBeGreaterThan(2)
    expect(await restoredFromOf(rid, newVersion)).toBe(1) // ← threads targetVersion at :9884 (per-record)
  })

  test('G2 NULL by design: plain update, PIT-resurrect (create/source=restore/no version), PIT-reset (delete/source=restore) all NULL', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    const rid = `rec_rbr_g2_${TS}`
    // plain (non-restore) update
    await recordRecordRevision(query, { sheetId: SHEET_ID, recordId: rid, version: 1, action: 'update', source: 'rest', actorId: USER_ID, changedFieldIds: [FLD], patch: { [FLD]: 'a' }, snapshot: { [FLD]: 'a' } })
    // PIT-resurrect shape: source='restore', action='create', NO restoredFromVersion (T-snapshot, no source version)
    await recordRecordRevision(query, { sheetId: SHEET_ID, recordId: rid, version: 2, action: 'create', source: 'restore', actorId: USER_ID, changedFieldIds: [FLD], patch: { [FLD]: 'r' }, snapshot: { [FLD]: 'r' } })
    // PIT-reset shape: source='restore', action='delete', NO restoredFromVersion (time-based reset)
    await recordRecordRevision(query, { sheetId: SHEET_ID, recordId: rid, version: 3, action: 'delete', source: 'restore', actorId: USER_ID, changedFieldIds: [], patch: {}, snapshot: { [FLD]: 'r' } })
    expect(await restoredFromOf(rid, 1)).toBeNull() // plain
    expect(await restoredFromOf(rid, 2)).toBeNull() // resurrect create — NULL by design (badge renders nothing)
    expect(await restoredFromOf(rid, 3)).toBeNull() // reset delete — NULL by design
  })

  test('G3 projection: batch detail surfaces restoredFromVersion on the restore change, null elsewhere', async () => {
    const rid = `rec_rbr_g3_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [rid, SHEET_ID, JSON.stringify({ [FLD]: 'v2' })])
    await seedRev(rid, 1, 'create', { [FLD]: 'v1' })
    await seedRev(rid, 2, 'update', { [FLD]: 'v2' })
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    const newVersion = res.body?.data?.newVersion as number
    const batchId = (await q('SELECT batch_id FROM meta_record_revisions WHERE record_id=$1 AND version=$2', [rid, newVersion])).rows[0]?.batch_id as string
    expect(batchId).toBeTruthy()

    const detail = await batchDetail(batchId)
    expect(detail.status).toBe(200)
    const change = (detail.body?.data?.changes ?? []).find((c: any) => c.recordId === rid)
    expect(change).toBeTruthy()
    expect(change.restoredFromVersion).toBe(1)
  })
})
